/**
 * M4Decimator - GPU compute-based M4 decimation for line charts.
 *
 * Manages compute pipelines, buffers, and bind groups for the M4 algorithm.
 * The GPU decides per-frame whether to decimate or pass through raw data,
 * based on the actual visible point count from the previous frame.
 *
 * The decision flag is stored in an extended indirect buffer (20 bytes:
 * 4 drawIndirect args + 1 decision flag). This merges what was previously
 * a separate DecisionBuffer, saving 1 storage binding per stage.
 *
 * Passthrough is split into two sub-dispatches (XY + series/color) to stay
 * within the 8 storage buffer per-stage limit.
 *
 * Usage:
 *   const decimator = new M4Decimator(device, globalScaleLayout);
 *   decimator.configure(numBins, numSeries, xScaleIndex);
 *   decimator.setVertexCount(quadVertexCount);
 *   gpuCoordinator.registerComputeWork(key, (encoder, scaleBG) =>
 *       decimator.encode(encoder, inputBuffers, scaleBG, pointCount));
 *   passEncoder.setBindGroup(1, decimator.renderBindGroup);
 *   passEncoder.drawIndirect(decimator.indirectBuffer, 0);
 */

import {
	WORKGROUP_SIZE,
	INIT_BINS_SHADER,
	BIN_POINTS_SHADER,
	FIND_MINMAX_SHADER,
	EMIT_OUTPUT_SHADER,
	COMPACT_SHADER,
	PASSTHROUGH_XY_SHADER,
	PASSTHROUGH_SC_SHADER
} from './M4Shader';

interface M4InputBuffers {
	x: GPUBuffer;
	y: GPUBuffer;
	series: GPUBuffer;
	color: GPUBuffer;
}

interface M4OutputBuffers {
	x: GPUBuffer | null;
	y: GPUBuffer | null;
	series: GPUBuffer | null;
	color: GPUBuffer | null;
}

// M4Bin struct: 6 × u32 atomics = 24 bytes per bin
const M4_BIN_SIZE = 24;
// M4Config: 8 × u32 = 32 bytes
const M4_CONFIG_SIZE = 32;
// Control buffer: 5 × u32 = 20 bytes (4 drawIndirect args + shouldDecimate flag)
const CONTROL_BUFFER_SIZE = 20;

/**
 * Test-only: bin by the chart's y scale instead of its x scale.
 *
 * The scale-source parity page's control for M4 — a wrong scale reaching the
 * binning, deliberately, which the comparison must see. Read by LineMark when
 * it configures the decimator, so it takes effect on the next mount. Never set
 * in production.
 */
export const m4Parity = { swapScale: false };

export class M4Decimator {
	#device: GPUDevice;

	// Compute pipelines (one per kernel)
	#initBinsPipeline: GPUComputePipeline | null = null;
	#binPointsPipeline: GPUComputePipeline | null = null;
	#findMinMaxPipeline: GPUComputePipeline | null = null;
	#emitOutputPipeline: GPUComputePipeline | null = null;
	#compactPipeline: GPUComputePipeline | null = null;
	#passthroughXYPipeline: GPUComputePipeline | null = null;
	#passthroughSCPipeline: GPUComputePipeline | null = null;

	// Bind group layouts
	#inputLayout: GPUBindGroupLayout | null = null;
	#emitInputLayout: GPUBindGroupLayout | null = null;
	#outputLayout: GPUBindGroupLayout | null = null;
	#fillLayout: GPUBindGroupLayout | null = null;
	#controlLayout: GPUBindGroupLayout | null = null;
	#passthroughInputLayout: GPUBindGroupLayout | null = null;
	#halfOutputLayout: GPUBindGroupLayout | null = null;

	// Buffers
	#configBuffer: GPUBuffer | null = null;
	#binBuffer: GPUBuffer | null = null;
	#controlBuffer: GPUBuffer | null = null;
	#outputBuffers: M4OutputBuffers = {
		x: null,
		y: null,
		series: null,
		color: null
	};

	// Bind groups
	#inputBindGroups = new Map<string, GPUBindGroup>();
	#outputBindGroup: GPUBindGroup | null = null;
	#fillBindGroup: GPUBindGroup | null = null;
	#controlBindGroup: GPUBindGroup | null = null;
	#pass5aInputBindGroup: GPUBindGroup | null = null;
	#pass5bInputBindGroup: GPUBindGroup | null = null;
	#pass5aOutputBindGroup: GPUBindGroup | null = null;
	#pass5bOutputBindGroup: GPUBindGroup | null = null;

	// Reactive configuration — Lines.svelte effects track these via getters
	#numBins = $state(0);
	#numSeries = $state(0);
	#configured = $state(false);

	// Non-reactive internal state
	#xScaleIndex = 0;
	#resolveXScaleIndex: (() => number) | null = null;
	#pointCount = 0;
	#outputCapacity = 0;

	// CPU-side config buffer for updates (8 × u32 = 32 bytes)
	#configData = new Uint32Array(8);
	#configF32 = new Float32Array(this.#configData.buffer);

	#lastInputBuffers: M4InputBuffers | null = null;
	#dummyBuffer: GPUBuffer | null = null;

	// Stored references for rebuilding renderBindGroup after output buffer reallocation
	#renderBindGroupLayout: GPUBindGroupLayout | null = null;
	#renderMarkConstantsBuffer: GPUBuffer | null = null;

	constructor(device: GPUDevice, globalScaleLayout: GPUBindGroupLayout) {
		this.#device = device;
		this.#createLayouts(globalScaleLayout);
		this.#createPipelines(globalScaleLayout);
		this.#createConfigBuffer();
		this.#createControlBuffers();
	}

	get outputSize(): number {
		return 4 * this.#numBins * this.#numSeries;
	}

	get configured(): boolean {
		return this.#configured;
	}

	get indirectBuffer(): GPUBuffer | null {
		return this.#controlBuffer;
	}

	/**
	 * Set the vertex count for drawIndirect (curve-dependent).
	 * Written to control buffer at byte 0 (vertexCount). Called once after renderer creation.
	 */
	setVertexCount(count: number): void {
		if (!this.#controlBuffer) return;
		const data = new Uint32Array([count]);
		this.#device.queue.writeBuffer(this.#controlBuffer, 0, data);
	}

	/**
	 * Configure dimensions and allocate buffers.
	 * Call when chart width or series count changes.
	 * @param resolveXScaleIndex — called at dispatch time to get the current
	 *   SSBO slot index, so it's always fresh even after ScaleIndexManager rebuilds.
	 */
	configure(numBins: number, numSeries: number, resolveXScaleIndex: () => number): void {
		const internalBins = numBins + 2;
		const dimsChanged = internalBins !== this.#numBins || numSeries !== this.#numSeries;

		this.#resolveXScaleIndex = resolveXScaleIndex;

		if (!dimsChanged) return;

		if (dimsChanged) {
			this.#numBins = internalBins;
			this.#numSeries = numSeries;

			const totalBins = internalBins * numSeries;
			const m4OutputCount = totalBins * 4;
			const outputCount = Math.max(m4OutputCount, this.#pointCount);

			// Reallocate bin buffer
			this.#binBuffer?.destroy();
			this.#binBuffer = this.#device.createBuffer({
				size: Math.max(totalBins * M4_BIN_SIZE, 16),
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				label: 'm4-bins'
			});

			this.#allocateOutputBuffers(outputCount);
			this.#inputBindGroups.clear();
			this.#pass5aInputBindGroup = null;
			this.#pass5bInputBindGroup = null;
		}

		this.#updateConfig(this.#pointCount);
		this.#configured = true;
	}

	/**
	 * Encode M4 compute passes into the provided command encoder.
	 * 7 passes: initBins → binPoints → findMinMax → emitOutput → compact → passthroughXY → passthroughSC
	 */
	encode(
		commandEncoder: GPUCommandEncoder,
		inputBuffers: M4InputBuffers,
		scaleBindGroup: GPUBindGroup,
		pointCount: number
	): void {
		if (!this.#configured || this.#numBins === 0 || pointCount === 0) return;

		// Resolve xScaleIndex fresh each frame — immune to ScaleIndexManager rebuilds
		const freshIndex = this.#resolveXScaleIndex?.() ?? 0;
		const indexChanged = freshIndex !== this.#xScaleIndex;
		if (indexChanged) this.#xScaleIndex = freshIndex;

		if (pointCount !== this.#pointCount || indexChanged) {
			this.#pointCount = pointCount;
			this.#updateConfig(pointCount);
			this.#ensureOutputCapacity(pointCount);
		}

		this.#ensureInputBindGroups(inputBuffers);
		this.#ensurePassthroughBindGroups(inputBuffers);

		const totalBins = this.#numBins * this.#numSeries;
		const pointWorkgroups = Math.ceil(pointCount / WORKGROUP_SIZE);
		const binWorkgroups = Math.ceil(totalBins / WORKGROUP_SIZE);

		// Pass 0: Decision + initialize bins
		const initPass = commandEncoder.beginComputePass({ label: 'm4-init-bins' });
		initPass.setPipeline(this.#initBinsPipeline!);
		initPass.setBindGroup(0, this.#inputBindGroups.get('initBins')!);
		initPass.setBindGroup(1, this.#controlBindGroup!);
		initPass.setBindGroup(2, scaleBindGroup);
		initPass.dispatchWorkgroups(binWorkgroups);
		initPass.end();

		// Pass 1: Count visible points + bin points (if decimating)
		const binPass = commandEncoder.beginComputePass({ label: 'm4-bin-points' });
		binPass.setPipeline(this.#binPointsPipeline!);
		binPass.setBindGroup(0, this.#inputBindGroups.get('binPoints')!);
		binPass.setBindGroup(1, this.#controlBindGroup!);
		binPass.setBindGroup(2, scaleBindGroup);
		binPass.dispatchWorkgroups(pointWorkgroups);
		binPass.end();

		// Pass 2: Find min/max indices (skips in passthrough mode)
		const findPass = commandEncoder.beginComputePass({ label: 'm4-find-minmax' });
		findPass.setPipeline(this.#findMinMaxPipeline!);
		findPass.setBindGroup(0, this.#inputBindGroups.get('findMinMax')!);
		findPass.setBindGroup(1, this.#controlBindGroup!);
		findPass.setBindGroup(2, scaleBindGroup);
		findPass.dispatchWorkgroups(pointWorkgroups);
		findPass.end();

		// Pass 3: Emit output (always runs — harmless in passthrough)
		const emitPass = commandEncoder.beginComputePass({ label: 'm4-emit-output' });
		emitPass.setPipeline(this.#emitOutputPipeline!);
		emitPass.setBindGroup(0, this.#inputBindGroups.get('emitOutput')!);
		emitPass.setBindGroup(1, this.#outputBindGroup!);
		emitPass.dispatchWorkgroups(binWorkgroups);
		emitPass.end();

		// Pass 4: Compact + write indirect instance count (skips in passthrough)
		const compactPass = commandEncoder.beginComputePass({ label: 'm4-compact' });
		compactPass.setPipeline(this.#compactPipeline!);
		compactPass.setBindGroup(0, this.#fillBindGroup!);
		compactPass.setBindGroup(1, this.#controlBindGroup!);
		compactPass.dispatchWorkgroups(this.#numSeries);
		compactPass.end();

		// Pass 5a: Passthrough x,y copy + set indirect count (skips in decimate)
		const ptXYPass = commandEncoder.beginComputePass({ label: 'm4-passthrough-xy' });
		ptXYPass.setPipeline(this.#passthroughXYPipeline!);
		ptXYPass.setBindGroup(0, this.#pass5aInputBindGroup!);
		ptXYPass.setBindGroup(1, this.#pass5aOutputBindGroup!);
		ptXYPass.dispatchWorkgroups(pointWorkgroups);
		ptXYPass.end();

		// Pass 5b: Passthrough series,color copy (skips in decimate)
		const ptSCPass = commandEncoder.beginComputePass({ label: 'm4-passthrough-sc' });
		ptSCPass.setPipeline(this.#passthroughSCPipeline!);
		ptSCPass.setBindGroup(0, this.#pass5bInputBindGroup!);
		ptSCPass.setBindGroup(1, this.#pass5bOutputBindGroup!);
		ptSCPass.dispatchWorkgroups(pointWorkgroups);
		ptSCPass.end();
	}

	/**
	 * Create a bind group compatible with the render pipeline's group(1) layout.
	 * Uses M4 output buffers for data slots (0-3) and the renderer's
	 * markConstants buffer for slot 4.
	 * Stores references so the bind group can be auto-rebuilt after output buffer reallocation.
	 */
	createRenderBindGroup(perDataLayout: GPUBindGroupLayout, markConstantsBuffer: GPUBuffer): void {
		this.#renderBindGroupLayout = perDataLayout;
		this.#renderMarkConstantsBuffer = markConstantsBuffer;
		this.#rebuildRenderBindGroup();
	}

	#rebuildRenderBindGroup(): void {
		if (!this.#renderBindGroupLayout || !this.#renderMarkConstantsBuffer) return;
		if (!this.#outputBuffers.x) return;
		this.renderBindGroup = this.#device.createBindGroup({
			label: 'm4-render-bind-group',
			layout: this.#renderBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: this.#outputBuffers.x! } },
				{ binding: 1, resource: { buffer: this.#outputBuffers.y! } },
				{ binding: 2, resource: { buffer: this.#outputBuffers.series! } },
				{ binding: 3, resource: { buffer: this.#outputBuffers.color! } },
				{ binding: 4, resource: { buffer: this.#renderMarkConstantsBuffer } }
			]
		});
	}

	// Reactive — tracked by Lines.svelte drawLines callback
	renderBindGroup: GPUBindGroup | null = $state(null);

	destroy(): void {
		this.#configBuffer?.destroy();
		this.#configBuffer = null;
		this.#binBuffer?.destroy();
		this.#binBuffer = null;
		this.#controlBuffer?.destroy();
		this.#controlBuffer = null;
		for (const key of ['x', 'y', 'series', 'color'] as const) {
			this.#outputBuffers[key]?.destroy();
			this.#outputBuffers[key] = null;
		}
		this.#dummyBuffer?.destroy();
		this.#dummyBuffer = null;
		this.#renderBindGroupLayout = null;
		this.#renderMarkConstantsBuffer = null;
		this.#configured = false;
	}

	// =========================================================================
	// PRIVATE
	// =========================================================================

	#createConfigBuffer(): void {
		this.#configBuffer = this.#device.createBuffer({
			size: M4_CONFIG_SIZE,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			label: 'm4-config'
		});
	}

	#createControlBuffers(): void {
		// Extended indirect buffer: 4 drawIndirect args + 1 decision flag = 20 bytes
		// drawIndirect reads only the first 16 bytes.
		this.#controlBuffer = this.#device.createBuffer({
			size: CONTROL_BUFFER_SIZE,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT,
			label: 'm4-control'
		});
		// Pre-write zeros: [vertexCount=0, instanceCount=0, firstVertex=0, firstInstance=0, shouldDecimate=0]
		this.#device.queue.writeBuffer(this.#controlBuffer, 0, new Uint32Array(5));

		this.#controlBindGroup = this.#device.createBindGroup({
			label: 'm4-control-bind-group',
			layout: this.#controlLayout!,
			entries: [{ binding: 0, resource: { buffer: this.#controlBuffer } }]
		});
	}

	/**
	 * Set decimation mode. Writes to config.decimationMode field:
	 * 'decimate' (1) → M4 decimation active, 'passthrough' (2) → raw data passthrough.
	 */
	setDecimationMode(decision: 'decimate' | 'passthrough'): void {
		const value = decision === 'decimate' ? 1 : 2;
		if (this.#configData[7] === value) return; // no-op if unchanged
		this.#configData[7] = value;
		if (this.#configBuffer) {
			// Write decimationMode at buffer offset 28 (index 7 * 4 bytes)
			this.#device.queue.writeBuffer(this.#configBuffer, 28, new Uint32Array([value]));
		}
	}

	#updateConfig(pointCount: number): void {
		this.#configData[0] = pointCount;
		this.#configData[1] = this.#numBins;
		this.#configData[2] = this.#numSeries;
		this.#configData[3] = this.#xScaleIndex;
		// Indices 4-6 reserved, index 7 = decimationMode (JS decision) preserved
		this.#device.queue.writeBuffer(
			this.#configBuffer!,
			0,
			this.#configData as Uint32Array<ArrayBuffer>
		);
	}

	#allocateOutputBuffers(outputCount: number): void {
		const outputByteSize = Math.max(outputCount * 4, 16);
		this.#outputCapacity = outputCount;

		for (const key of ['x', 'y', 'series', 'color'] as const) {
			this.#outputBuffers[key]?.destroy();
			this.#outputBuffers[key] = this.#device.createBuffer({
				size: outputByteSize,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				label: `m4-output-${key}`
			});
		}

		this.#outputBindGroup = this.#device.createBindGroup({
			label: 'm4-output-bind-group',
			layout: this.#outputLayout!,
			entries: [
				{ binding: 0, resource: { buffer: this.#outputBuffers.x! } },
				{ binding: 1, resource: { buffer: this.#outputBuffers.y! } },
				{ binding: 2, resource: { buffer: this.#outputBuffers.series! } },
				{ binding: 3, resource: { buffer: this.#outputBuffers.color! } }
			]
		});

		this.#fillBindGroup = this.#device.createBindGroup({
			label: 'm4-fill-bind-group',
			layout: this.#fillLayout!,
			entries: [
				{ binding: 0, resource: { buffer: this.#configBuffer! } },
				{ binding: 1, resource: { buffer: this.#outputBuffers.x! } },
				{ binding: 2, resource: { buffer: this.#outputBuffers.y! } },
				{ binding: 3, resource: { buffer: this.#outputBuffers.series! } },
				{ binding: 4, resource: { buffer: this.#outputBuffers.color! } }
			]
		});

		// Rebuild render bind group with new output buffers (no-op if not yet created)
		this.#rebuildRenderBindGroup();
		this.#pass5aOutputBindGroup = null;
		this.#pass5bOutputBindGroup = null;
		this.#pass5aInputBindGroup = null;
		this.#pass5bInputBindGroup = null;
	}

	/**
	 * Grow output buffers if raw point count exceeds current capacity.
	 * Needed for passthrough mode (raw data → output).
	 */
	#ensureOutputCapacity(pointCount: number): void {
		const needed = Math.max(this.outputSize, pointCount);
		if (needed <= this.#outputCapacity) return;
		this.#allocateOutputBuffers(needed);
		this.#inputBindGroups.clear();
	}

	#createLayouts(globalScaleLayout: GPUBindGroupLayout): void {
		// Group 0 for passes 0, 1, 2 — input data + config + bins
		this.#inputLayout = this.#device.createBindGroupLayout({
			label: 'm4-input-layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
				{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
				{ binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
				{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
				{ binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
				{ binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
			]
		});

		// Group 1 for control (merged indirect+decision)
		this.#controlLayout = this.#device.createBindGroupLayout({
			label: 'm4-control-layout',
			entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }]
		});

		// Group 0 for pass 3 (emit) — x, y, color, config, bins (no decision)
		this.#emitInputLayout = this.#device.createBindGroupLayout({
			label: 'm4-emit-input-layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
				{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
				{ binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
				{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
				{ binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
			]
		});

		// Group 1 for output arrays — pass 3
		this.#outputLayout = this.#device.createBindGroupLayout({
			label: 'm4-output-layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
			]
		});

		// Group 0 for pass 4 (compact) — config + output arrays
		this.#fillLayout = this.#device.createBindGroupLayout({
			label: 'm4-fill-layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
				{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
			]
		});

		// Group 0 for pass 5a/5b (passthrough) — 2 data + config + control
		this.#passthroughInputLayout = this.#device.createBindGroupLayout({
			label: 'm4-passthrough-input-layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
				{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
				{ binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
				{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
			]
		});

		// Group 1 for pass 5a/5b — 2 output channels
		this.#halfOutputLayout = this.#device.createBindGroupLayout({
			label: 'm4-half-output-layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
			]
		});
	}

	#createPipelines(globalScaleLayout: GPUBindGroupLayout): void {
		// Passes 0, 1, 2: [inputLayout, controlLayout, globalScaleLayout]
		const inputControlScaleLayout = this.#device.createPipelineLayout({
			label: 'm4-input-control-scale-layout',
			bindGroupLayouts: [this.#inputLayout!, this.#controlLayout!, globalScaleLayout]
		});

		// Pass 3: [emitInputLayout, outputLayout]
		const emitLayout = this.#device.createPipelineLayout({
			label: 'm4-emit-layout',
			bindGroupLayouts: [this.#emitInputLayout!, this.#outputLayout!]
		});

		// Pass 4: [fillLayout, controlLayout]
		const compactControlLayout = this.#device.createPipelineLayout({
			label: 'm4-compact-control-layout',
			bindGroupLayouts: [this.#fillLayout!, this.#controlLayout!]
		});

		// Passes 5a, 5b: [passthroughInputLayout, halfOutputLayout]
		const passthroughLayout = this.#device.createPipelineLayout({
			label: 'm4-passthrough-layout',
			bindGroupLayouts: [this.#passthroughInputLayout!, this.#halfOutputLayout!]
		});

		this.#initBinsPipeline = this.#device.createComputePipeline({
			label: 'm4-init-bins',
			layout: inputControlScaleLayout,
			compute: {
				module: this.#device.createShaderModule({ code: INIT_BINS_SHADER }),
				entryPoint: 'main'
			}
		});

		this.#binPointsPipeline = this.#device.createComputePipeline({
			label: 'm4-bin-points',
			layout: inputControlScaleLayout,
			compute: {
				module: this.#device.createShaderModule({ code: BIN_POINTS_SHADER }),
				entryPoint: 'main'
			}
		});

		this.#findMinMaxPipeline = this.#device.createComputePipeline({
			label: 'm4-find-minmax',
			layout: inputControlScaleLayout,
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

		this.#compactPipeline = this.#device.createComputePipeline({
			label: 'm4-compact',
			layout: compactControlLayout,
			compute: {
				module: this.#device.createShaderModule({ code: COMPACT_SHADER }),
				entryPoint: 'main'
			}
		});

		this.#passthroughXYPipeline = this.#device.createComputePipeline({
			label: 'm4-passthrough-xy',
			layout: passthroughLayout,
			compute: {
				module: this.#device.createShaderModule({ code: PASSTHROUGH_XY_SHADER }),
				entryPoint: 'main'
			}
		});

		this.#passthroughSCPipeline = this.#device.createComputePipeline({
			label: 'm4-passthrough-sc',
			layout: passthroughLayout,
			compute: {
				module: this.#device.createShaderModule({ code: PASSTHROUGH_SC_SHADER }),
				entryPoint: 'main'
			}
		});
	}

	#ensureInputBindGroups(inputBuffers: M4InputBuffers): void {
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

		const makeEntries = (useData: boolean) => [
			{ binding: 0, resource: { buffer: useData ? inputBuffers.x : dummyBuffer } },
			{ binding: 1, resource: { buffer: useData ? inputBuffers.y : dummyBuffer } },
			{ binding: 2, resource: { buffer: useData ? inputBuffers.series : dummyBuffer } },
			{ binding: 3, resource: { buffer: useData ? inputBuffers.color : dummyBuffer } },
			{ binding: 4, resource: { buffer: this.#configBuffer! } },
			{ binding: 5, resource: { buffer: this.#binBuffer! } }
		];

		this.#inputBindGroups.set(
			'initBins',
			this.#device.createBindGroup({
				label: 'm4-input-initBins',
				layout: this.#inputLayout!,
				entries: makeEntries(false)
			})
		);

		const dataBindGroup = this.#device.createBindGroup({
			label: 'm4-input-data',
			layout: this.#inputLayout!,
			entries: makeEntries(true)
		});

		this.#inputBindGroups.set('binPoints', dataBindGroup);
		this.#inputBindGroups.set('findMinMax', dataBindGroup);

		this.#inputBindGroups.set(
			'emitOutput',
			this.#device.createBindGroup({
				label: 'm4-input-emit',
				layout: this.#emitInputLayout!,
				entries: [
					{ binding: 0, resource: { buffer: inputBuffers.x } },
					{ binding: 1, resource: { buffer: inputBuffers.y } },
					{ binding: 2, resource: { buffer: inputBuffers.color } },
					{ binding: 3, resource: { buffer: this.#configBuffer! } },
					{ binding: 4, resource: { buffer: this.#binBuffer! } }
				]
			})
		);

		// Invalidate passthrough bind groups (they reference input buffers)
		this.#pass5aInputBindGroup = null;
		this.#pass5bInputBindGroup = null;
	}

	#ensurePassthroughBindGroups(inputBuffers: M4InputBuffers): void {
		if (this.#pass5aInputBindGroup && this.#pass5aOutputBindGroup) return;

		// Pass 5a input: xIn, yIn, config, control
		this.#pass5aInputBindGroup = this.#device.createBindGroup({
			label: 'm4-pass5a-input',
			layout: this.#passthroughInputLayout!,
			entries: [
				{ binding: 0, resource: { buffer: inputBuffers.x } },
				{ binding: 1, resource: { buffer: inputBuffers.y } },
				{ binding: 2, resource: { buffer: this.#configBuffer! } },
				{ binding: 3, resource: { buffer: this.#controlBuffer! } }
			]
		});

		// Pass 5b input: seriesIn, colorIn, config, control
		this.#pass5bInputBindGroup = this.#device.createBindGroup({
			label: 'm4-pass5b-input',
			layout: this.#passthroughInputLayout!,
			entries: [
				{ binding: 0, resource: { buffer: inputBuffers.series } },
				{ binding: 1, resource: { buffer: inputBuffers.color } },
				{ binding: 2, resource: { buffer: this.#configBuffer! } },
				{ binding: 3, resource: { buffer: this.#controlBuffer! } }
			]
		});

		// Pass 5a output: xOut, yOut
		this.#pass5aOutputBindGroup = this.#device.createBindGroup({
			label: 'm4-pass5a-output',
			layout: this.#halfOutputLayout!,
			entries: [
				{ binding: 0, resource: { buffer: this.#outputBuffers.x! } },
				{ binding: 1, resource: { buffer: this.#outputBuffers.y! } }
			]
		});

		// Pass 5b output: seriesOut, colorOut
		this.#pass5bOutputBindGroup = this.#device.createBindGroup({
			label: 'm4-pass5b-output',
			layout: this.#halfOutputLayout!,
			entries: [
				{ binding: 0, resource: { buffer: this.#outputBuffers.series! } },
				{ binding: 1, resource: { buffer: this.#outputBuffers.color! } }
			]
		});
	}
}
