/**
 * M4Decimator - GPU compute-based M4 decimation for line charts.
 *
 * Manages compute pipelines, buffers, and bind groups for the M4 algorithm.
 * Reads domain bounds from the shared scale SSBO (group 2) — no separate
 * domain uniform needed. Integrates into GPUCoordinator's render loop via
 * registerComputeWork().
 *
 * Usage:
 *   const decimator = new M4Decimator(device, globalScaleLayout);
 *   decimator.configure(numBins, numSeries, xScaleIndex);
 *   // Register with GPUCoordinator:
 *   gpuCoordinator.registerComputeWork(key, (encoder, scaleBG) =>
 *       decimator.encode(encoder, inputBuffers, scaleBG, pointCount));
 *   // For rendering, override bind group in draw callback:
 *   passEncoder.setBindGroup(1, decimator.renderBindGroup);
 *   passEncoder.draw(verticesPerInstance, decimator.outputSize);
 */

import {
	WORKGROUP_SIZE,
	INIT_BINS_SHADER,
	BIN_POINTS_SHADER,
	FIND_MINMAX_SHADER,
	EMIT_OUTPUT_SHADER,
	FILL_FORWARD_SHADER
} from './M4Shader.js';

// M4Bin struct: 6 × u32 atomics = 24 bytes per bin
const M4_BIN_SIZE = 24;
// M4Config: 4 × u32 = 16 bytes
const M4_CONFIG_SIZE = 16;

export class M4Decimator {
	#device;

	// Compute pipelines (one per kernel)
	#initBinsPipeline = null;
	#binPointsPipeline = null;
	#findMinMaxPipeline = null;
	#emitOutputPipeline = null;
	#fillForwardPipeline = null;

	// Bind group layouts
	#inputLayout = null; // group 0: input data + config + bins (6 bindings, for passes 0-2)
	#emitInputLayout = null; // group 0: reduced layout for emitOutput (no seriesValues, stays within 8 storage buffer limit)
	#outputLayout = null; // group 1: output arrays
	#fillLayout = null; // group 0: config + output arrays (for fill-forward pass)

	// Buffers
	#configBuffer = null; // M4Config uniform (16 bytes)
	#binBuffer = null; // M4Bin array (numBins * numSeries * 24 bytes)
	#outputBuffers = {
		x: null,
		y: null,
		series: null,
		color: null
	};

	// Bind groups
	#inputBindGroups = new Map(); // kernel name -> bind group (differ per kernel due to binding usage)
	#outputBindGroup = null;
	#fillBindGroup = null; // fill-forward pass bind group
	#emptyBindGroup = null; // Empty bind group for unused pipeline layout slots

	// Reactive configuration — Lines.svelte effects track these via getters
	#numBins = $state(0);
	#numSeries = $state(0);
	#configured = $state(false);

	// Non-reactive internal state
	#xScaleIndex = 0;
	#pointCount = 0;

	// CPU-side config buffer for updates
	#configData = new Uint32Array(4);

	constructor(device, globalScaleLayout) {
		this.#device = device;
		this.#createLayouts(globalScaleLayout);
		this.#createPipelines(globalScaleLayout);
		this.#createConfigBuffer();
	}

	get outputSize() {
		return 4 * this.#numBins * this.#numSeries;
	}

	get configured() {
		return this.#configured;
	}

	/**
	 * Configure dimensions and allocate buffers.
	 * Call when chart width, series count, or scale index changes.
	 * Only reallocates GPU buffers when dimensions change (not for xScaleIndex-only changes).
	 */
	configure(numBins, numSeries, xScaleIndex) {
		// +2 boundary bins: bin 0 (left) and bin N-1 (right) capture off-screen
		// points for line connectivity at viewport edges.
		const internalBins = numBins + 2;
		const dimsChanged = internalBins !== this.#numBins || numSeries !== this.#numSeries;
		const scaleChanged = xScaleIndex !== this.#xScaleIndex;

		if (!dimsChanged && !scaleChanged) return;

		this.#xScaleIndex = xScaleIndex;

		if (dimsChanged) {
			this.#numBins = internalBins;
			this.#numSeries = numSeries;

			const totalBins = internalBins * numSeries;
			const outputCount = totalBins * 4;

			// Reallocate bin buffer
			this.#binBuffer?.destroy();
			this.#binBuffer = this.#device.createBuffer({
				size: Math.max(totalBins * M4_BIN_SIZE, 16),
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				label: 'm4-bins'
			});

			// Reallocate output buffers
			const outputByteSize = Math.max(outputCount * 4, 16);
			for (const key of ['x', 'y', 'series', 'color']) {
				this.#outputBuffers[key]?.destroy();
				this.#outputBuffers[key] = this.#device.createBuffer({
					size: outputByteSize,
					usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
					label: `m4-output-${key}`
				});
			}

			// Rebuild output bind group (used by emit pass)
			this.#outputBindGroup = this.#device.createBindGroup({
				label: 'm4-output-bind-group',
				layout: this.#outputLayout,
				entries: [
					{ binding: 0, resource: { buffer: this.#outputBuffers.x } },
					{ binding: 1, resource: { buffer: this.#outputBuffers.y } },
					{ binding: 2, resource: { buffer: this.#outputBuffers.series } },
					{ binding: 3, resource: { buffer: this.#outputBuffers.color } }
				]
			});

			// Rebuild fill-forward bind group (config + output arrays)
			this.#fillBindGroup = this.#device.createBindGroup({
				label: 'm4-fill-bind-group',
				layout: this.#fillLayout,
				entries: [
					{ binding: 0, resource: { buffer: this.#configBuffer } },
					{ binding: 1, resource: { buffer: this.#outputBuffers.x } },
					{ binding: 2, resource: { buffer: this.#outputBuffers.y } },
					{ binding: 3, resource: { buffer: this.#outputBuffers.series } },
					{ binding: 4, resource: { buffer: this.#outputBuffers.color } }
				]
			});

			// Clear stale input bind groups (will be rebuilt on next encode)
			this.#inputBindGroups.clear();
		}

		// Always update config uniform (covers both dimension and scale index changes)
		this.#updateConfig(this.#pointCount);
		this.#configured = true;
	}

	/**
	 * Encode M4 compute passes into the provided command encoder.
	 * Called by GPUCoordinator's registerComputeWork callback.
	 *
	 * @param {GPUCommandEncoder} commandEncoder
	 * @param {Object} inputBuffers - { x: GPUBuffer, y: GPUBuffer, series: GPUBuffer, color: GPUBuffer }
	 * @param {GPUBindGroup} scaleBindGroup - Current frame's group(2) scale bind group
	 * @param {number} pointCount - Total number of data points
	 */
	encode(commandEncoder, inputBuffers, scaleBindGroup, pointCount) {
		if (!this.#configured || this.#numBins === 0 || pointCount === 0) return;

		// Update config if pointCount changed
		if (pointCount !== this.#pointCount) {
			this.#pointCount = pointCount;
			this.#updateConfig(pointCount);
		}

		// Rebuild input bind groups if needed (new input buffers)
		this.#ensureInputBindGroups(inputBuffers);

		const totalBins = this.#numBins * this.#numSeries;
		const pointWorkgroups = Math.ceil(pointCount / WORKGROUP_SIZE);
		const binWorkgroups = Math.ceil(totalBins / WORKGROUP_SIZE);

		// Pass 0: Initialize bins
		const initPass = commandEncoder.beginComputePass({ label: 'm4-init-bins' });
		initPass.setPipeline(this.#initBinsPipeline);
		initPass.setBindGroup(0, this.#inputBindGroups.get('initBins'));
		initPass.dispatchWorkgroups(binWorkgroups);
		initPass.end();

		// Pass 1: Bin points
		const binPass = commandEncoder.beginComputePass({ label: 'm4-bin-points' });
		binPass.setPipeline(this.#binPointsPipeline);
		binPass.setBindGroup(0, this.#inputBindGroups.get('binPoints'));
		binPass.setBindGroup(1, this.#emptyBindGroup);
		binPass.setBindGroup(2, scaleBindGroup);
		binPass.dispatchWorkgroups(pointWorkgroups);
		binPass.end();

		// Pass 2: Find min/max indices
		const findPass = commandEncoder.beginComputePass({ label: 'm4-find-minmax' });
		findPass.setPipeline(this.#findMinMaxPipeline);
		findPass.setBindGroup(0, this.#inputBindGroups.get('findMinMax'));
		findPass.setBindGroup(1, this.#emptyBindGroup);
		findPass.setBindGroup(2, scaleBindGroup);
		findPass.dispatchWorkgroups(pointWorkgroups);
		findPass.end();

		// Pass 3: Emit output
		const emitPass = commandEncoder.beginComputePass({ label: 'm4-emit-output' });
		emitPass.setPipeline(this.#emitOutputPipeline);
		emitPass.setBindGroup(0, this.#inputBindGroups.get('emitOutput'));
		emitPass.setBindGroup(1, this.#outputBindGroup);
		emitPass.dispatchWorkgroups(binWorkgroups);
		emitPass.end();

		// Pass 4: Fill-forward (bridge NaN gaps from empty bins)
		const fillPass = commandEncoder.beginComputePass({ label: 'm4-fill-forward' });
		fillPass.setPipeline(this.#fillForwardPipeline);
		fillPass.setBindGroup(0, this.#fillBindGroup);
		fillPass.dispatchWorkgroups(this.#numSeries);
		fillPass.end();
	}

	/**
	 * Create a bind group compatible with the render pipeline's group(1) layout.
	 * Uses M4 output buffers for data slots (0-3) and the renderer's
	 * markConstants buffer for slot 4.
	 */
	createRenderBindGroup(perDataLayout, markConstantsBuffer) {
		this.renderBindGroup = this.#device.createBindGroup({
			label: 'm4-render-bind-group',
			layout: perDataLayout,
			entries: [
				{ binding: 0, resource: { buffer: this.#outputBuffers.x } },
				{ binding: 1, resource: { buffer: this.#outputBuffers.y } },
				{ binding: 2, resource: { buffer: this.#outputBuffers.series } },
				{ binding: 3, resource: { buffer: this.#outputBuffers.color } },
				{ binding: 4, resource: { buffer: markConstantsBuffer } }
			]
		});
	}

	// Reactive — tracked by Lines.svelte drawLines callback
	renderBindGroup = $state(null);

	destroy() {
		this.#configBuffer?.destroy();
		this.#configBuffer = null;
		this.#binBuffer?.destroy();
		this.#binBuffer = null;
		for (const key of ['x', 'y', 'series', 'color']) {
			this.#outputBuffers[key]?.destroy();
			this.#outputBuffers[key] = null;
		}
		this.#dummyBuffer?.destroy();
		this.#dummyBuffer = null;
		this.#configured = false;
	}

	// =========================================================================
	// PRIVATE
	// =========================================================================

	#createConfigBuffer() {
		this.#configBuffer = this.#device.createBuffer({
			size: M4_CONFIG_SIZE,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			label: 'm4-config'
		});
	}

	#updateConfig(pointCount) {
		this.#configData[0] = pointCount;
		this.#configData[1] = this.#numBins;
		this.#configData[2] = this.#numSeries;
		this.#configData[3] = this.#xScaleIndex;
		this.#device.queue.writeBuffer(this.#configBuffer, 0, this.#configData);
	}

	#createLayouts(globalScaleLayout) {
		// Group 0: Input data + config + bins
		// Different kernels use different subsets but all share this layout
		this.#inputLayout = this.#device.createBindGroupLayout({
			label: 'm4-input-layout',
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: 'read-only-storage' }
				}, // xValues
				{
					binding: 1,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: 'read-only-storage' }
				}, // yValues
				{
					binding: 2,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: 'read-only-storage' }
				}, // seriesValues
				{
					binding: 3,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: 'read-only-storage' }
				}, // colorValues
				{
					binding: 4,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: 'uniform' }
				}, // config
				{
					binding: 5,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: 'storage' }
				} // bins
			]
		});

		// Group 0 for emitOutput: x, y, color, config, bins (no seriesValues)
		// Keeps total storage at 8 (4 input + 4 output) within WebGPU default limit
		this.#emitInputLayout = this.#device.createBindGroupLayout({
			label: 'm4-emit-input-layout',
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: 'read-only-storage' }
				}, // xValues
				{
					binding: 1,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: 'read-only-storage' }
				}, // yValues
				{
					binding: 2,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: 'read-only-storage' }
				}, // colorValues
				{
					binding: 3,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: 'uniform' }
				}, // config
				{
					binding: 4,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: 'storage' }
				} // bins
			]
		});

		// Group 1: Output arrays (used by emitOutput kernel)
		this.#outputLayout = this.#device.createBindGroupLayout({
			label: 'm4-output-layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
			]
		});

		// Group 0 for fillForward: config + output arrays (read-write)
		this.#fillLayout = this.#device.createBindGroupLayout({
			label: 'm4-fill-layout',
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: 'uniform' }
				}, // config
				{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, // xOut
				{ binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, // yOut
				{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }, // seriesOut
				{ binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } } // colorOut
			]
		});
	}

	#createPipelines(globalScaleLayout) {
		// Empty bind group layout + bind group for unused group slots in pipeline layouts
		const emptyLayout = this.#device.createBindGroupLayout({
			label: 'm4-empty-layout',
			entries: []
		});
		this.#emptyBindGroup = this.#device.createBindGroup({
			label: 'm4-empty-bind-group',
			layout: emptyLayout,
			entries: []
		});

		// Kernels that only use config + bins (no data, no scale, no output)
		const initBinsLayout = this.#device.createPipelineLayout({
			label: 'm4-init-bins-layout',
			bindGroupLayouts: [this.#inputLayout]
		});

		// Kernels that use input data + config + bins + scale SSBO (group 0 + group 2)
		const dataScaleLayout = this.#device.createPipelineLayout({
			label: 'm4-data-scale-layout',
			bindGroupLayouts: [this.#inputLayout, emptyLayout, globalScaleLayout]
		});

		// EmitOutput uses reduced input (no seriesValues) + output arrays (group 0 + group 1)
		// Total storage: 4 (group 0: x, y, color, bins) + 4 (group 1: xOut, yOut, seriesOut, colorOut) = 8
		const emitLayout = this.#device.createPipelineLayout({
			label: 'm4-emit-layout',
			bindGroupLayouts: [this.#emitInputLayout, this.#outputLayout]
		});

		// FillForward: config + output arrays (single group)
		const fillLayout = this.#device.createPipelineLayout({
			label: 'm4-fill-layout',
			bindGroupLayouts: [this.#fillLayout]
		});

		this.#initBinsPipeline = this.#device.createComputePipeline({
			label: 'm4-init-bins',
			layout: initBinsLayout,
			compute: {
				module: this.#device.createShaderModule({ code: INIT_BINS_SHADER }),
				entryPoint: 'main'
			}
		});

		this.#binPointsPipeline = this.#device.createComputePipeline({
			label: 'm4-bin-points',
			layout: dataScaleLayout,
			compute: {
				module: this.#device.createShaderModule({ code: BIN_POINTS_SHADER }),
				entryPoint: 'main'
			}
		});

		this.#findMinMaxPipeline = this.#device.createComputePipeline({
			label: 'm4-find-minmax',
			layout: dataScaleLayout,
			compute: {
				module: this.#device.createShaderModule({ code: FIND_MINMAX_SHADER }),
				entryPoint: 'main'
			}
		});

		this.#emitOutputPipeline = this.#device.createComputePipeline({
			label: 'm4-emit-output',
			layout: emitLayout,
			compute: {
				module: this.#device.createShaderModule({ code: EMIT_OUTPUT_SHADER }),
				entryPoint: 'main'
			}
		});

		this.#fillForwardPipeline = this.#device.createComputePipeline({
			label: 'm4-fill-forward',
			layout: fillLayout,
			compute: {
				module: this.#device.createShaderModule({ code: FILL_FORWARD_SHADER }),
				entryPoint: 'main'
			}
		});
	}

	/**
	 * Create or update input bind groups for each kernel.
	 * Different kernels reference different bindings, but all share
	 * the same layout (unused bindings get a dummy buffer).
	 */
	#ensureInputBindGroups(inputBuffers) {
		// Check if we need to rebuild (buffer references changed)
		if (
			this.#inputBindGroups.size > 0 &&
			this.#lastInputBuffers?.x === inputBuffers.x &&
			this.#lastInputBuffers?.y === inputBuffers.y &&
			this.#lastInputBuffers?.series === inputBuffers.series &&
			this.#lastInputBuffers?.color === inputBuffers.color
		) {
			return;
		}
		this.#lastInputBuffers = { ...inputBuffers };

		const dummyBuffer =
			this.#dummyBuffer ??
			(this.#dummyBuffer = this.#device.createBuffer({
				size: 16,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				label: 'm4-dummy'
			}));

		const makeEntries = (useData) => [
			{ binding: 0, resource: { buffer: useData ? inputBuffers.x : dummyBuffer } },
			{ binding: 1, resource: { buffer: useData ? inputBuffers.y : dummyBuffer } },
			{ binding: 2, resource: { buffer: useData ? inputBuffers.series : dummyBuffer } },
			{ binding: 3, resource: { buffer: useData ? inputBuffers.color : dummyBuffer } },
			{ binding: 4, resource: { buffer: this.#configBuffer } },
			{ binding: 5, resource: { buffer: this.#binBuffer } }
		];

		// initBins only uses config + bins (no data)
		this.#inputBindGroups.set(
			'initBins',
			this.#device.createBindGroup({
				label: 'm4-input-initBins',
				layout: this.#inputLayout,
				entries: makeEntries(false)
			})
		);

		// binPoints, findMinMax use full data + config + bins
		const dataBindGroup = this.#device.createBindGroup({
			label: 'm4-input-data',
			layout: this.#inputLayout,
			entries: makeEntries(true)
		});

		this.#inputBindGroups.set('binPoints', dataBindGroup);
		this.#inputBindGroups.set('findMinMax', dataBindGroup);

		// emitOutput uses reduced layout (no seriesValues, different binding indices)
		// Bindings: 0=x, 1=y, 2=color, 3=config, 4=bins
		this.#inputBindGroups.set(
			'emitOutput',
			this.#device.createBindGroup({
				label: 'm4-input-emit',
				layout: this.#emitInputLayout,
				entries: [
					{ binding: 0, resource: { buffer: inputBuffers.x } },
					{ binding: 1, resource: { buffer: inputBuffers.y } },
					{ binding: 2, resource: { buffer: inputBuffers.color } },
					{ binding: 3, resource: { buffer: this.#configBuffer } },
					{ binding: 4, resource: { buffer: this.#binBuffer } }
				]
			})
		);
	}

	#lastInputBuffers = null;
	#dummyBuffer = null;
}
