/**
 * M4Decimator - GPU compute-based M4 decimation for line charts.
 *
 * Manages compute pipelines, buffers, and bind groups for the M4 algorithm.
 * Whether to decimate or pass the raw rows through is decided in JS
 * (`setDecimationMode`, from the density host) and read from the config by
 * the first dispatch: an encode's output depends on its inputs, the config
 * and the x scale only, never on the frame before, which is what lets a frame
 * with the same be skipped.
 *
 * The decision flag is stored in an extended indirect buffer (20 bytes:
 * 4 drawIndirect args + 1 decision flag). This merges what was previously
 * a separate DecisionBuffer, saving 1 storage binding per stage.
 *
 * Passthrough is split into two sub-dispatches (XY + series/color) to stay
 * within the 8 storage buffer per-stage limit.
 *
 * Usage:
 *   const decimator = new M4Decimator(device, gpuCoordinator);
 *   decimator.configure(numBins, numSeries, xScaleId);
 *   decimator.setVertexCount(quadVertexCount);
 *   gpuCoordinator.registerComputeWork(key, (encoder) =>
 *       decimator.encode(encoder, inputBuffers, pointCount, inputVersion));
 *   // in the same callback, before encode:
 *   decimator.bindForRender(renderer.perDataLayout, constantsBuffer);
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
	PASSTHROUGH_SC_SHADER,
	X_SCALE_IMMEDIATE_SIZE
} from './M4Shader';

/**
 * What the decimator needs of the coordinator: its x scale's params, and
 * somewhere to leave a buffer it replaces.
 */
export interface M4ScaleSource {
	writeScaleParams(scaleId: string, view: Float32Array, offset: number): boolean;
	/** Destroy `buffer` once the next frame is submitted (the coordinator's `retire`). */
	retire(buffer: GPUBuffer): void;
}

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
	#scales: M4ScaleSource;
	#xScaleId: string | null = null;
	/** Reused per frame: the x scale's four floats, pushed as immediates. */
	#xScale = new Float32Array(X_SCALE_IMMEDIATE_SIZE / 4);
	#pointCount = 0;
	#outputCapacity = 0;

	// CPU-side config buffer for updates (8 × u32 = 32 bytes)
	#configData = new Uint32Array(8);

	#lastInputBuffers: M4InputBuffers | null = null;

	/** Built once: a descriptor per encode would be an allocation per frame. */
	#passDescriptor: GPUComputePassDescriptor = { label: 'm4' };
	/**
	 * What the last encode ran with. A frame with the same x scale, the same
	 * input (its buffers and their contents' version) and the same
	 * configuration would write the same output, so it encodes nothing: a
	 * hover or a dim redraws the chart without moving x. `#stale` is everything
	 * else an output depends on: the dimensions, the mode, the buffers it is
	 * written to.
	 */
	#stale = true;
	#ranXScale = new Float32Array(X_SCALE_IMMEDIATE_SIZE / 4);
	#ranInputVersion = NaN;
	#dummyBuffer: GPUBuffer | null = null;

	// Stored references for rebuilding renderBindGroup after output buffer reallocation
	#renderBindGroupLayout: GPUBindGroupLayout | null = null;
	#renderMarkConstantsBuffer: GPUBuffer | null = null;

	constructor(device: GPUDevice, scales: M4ScaleSource) {
		this.#device = device;
		this.#scales = scales;
		this.#createLayouts();
		this.#createPipelines();
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

	// What `configure`, `setVertexCount` and `setDecimationMode` ask for is kept
	// and reaches the GPU at the next encode (`#apply`): they are called from
	// effects, and the GPU is touched in the frame. `configured` and
	// `outputSize` answer for what is WANTED, at once: effects read them.

	/** The vertex count for drawIndirect, and whether the control buffer has it yet. */
	#vertexCount = 0;
	#vertexCountWritten = true;
	#vertexCountData = new Uint32Array(1);
	/** The dimensions the bin and output buffers were allocated for. */
	#allocatedBins = 0;
	#allocatedSeries = 0;
	/** Whether `#configData` has changed since the config buffer was written. */
	#configDirty = false;

	/**
	 * Set the vertex count for drawIndirect (curve-dependent): byte 0 of the
	 * control buffer, written at the next encode.
	 */
	setVertexCount(count: number): void {
		if (count === this.#vertexCount) return;
		this.#vertexCount = count;
		this.#vertexCountWritten = false;
		this.#stale = true;
	}

	/**
	 * Configure dimensions; the buffers for them are allocated at the next
	 * encode. Call when chart width or series count changes.
	 * @param xScaleId — the scale to bin by. Its params are looked up on every
	 *   dispatch, so they are the ones the chart draws through that frame.
	 */
	configure(numBins: number, numSeries: number, xScaleId: string | null): void {
		const internalBins = numBins + 2;
		if (xScaleId !== this.#xScaleId) this.#stale = true;
		this.#xScaleId = xScaleId;
		if (internalBins === this.#numBins && numSeries === this.#numSeries) return;
		this.#numBins = internalBins;
		this.#numSeries = numSeries;
		this.#stale = true;
		this.#configured = true;
	}

	/**
	 * Bring the GPU to what was asked for since the last encode. In the frame:
	 * called at the top of `encode`.
	 */
	#apply(): void {
		if (!this.#vertexCountWritten && this.#controlBuffer) {
			this.#vertexCountData[0] = this.#vertexCount;
			this.#device.queue.writeBuffer(this.#controlBuffer, 0, this.#vertexCountData);
			this.#vertexCountWritten = true;
		}
		if (this.#numBins !== this.#allocatedBins || this.#numSeries !== this.#allocatedSeries) {
			this.#allocatedBins = this.#numBins;
			this.#allocatedSeries = this.#numSeries;
			const totalBins = this.#numBins * this.#numSeries;

			// The old buffers are retired, not destroyed: a bind group made before
			// this may still be set in the frame being built.
			if (this.#binBuffer) this.#scales.retire(this.#binBuffer);
			this.#binBuffer = this.#device.createBuffer({
				size: Math.max(totalBins * M4_BIN_SIZE, 16),
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				label: 'm4-bins'
			});

			this.#allocateOutputBuffers(Math.max(totalBins * 4, this.#pointCount));
			this.#inputBindGroups.clear();
			this.#pass5aInputBindGroup = null;
			this.#pass5bInputBindGroup = null;
			this.#updateConfig(this.#pointCount);
		}
	}

	/** The config as the shaders read it, when it changed: after everything that changes it. */
	#writeConfig(): void {
		if (!this.#configDirty) return;
		this.#configDirty = false;
		this.#device.queue.writeBuffer(
			this.#configBuffer!,
			0,
			this.#configData as Uint32Array<ArrayBuffer>
		);
	}

	/**
	 * Encode M4 into the provided command encoder: one compute pass of seven
	 * dispatches, initBins → binPoints → findMinMax → emitOutput → compact →
	 * passthroughXY → passthroughSC. Dispatches in one pass run in order and
	 * see each other's writes.
	 *
	 * A frame whose x scale is not registered encodes nothing: the output keeps
	 * what the last dispatch wrote rather than being binned through a guess.
	 * So does a frame that would write what the last one did (see `#stale`).
	 *
	 * @param inputVersion — a number that changes whenever the input buffers'
	 *   CONTENTS do. The renderer overwrites a buffer in place when the new rows
	 *   fit, so the buffers being the same ones says nothing about what is in
	 *   them. Left out (NaN), no frame is skipped.
	 */
	encode(
		commandEncoder: GPUCommandEncoder,
		inputBuffers: M4InputBuffers,
		pointCount: number,
		inputVersion = NaN
	): void {
		if (!this.#configured || this.#numBins === 0 || pointCount === 0) return;
		if (!this.#xScaleId || !this.#scales.writeScaleParams(this.#xScaleId, this.#xScale, 0)) return;

		this.#apply();
		if (pointCount !== this.#pointCount) {
			this.#pointCount = pointCount;
			this.#updateConfig(pointCount);
			this.#ensureOutputCapacity(pointCount);
			this.#stale = true;
		}
		this.#writeConfig();

		const last = this.#lastInputBuffers;
		const sameBuffers =
			last !== null &&
			last.x === inputBuffers.x &&
			last.y === inputBuffers.y &&
			last.series === inputBuffers.series &&
			last.color === inputBuffers.color;
		this.#ensureInputBindGroups(inputBuffers);
		this.#ensurePassthroughBindGroups(inputBuffers);

		const x = this.#xScale;
		const ran = this.#ranXScale;
		if (
			!this.#stale &&
			sameBuffers &&
			inputVersion === this.#ranInputVersion &&
			x[0] === ran[0] &&
			x[1] === ran[1] &&
			x[2] === ran[2] &&
			x[3] === ran[3]
		) {
			return;
		}
		ran.set(x);
		this.#ranInputVersion = inputVersion;
		this.#stale = false;

		const totalBins = this.#numBins * this.#numSeries;
		const pointWorkgroups = Math.ceil(pointCount / WORKGROUP_SIZE);
		const binWorkgroups = Math.ceil(totalBins / WORKGROUP_SIZE);

		const pass = commandEncoder.beginComputePass(this.#passDescriptor);

		// 0: Decision + initialize bins
		pass.setPipeline(this.#initBinsPipeline!);
		pass.setBindGroup(0, this.#inputBindGroups.get('initBins')!);
		pass.setBindGroup(1, this.#controlBindGroup!);
		pass.dispatchWorkgroups(binWorkgroups);

		// 1: Count visible points + bin points (if decimating). It and the next
		// read the x scale as immediates; each pushes its own, after its
		// pipeline, so neither relies on what the other left.
		pass.setPipeline(this.#binPointsPipeline!);
		pass.setBindGroup(0, this.#inputBindGroups.get('binPoints')!);
		pass.setBindGroup(1, this.#controlBindGroup!);
		pass.setImmediates(0, this.#xScale);
		pass.dispatchWorkgroups(pointWorkgroups);

		// 2: Find min/max indices (skips in passthrough mode)
		pass.setPipeline(this.#findMinMaxPipeline!);
		pass.setBindGroup(0, this.#inputBindGroups.get('findMinMax')!);
		pass.setBindGroup(1, this.#controlBindGroup!);
		pass.setImmediates(0, this.#xScale);
		pass.dispatchWorkgroups(pointWorkgroups);

		// 3: Emit output (always runs — harmless in passthrough)
		pass.setPipeline(this.#emitOutputPipeline!);
		pass.setBindGroup(0, this.#inputBindGroups.get('emitOutput')!);
		pass.setBindGroup(1, this.#outputBindGroup!);
		pass.dispatchWorkgroups(binWorkgroups);

		// 4: Compact + write indirect instance count (skips in passthrough)
		pass.setPipeline(this.#compactPipeline!);
		pass.setBindGroup(0, this.#fillBindGroup!);
		pass.setBindGroup(1, this.#controlBindGroup!);
		pass.dispatchWorkgroups(this.#numSeries);

		// 5a: Passthrough x,y copy + set indirect count (skips in decimate)
		pass.setPipeline(this.#passthroughXYPipeline!);
		pass.setBindGroup(0, this.#pass5aInputBindGroup!);
		pass.setBindGroup(1, this.#pass5aOutputBindGroup!);
		pass.dispatchWorkgroups(pointWorkgroups);

		// 5b: Passthrough series,color copy (skips in decimate)
		pass.setPipeline(this.#passthroughSCPipeline!);
		pass.setBindGroup(0, this.#pass5bInputBindGroup!);
		pass.setBindGroup(1, this.#pass5bOutputBindGroup!);
		pass.dispatchWorkgroups(pointWorkgroups);

		pass.end();
	}

	/**
	 * What the line draws the output through: the render pipeline's group(1)
	 * layout and the renderer's constants buffer (slot 4, beside the output
	 * buffers in slots 0-3). Called in the frame, before `encode`, every time:
	 * the bind group is made again only when one of the two is another object,
	 * or when the output buffers are (an encode that reallocates them).
	 *
	 * In the frame and not from the component's effect, which would have to
	 * read the constants buffer right after writing it: a write that is applied
	 * later has made no buffer yet.
	 */
	bindForRender(perDataLayout: GPUBindGroupLayout, markConstantsBuffer: GPUBuffer): void {
		if (
			perDataLayout === this.#renderBindGroupLayout &&
			markConstantsBuffer === this.#renderMarkConstantsBuffer
		) {
			return;
		}
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

	/** Read by the line's draw callback, in the frame: plain, nothing reacts to it. */
	renderBindGroup: GPUBindGroup | null = null;

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
	 * Set decimation mode: the config's decimationMode field, written at the next encode:
	 * 'decimate' (1) → M4 decimation active, 'passthrough' (2) → raw data passthrough.
	 */
	setDecimationMode(decision: 'decimate' | 'passthrough'): void {
		const value = decision === 'decimate' ? 1 : 2;
		if (this.#configData[7] === value) return; // no-op if unchanged
		this.#configData[7] = value;
		this.#configDirty = true;
		this.#stale = true;
	}

	#updateConfig(pointCount: number): void {
		this.#stale = true;
		this.#configData[0] = pointCount;
		this.#configData[1] = this.#numBins;
		this.#configData[2] = this.#numSeries;
		// Indices 3-6 reserved, index 7 = decimationMode (JS decision) preserved.
		// Written by `#writeConfig`, once per encode.
		this.#configDirty = true;
	}

	#allocateOutputBuffers(outputCount: number): void {
		this.#stale = true;
		const outputByteSize = Math.max(outputCount * 4, 16);
		this.#outputCapacity = outputCount;

		for (const key of ['x', 'y', 'series', 'color'] as const) {
			// Retired: this runs inside `encode`, where the frame being encoded
			// may already hold the old buffers.
			const old = this.#outputBuffers[key];
			if (old) this.#scales.retire(old);
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

	#createLayouts(): void {
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

	#createPipelines(): void {
		// Pass 0: [inputLayout, controlLayout]
		const inputControlLayout = this.#device.createPipelineLayout({
			label: 'm4-input-control-layout',
			bindGroupLayouts: [this.#inputLayout!, this.#controlLayout!]
		});

		// Passes 1, 2: the same groups, plus the x scale as immediates
		const inputControlScaleLayout = this.#device.createPipelineLayout({
			label: 'm4-input-control-scale-layout',
			bindGroupLayouts: [this.#inputLayout!, this.#controlLayout!],
			immediateSize: X_SCALE_IMMEDIATE_SIZE
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
			layout: inputControlLayout,
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
