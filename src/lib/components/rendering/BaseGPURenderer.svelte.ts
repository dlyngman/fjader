import type { GPUCoordinator, DataBindingEntry, LayerRegistrationResult } from '$lib/gpu';
import type { ChartContext, WebGPUCanvasContext } from '$lib/types';
import { VALUE_RESOLVE_SHADER, VALUE_RESOLVE_WORKGROUP } from '$lib/gpu/ValueResolveShader';
import { TransitionClock } from '$lib/animation/TransitionClock';

interface RendererOptions {
	zIndex?: number;
	xScaleType?: string;
	yScaleType?: string;
}

interface InitConfig {
	dataBindingConfig: DataBindingEntry[];
	markShaderCode: string;
	vertexBufferLayout: GPUVertexBufferLayout[];
	rendererDefinition: object;
}

/**
 * One resolve pipeline per device, shared by every mark.
 *
 * The kernel is channel-agnostic — it binds two inputs, an output and a scalar,
 * and has no idea what the floats mean — so there is nothing to specialise per
 * mark or per channel. Only the bind groups differ.
 */
const RESOLVE_PIPELINES = new WeakMap<GPUDevice, GPUComputePipeline>();

function resolvePipelineFor(device: GPUDevice): GPUComputePipeline {
	let pipeline = RESOLVE_PIPELINES.get(device);
	if (!pipeline) {
		pipeline = device.createComputePipeline({
			label: 'value-resolve',
			layout: 'auto',
			compute: {
				module: device.createShaderModule({ label: 'value-resolve', code: VALUE_RESOLVE_SHADER }),
				entryPoint: 'main'
			}
		});
		RESOLVE_PIPELINES.set(device, pipeline);
	}
	return pipeline;
}

export class BaseGPURenderer {
	// Core properties
	#markType: string;
	#webGPUContext: { getDevice(): GPUDevice };
	#gpuCoordinator: GPUCoordinator;
	#chartContext: ChartContext;

	// Identity & Async Control
	#rendererId: string;
	#initGeneration = 0;
	#isDestroyed = false;

	// Resource tracking (Exclusive resources only)
	#ownedResources: {
		buffers: Map<number, GPUBuffer>;
		layerControl: LayerRegistrationResult | null;
	} = {
		buffers: new Map(),
		layerControl: null
	};

	// Vertex buffers (separate from bind group storage buffers)
	#vertexBuffers = new Map<number, GPUBuffer>();

	/**
	 * Channels that morph between data updates rather than replacing outright.
	 *
	 * An animated channel holds three buffers where a static one holds one:
	 * `from` and `to` are read by a compute pass, and the RESOLVED result is what
	 * the vertex stage binds — in place of the static buffer, not in addition to
	 * it. So animating a channel costs the vertex stage nothing, which is what
	 * makes it affordable on a mark already at the device's storage-buffer limit.
	 *
	 * `resolved` lives in #ownedResources.buffers under the channel's own binding
	 * number, so bind group construction, resizing and teardown all treat it as
	 * the ordinary channel buffer it stands in for.
	 */
	#animated = new Map<
		number,
		{
			from: GPUBuffer;
			to: GPUBuffer;
			params: GPUBuffer;
			/** Bytes allocated, so a grow can be detected without asking the buffer. */
			size: number;
			/** Rows actually in use; the dispatch covers these and no more. */
			count: number;
			/** A new `to` landed, so the current position must become the new start. */
			foldPending: boolean;
		}
	>();
	#animatedRegistered = false;
	#hasWrittenAnimated = false;
	#paramsScratch = new ArrayBuffer(16);
	/**
	 * Where every animated channel of this mark is along its transition.
	 *
	 * One value for the mark, not one per channel: a bar's height and its slot
	 * have to arrive together, and separate clocks with separate velocities
	 * desynchronise on a retarget — the bar slides into its new rank before it
	 * finishes growing, or after.
	 */
	#animationT = 1;

	// State management
	#resourcesCreated = $state(false);
	#instanceCount = $state(0);

	// GPU Objects
	#device: GPUDevice | null = null;
	#pipeline: GPURenderPipeline | null = null;
	#perDataBindGroup: GPUBindGroup | null = $state(null);
	#perDataLayout: GPUBindGroupLayout | null = null;
	#dataBindingConfig: DataBindingEntry[] | null = null;

	#dummyBuffer: GPUBuffer | null = null;
	#bindGroupUpdateScheduled = false;

	#zIndex: number;
	#xScaleType: string;
	#yScaleType: string;

	// Facet support: one renderer registered across multiple facet cell charts
	#facetLayerControls: { chartId: string; control: LayerRegistrationResult }[] = [];
	#facetChartIds: string[] = [];

	constructor(
		markType: string,
		webGPUContext: { getDevice(): GPUDevice },
		gpuCoordinator: GPUCoordinator,
		chartContext: ChartContext,
		options: RendererOptions = {}
	) {
		this.#markType = markType;
		this.#webGPUContext = webGPUContext;
		this.#gpuCoordinator = gpuCoordinator;
		this.#chartContext = chartContext;
		this.#rendererId = `${markType}-${crypto.randomUUID()}`;
		this.#zIndex = options.zIndex || 0;
		this.#xScaleType = options.xScaleType || 'linear';
		this.#yScaleType = options.yScaleType || 'linear';
	}

	// ... Getters (resourcesCreated, etc.) ...
	get resourcesCreated(): boolean {
		return this.#resourcesCreated;
	}
	get instanceCount(): number {
		return this.#instanceCount;
	}
	get pipeline(): GPURenderPipeline | null {
		return this.#pipeline;
	}
	get perDataBindGroup(): GPUBindGroup | null {
		return this.#perDataBindGroup;
	}

	async initialize(config: InitConfig): Promise<void> {
		if (this.#isDestroyed) return;
		const currentGen = ++this.#initGeneration;

		if (this.#resourcesCreated) {
			this.#gpuCoordinator.releaseRenderer(this.#rendererId);
			this.#resourcesCreated = false;
		}

		try {
			const { dataBindingConfig, markShaderCode, vertexBufferLayout, rendererDefinition } = config;

			// 1. Store config for later use in writeAttribute/rebuildBindGroup
			this.#dataBindingConfig = dataBindingConfig;

			this.#device = this.#webGPUContext.getDevice();
			if (!this.#device) throw new Error('No WebGPU device available');

			const result = await this.#gpuCoordinator.acquirePipeline(
				this.#rendererId,
				this.#markType,
				{
					x: this.#chartContext.scaleTypes?.x || this.#xScaleType,
					y: this.#chartContext.scaleTypes?.y || this.#yScaleType
				},
				markShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition
			);

			if (this.#isDestroyed || this.#initGeneration !== currentGen) {
				this.#gpuCoordinator.releaseRenderer(this.#rendererId);
				return;
			}

			this.#pipeline = result.pipeline;
			this.#perDataLayout = result.dataLayout;
			this.#resourcesCreated = true;

			// Initial empty bind group
			this.#rebuildBindGroup();

			console.log(`${this.#markType} renderer initialized`);
		} catch (error) {
			if (!this.#isDestroyed && this.#initGeneration === currentGen) {
				console.error(`${this.#markType} initialization failed:`, error);
				throw error;
			}
		}
	}

	// ===== HIGH-LEVEL DATA API =====

	/**
	 * Write data to a specific shader binding.
	 * Handles buffer creation, smart resizing, and bind group invalidation.
	 */
	writeAttribute(binding: number, data: AllowSharedBufferSource): void {
		if (!this.#device || !data) return;

		// A channel that was animated and is not any more gives its extra buffers
		// back. Without this, the compute pass would keep dispatching into a
		// binding that now holds an ordinary channel buffer and overwrite it with
		// a mix of two stale halves — which renders, wrongly, rather than failing.
		this.#dropAnimated(binding);

		let buffer = this.#ownedResources.buffers.get(binding);
		const requiredSize = data.byteLength;

		// 1. Create or Resize if needed
		if (!buffer || buffer.size < requiredSize) {
			if (buffer) buffer.destroy();

			// Smart resizing (1.5x growth) to prevent thrashing
			const MEMORY_BLOCK_SIZE = 256;
			const desiredSize = Math.ceil(requiredSize * 1.5);
			const size = (Math.ceil(desiredSize / MEMORY_BLOCK_SIZE) * MEMORY_BLOCK_SIZE + 3) & ~3;

			buffer = this.#device.createBuffer({
				size,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				label: `${this.#markType}-binding-${binding}`
			});

			this.#ownedResources.buffers.set(binding, buffer);

			// Buffer reference changed -> Rebuild BindGroup
			this.#scheduleBindGroupUpdate();
		}

		// 2. Write Data (Fine-grained: only touches this buffer)
		this.#device.queue.writeBuffer(buffer, 0, data as ArrayBufferView<ArrayBuffer>);

		// 3. Trigger Render
		if (!this.#bindGroupUpdateScheduled) {
			this.invalidateLayer();
		}
	}

	/**
	 * Write a channel that morphs toward its new values instead of replacing them.
	 *
	 * The incoming data becomes `to`; whatever is on screen right now becomes
	 * `from`. "Right now" is the resolved buffer the compute pass wrote last
	 * frame, so the fold is a buffer copy rather than a computation — and, more
	 * usefully, it does not read `from` or `to` at all. That is what lets this be
	 * called the moment data lands, in any order relative to anything else: the
	 * resolved buffer is a snapshot, and overwriting the inputs it was computed
	 * from cannot invalidate it.
	 *
	 * Writing the same expression the obvious way — `from = mix(from, to, t)` —
	 * would need the OLD `to`, which makes the order of these two writes
	 * load-bearing and silently wrong if they ever swap.
	 */
	writeAnimatedAttribute(binding: number, data: AllowSharedBufferSource): void {
		if (!this.#device || !data) return;

		const required = data.byteLength;
		let entry = this.#animated.get(binding);

		if (!entry || entry.size < required) {
			// One size for all three, so the dispatch never has to reason about
			// which of them is shortest.
			const BLOCK = 256;
			const size = (Math.ceil(Math.ceil(required * 1.5) / BLOCK) * BLOCK + 3) & ~3;
			const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

			entry?.from.destroy();
			entry?.to.destroy();
			this.#ownedResources.buffers.get(binding)?.destroy();

			const make = (role: string) =>
				this.#device!.createBuffer({ size, usage, label: `${this.#markType}-${binding}-${role}` });

			const resolved = make('resolved');
			// The vertex stage binds this one, under the channel's own binding.
			this.#ownedResources.buffers.set(binding, resolved);

			entry = {
				from: make('from'),
				to: make('to'),
				params:
					entry?.params ??
					this.#device.createBuffer({
						size: 16,
						usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
						label: `${this.#markType}-${binding}-resolve-params`
					}),
				size,
				count: 0,
				foldPending: false
			};
			this.#animated.set(binding, entry);
			this.#resolveBindGroups.delete(binding);
			this.#scheduleBindGroupUpdate();
		}

		entry.count = required >> 2;
		entry.foldPending = true;
		this.#device.queue.writeBuffer(entry.to, 0, data as ArrayBufferView<ArrayBuffer>);

		// New data means a new transition — including when nothing reordered,
		// which is the ordinary crossfilter step and the case that used to snap.
		//
		// Not on the FIRST write, though. There is nothing on screen to travel
		// from, so the opening frame of a chart would grow every bar out of
		// whatever the buffers happened to hold. A chart appears; it does not
		// animate in.
		// A row set that is not the one we were animating has nothing to continue
		// from, so this update lands rather than travels.
		if (this.#hasWrittenAnimated && !this.#alignmentBroke) this.#startTransition();
		this.#hasWrittenAnimated = true;

		if (!this.#animatedRegistered) {
			this.#animatedRegistered = true;
			this.#gpuCoordinator.registerComputeWork(`${this.#rendererId}-resolve`, (encoder) =>
				this.#encodeResolve(encoder)
			);
		}
		if (!this.#bindGroupUpdateScheduled) this.invalidateLayer();
	}

	/** Release a channel's transition buffers, leaving the binding to the caller. */
	#dropAnimated(binding: number): void {
		const entry = this.#animated.get(binding);
		if (!entry) return;
		entry.from.destroy();
		entry.to.destroy();
		entry.params.destroy();
		this.#animated.delete(binding);
		this.#resolveBindGroups.delete(binding);
		// The resolved buffer is the caller's to replace; drop it so writeAttribute
		// allocates a fresh one rather than writing into a compute output.
		this.#ownedResources.buffers.get(binding)?.destroy();
		this.#ownedResources.buffers.delete(binding);
		this.#scheduleBindGroupUpdate();
	}

	/**
	 * What this mark's rows ARE, so misalignment can be noticed rather than
	 * trusted not to happen.
	 *
	 * Morphing assumes row `i` is the same entity on every update. The mark
	 * asserts that by choosing to animate at all, and it has been wrong more than
	 * once — a query path that skipped the ordering, a first query assembled
	 * before the ordering existed. The failure is silent and looks like data: a
	 * bar animating to its neighbour's value and back.
	 *
	 * So the claim is checked. When the key changes, this update SNAPS instead of
	 * interpolating, which is exactly what a mark that cannot morph does anyway.
	 * Wrong-but-still is better than wrong-and-moving, and it costs one pass over
	 * a per-category array.
	 */
	setAlignmentKey(key: number): void {
		if (this.#alignmentKey !== null && this.#alignmentKey !== key) {
			this.#alignmentBroke = true;
		}
		this.#alignmentKey = key;
	}

	#alignmentKey: number | null = null;
	#alignmentBroke = false;

	/** Where this mark's animated channels are along their transition, 0..1. */
	setAnimationT(t: number): void {
		this.#animationT = t < 0 ? 0 : t > 1 ? 1 : t;
	}

	/** Last transition counter seen from the clock, to notice a retarget. */
	#lastClockVersion: number | null = null;

	/**
	 * The clock this mark's animated channels run on, and whether it just
	 * restarted.
	 *
	 * It is the CATEGORICAL SCALE's, not the mark's own, and that is the whole
	 * point: a bar's slot and its height have to arrive together. Two springs
	 * with two velocities desynchronise on a retarget — the bar slides into its
	 * new rank before it finishes growing, or after — and in the racing chart
	 * this design exists for, that is the visible artifact rather than a
	 * subtlety. Reading the scale's published `t` means there is one number, and
	 * both the slot resolve and this one read it.
	 *
	 * A mark with no categorical scale has no clock and sits at 1, which makes
	 * the resolve an exact copy of its data — the same thing a static channel
	 * does, without a second code path.
	 *
	 * x before y is arbitrary and only matters for a mark with TWO animating
	 * categorical axes, which nothing builds yet. When something does, the two
	 * will have to share a clock rather than this picking one.
	 */
	/** A categorical scale on this chart that owns a clock, if there is one. */
	#clockScale(): { clock: TransitionClock; startTransition(): void } | null {
		const ctx = this.#chartContext as unknown as {
			xScaleState?: { clock?: TransitionClock; startTransition?(): void } | null;
			yScaleState?: { clock?: TransitionClock; startTransition?(): void } | null;
		};
		for (const scale of [ctx.xScaleState, ctx.yScaleState]) {
			if (scale?.clock && scale.startTransition) {
				return scale as { clock: TransitionClock; startTransition(): void };
			}
		}
		return null;
	}

	/**
	 * Begin a transition for this mark's animated channels.
	 *
	 * ADOPT the categorical scale's clock when there is one, so a bar's height
	 * travels on the same number its slot does — two clocks with two velocities
	 * desynchronise on a retarget, and the bar reaches its rank before or after
	 * it finishes growing. OWN one otherwise, which is the case for a mark on no
	 * categorical axis at all: a scatter morphing a radius has nothing to adopt,
	 * and until it could own a clock it simply snapped.
	 *
	 * Never both. Adoption is safe across marks because a mark with no new data
	 * folds to where it already is — start and destination equal — and does not
	 * move however the clock runs.
	 */
	#startTransition(): void {
		const scale = this.#clockScale();
		if (scale) {
			scale.startTransition();
			return;
		}
		if (!this.#ownClock) {
			this.#ownClock = new TransitionClock();
			this.#ownClock._affectedChartsArray = [this.#chartContext.chartId];
		}
		this.#ownClock.restart();
		// Re-registered every time: the loop evicts a clock when it settles, so
		// this is a join rather than a no-op after the first transition.
		this.#gpuCoordinator.addAnimatedSource(this.#ownClock);
	}

	#ownClock: TransitionClock | null = null;

	#readClock(): { t: number; restarted: boolean } {
		const clock = this.#clockScale()?.clock ?? this.#ownClock ?? null;

		if (!clock) {
			this.#lastClockVersion = null;
			return { t: 1, restarted: false };
		}

		// A restart this mark did not cause still resets `t` to 0 — a sibling
		// mark's data landing on the same axis, or another cell of a facet grid.
		// Without folding on that, this mark's values snap back to where its own
		// transition started and travel again.
		//
		// The clock's own version, not the slot table's. They agree on a reorder
		// and do not in general: settling bumps the slot version, because the
		// table genuinely changed, while no new transition began. Reading that
		// meant a fold on every settle — inert, since `from` and `to` are equal
		// by then, but work done for a reason that was not true.
		//
		// The first observation is deliberately not a restart, or the opening
		// frame would fold against nothing.
		const restarted = this.#lastClockVersion !== null && clock.version !== this.#lastClockVersion;
		this.#lastClockVersion = clock.version;
		return { t: clock.t, restarted };
	}

	#resolveBindGroups = new Map<number, GPUBindGroup>();

	/**
	 * Fold, then resolve, for every animated channel — in that order and in one
	 * encoder, because the fold has to read what the previous frame resolved and
	 * this frame's dispatch is about to overwrite it.
	 *
	 * Each channel writes its own params buffer, which is why there is one per
	 * binding rather than one shared with a dynamic offset: queue writes all land
	 * before any command in the submit, so a shared buffer written between
	 * dispatches would give every dispatch the last channel's values.
	 */
	#encodeResolve(encoder: GPUCommandEncoder): void {
		if (!this.#device || this.#animated.size === 0) return;
		const pipeline = resolvePipelineFor(this.#device);

		const { t, restarted } = this.#readClock();
		this.#animationT = this.#alignmentBroke ? 1 : t;
		if (restarted) {
			for (const entry of this.#animated.values()) entry.foldPending = true;
		}

		const broke = this.#alignmentBroke;
		this.#alignmentBroke = false;

		for (const [binding, entry] of this.#animated) {
			if (entry.count === 0) continue;
			const resolved = this.#ownedResources.buffers.get(binding);
			if (!resolved) continue;

			if (broke) {
				// Start from the destination, so mix() is the identity for every t
				// and the values are simply correct.
				encoder.copyBufferToBuffer(entry.to, 0, entry.from, 0, entry.size);
				entry.foldPending = false;
			} else if (entry.foldPending) {
				// Where everything actually is becomes where it starts from. A
				// transition interrupted mid-flight continues rather than
				// restarting, and one that was at rest copies `to` onto itself,
				// which is correct without being a special case.
				encoder.copyBufferToBuffer(resolved, 0, entry.from, 0, entry.size);
				entry.foldPending = false;
			}

			const view = new DataView(this.#paramsScratch);
			view.setUint32(0, entry.count, true);
			view.setFloat32(4, this.#animationT, true);
			this.#device.queue.writeBuffer(entry.params, 0, this.#paramsScratch);

			let group = this.#resolveBindGroups.get(binding);
			if (!group) {
				group = this.#device.createBindGroup({
					layout: pipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: { buffer: entry.from } },
						{ binding: 1, resource: { buffer: entry.to } },
						{ binding: 2, resource: { buffer: resolved } },
						{ binding: 3, resource: { buffer: entry.params } }
					]
				});
				this.#resolveBindGroups.set(binding, group);
			}

			const pass = encoder.beginComputePass({ label: `${this.#markType}-resolve-${binding}` });
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, group);
			pass.dispatchWorkgroups(Math.ceil(entry.count / VALUE_RESOLVE_WORKGROUP));
			pass.end();
		}
	}

	/**
	 * Write data to a uniform binding.
	 */
	writeUniform(binding: number, data: AllowSharedBufferSource): void {
		if (!this.#device || !data) return;

		let buffer = this.#ownedResources.buffers.get(binding);

		// Uniforms rarely resize, but logic is same for consistency
		if (!buffer || buffer.size < data.byteLength) {
			if (buffer) buffer.destroy();

			buffer = this.#device.createBuffer({
				size: data.byteLength,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				label: `${this.#markType}-uniform-${binding}`
			});
			this.#ownedResources.buffers.set(binding, buffer);
			this.#scheduleBindGroupUpdate();
		}

		this.#device.queue.writeBuffer(buffer, 0, data as ArrayBufferView<ArrayBuffer>);

		if (!this.#bindGroupUpdateScheduled) {
			this.invalidateLayer();
		}
	}

	/**
	 * Write data to a vertex buffer slot (not part of bind group).
	 * Used for per-instance data like facet indices that should use
	 * stepMode: 'instance' instead of storage buffers.
	 */
	writeVertexBuffer(slot: number, data: AllowSharedBufferSource): void {
		if (!this.#device || !data) return;

		let buffer = this.#vertexBuffers.get(slot);
		const requiredSize = data.byteLength;

		if (!buffer || buffer.size < requiredSize) {
			if (buffer) buffer.destroy();

			const MEMORY_BLOCK_SIZE = 256;
			const desiredSize = Math.ceil(requiredSize * 1.5);
			const size = (Math.ceil(desiredSize / MEMORY_BLOCK_SIZE) * MEMORY_BLOCK_SIZE + 3) & ~3;

			buffer = this.#device.createBuffer({
				size,
				usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
				label: `${this.#markType}-vertex-slot-${slot}`
			});

			this.#vertexBuffers.set(slot, buffer);
		}

		this.#device.queue.writeBuffer(buffer, 0, data as ArrayBufferView<ArrayBuffer>);
		this.invalidateLayer();
	}

	/**
	 * Get a vertex buffer by slot index (for use in draw callbacks).
	 */
	getVertexBuffer(slot: number): GPUBuffer | undefined {
		return this.#vertexBuffers.get(slot);
	}

	/**
	 * Get a storage/uniform buffer by binding index.
	 * Used by compute passes (e.g. M4 decimation) to read from
	 * renderer data buffers or include markConstants in alternate bind groups.
	 */
	getBuffer(binding: number): GPUBuffer | undefined {
		return this.#ownedResources.buffers.get(binding);
	}

	// ===== INTERNAL HELPERS =====

	#scheduleBindGroupUpdate(): void {
		if (this.#bindGroupUpdateScheduled) return;
		this.#bindGroupUpdateScheduled = true;

		queueMicrotask(() => {
			this.#rebuildBindGroup();
			this.#bindGroupUpdateScheduled = false;
			// Invalidate layer to ensure a redraw happens with new bindings
			this.invalidateLayer();
		});
	}

	#rebuildBindGroup(): void {
		if (!this.#device || !this.#perDataLayout || !this.#dataBindingConfig) return;

		// Map stored buffers to config entries
		const entries = this.#dataBindingConfig.map((config) => {
			const buffer = this.#ownedResources.buffers.get(config.binding);
			return {
				binding: config.binding,
				resource: { buffer: buffer || this.#sharedDummyBuffer }
			};
		});

		this.#perDataBindGroup = this.#device.createBindGroup({
			label: `${this.#markType}-dynamic-bind-group`,
			layout: this.#perDataLayout,
			entries
		});
	}

	get #sharedDummyBuffer(): GPUBuffer {
		if (!this.#dummyBuffer) {
			this.#dummyBuffer = this.#device!.createBuffer({
				size: 48, // Must fit the largest uniform struct (e.g. Rects MarkConstants = 48 bytes)
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				label: `${this.#markType}-dummy`
			});
		}
		return this.#dummyBuffer;
	}

	updateInstanceCount(count: number): void {
		this.#instanceCount = count;
		this.invalidateLayer();
	}

	registerLayer(
		drawFunction: (passEncoder: GPURenderPassEncoder) => void
	): LayerRegistrationResult {
		const chartId = this.#chartContext.chartId;
		this.#ownedResources.layerControl = this.#gpuCoordinator.registerLayer(chartId, {
			draw: drawFunction,
			markType: this.#markType,
			renderer: this,
			componentId: this.#rendererId,
			zIndex: this.#zIndex
		});
		return this.#ownedResources.layerControl;
	}

	/**
	 * Register the same draw function across multiple facet cell charts.
	 * Idempotent — cleans up previous registrations before re-registering.
	 */
	registerFacetLayers(
		chartIds: string[],
		drawFunction: (passEncoder: GPURenderPassEncoder) => void
	): void {
		// Clean up previous facet registrations
		for (const { control } of this.#facetLayerControls) {
			control.remove();
		}
		this.#facetLayerControls = [];
		this.#facetChartIds = [];

		for (const chartId of chartIds) {
			const control = this.#gpuCoordinator.registerLayer(chartId, {
				draw: drawFunction,
				markType: this.#markType,
				renderer: this,
				componentId: this.#rendererId,
				zIndex: this.#zIndex
			});
			this.#facetLayerControls.push({ chartId, control });
			this.#facetChartIds.push(chartId);
		}

		// Trigger initial render — data was likely written before facet IDs resolved,
		// so earlier invalidateLayer() calls went to the parent chartId (no canvas).
		this.invalidateLayer();
	}

	invalidateLayer(): void {
		if (!this.#gpuCoordinator) return;

		if (this.#facetChartIds.length > 0) {
			for (const chartId of this.#facetChartIds) {
				this.#gpuCoordinator.invalidateChart(chartId);
			}
		} else if (this.#chartContext?.chartId) {
			this.#gpuCoordinator.invalidateChart(this.#chartContext.chartId);
		}
	}

	destroy(): void {
		this.#isDestroyed = true;
		this.#initGeneration++;

		// Unregister FIRST. The coordinator runs registered compute closures every
		// frame, and this one captures buffers that are about to be destroyed —
		// leaving it registered turns a teardown into a validation error on the
		// next frame, at a point with nothing left to name the cause.
		if (this.#animatedRegistered) {
			this.#gpuCoordinator.removeComputeWork(`${this.#rendererId}-resolve`);
			this.#animatedRegistered = false;
		}
		if (this.#ownClock) {
			this.#gpuCoordinator.removeAnimatedSource(this.#ownClock);
			this.#ownClock = null;
		}
		for (const entry of this.#animated.values()) {
			entry.from.destroy();
			entry.to.destroy();
			entry.params.destroy();
		}
		this.#animated.clear();
		this.#resolveBindGroups.clear();

		// Clean up buffers
		for (const buffer of this.#ownedResources.buffers.values()) {
			buffer.destroy();
		}
		this.#ownedResources.buffers.clear();

		for (const buffer of this.#vertexBuffers.values()) {
			buffer.destroy();
		}
		this.#vertexBuffers.clear();

		if (this.#dummyBuffer) this.#dummyBuffer.destroy();
		if (this.#ownedResources.layerControl) this.#ownedResources.layerControl.remove();
		for (const { control } of this.#facetLayerControls) control.remove();
		this.#facetLayerControls = [];
		this.#facetChartIds = [];
		if (this.#gpuCoordinator) this.#gpuCoordinator.releaseRenderer(this.#rendererId);

		this.#pipeline = null;
		this.#perDataBindGroup = null;
		this.#device = null;
	}
}
