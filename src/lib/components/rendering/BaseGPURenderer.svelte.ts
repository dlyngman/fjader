import { untrack } from 'svelte';
import { UNIFORM_STAND_IN_BYTES } from './uniform-sizes';
import type { GPUCoordinator, DataBindingEntry, LayerRegistrationResult } from '$lib/gpu';
import type { ChartContext, WebGPUCanvasContext } from '$lib/types';
import { MorphedChannels, type ClockHost, type ChannelScale } from '$lib/gpu/MorphedChannels';
import { TransitionClock } from '$lib/animation/TransitionClock';
import {
	cutRows,
	hasSeams,
	parentsFromMap,
	siblingSeams,
	type BinCut,
	type BinGeometry,
	type RebinDecision,
	type RebinSource
} from '$lib/gpu/bin-remap';
import { noteTransition, transitionsObserved } from '$lib/animation/transition-log';
import {
	PLACEMENT_WORKGROUP,
	placementLayoutEntry,
	type PlacementBinding,
	type PlacementConfig
} from '$lib/gpu/placement';

export interface RendererOptions {
	zIndex?: number;
	xScaleType?: string;
	yScaleType?: string;
	/** False for a mark whose shader never reads the chart's x and y scales. */
	readsChartScales?: boolean;
	/** Where the layer draws: the plot (default) or the whole cell (axes). */
	space?: 'plot' | 'cell';
	/** A recompile for changed scale types failed (`syncScaleTypes`, which never rejects). */
	onError?: (error: unknown) => void;
}

export interface InitConfig {
	dataBindingConfig: DataBindingEntry[];
	markShaderCode: string;
	vertexBufferLayout: GPUVertexBufferLayout[];
	rendererDefinition: object;
	/** Placement kernels and the record they write (gpu/placement.ts); absent: none. */
	placement?: PlacementConfig;
}

/** One placement kernel, compiled, and the buffers its bind group was last built from. */
interface KernelState {
	pipeline: GPUComputePipeline;
	layout: GPUBindGroupLayout;
	bindings: PlacementBinding[];
	bindGroup: GPUBindGroup | null;
	bound: (GPUBuffer | null)[];
}

/** Warned once per page, not per mark. */
let warnedMorphUnsupported = false;

/**
 * Rebin animation settings, mutable for tuning on device (test pages read
 * `?near=` and `?fade=`).
 *
 * `swapNear`: the share of the ride by which a hold's rows arrive at their
 * parent's value (MorphedChannels' lead). Then the sibling gaps close and the
 * new layout takes over exactly where they are. Waiting for the whole ride
 * kept converged children apart through the tween's long tail; at 0.75
 * (chosen on device) a fast zoom out, whose rebins restart the ride, still
 * reaches the swap. Read at each hold's write.
 */
export const rebinTuning = {
	swapNear: 0.75,
	/**
	 * The seam fade's spring: about 95% in 160 ms, at rest (SEAM_FADE_PRECISION)
	 * in about 200 (chosen on device between 120, which read as a pop, and
	 * 200). `seamFadeStiffnessFor` converts a duration. Read when a renderer
	 * first fades.
	 */
	seamFadeStiffness: 878
};

/**
 * The seam fade's stiffness for `ms` to 95%: a critically damped spring from
 * rest is 95% there at ωt ≈ 4.74, and the stiffness is ω².
 */
export function seamFadeStiffnessFor(ms: number): number {
	const omega = 4.74 / (ms / 1000);
	return omega * omega;
}

/** A seam fade ends within 2% of an inset: well under a pixel. */
const SEAM_FADE_PRECISION = 0.02;

/** How a binned renderer draws rows over bins (setBinning). */
export interface BinningOptions {
	geometry: BinGeometry;
	/** The static bindings holding each row's bin edges (lower, upper): a cut writes them. */
	edges?: readonly [number, number] | null;
	/**
	 * A per-instance vertex slot for seam flags (bin-remap's SEAM_* and
	 * SIBLING_*), which the renderer's pipeline reads; no buffer there means
	 * no seams. null: no seams.
	 */
	seams?: number | null;
	/** Where the seam fade's value goes: a uniform binding and byte offset. */
	seamFade?: { binding: number; offset: number } | null;
}

/** writeMorphed's `scaled` when nothing is: no binding folds. */
const NO_SCALED: readonly number[] = [];

/**
 * A merge holding the layout on the GPU while its rows travel to their
 * parents' values (see BaseGPURenderer's REBINS). The writes it defers are
 * the latest per slot, by reference: the arrays are the result's own.
 */
interface Hold {
	/** The gather from the current result's bins onto the held ones. */
	map: Uint32Array;
	/** Its rows have arrived since its last gather (#landed). */
	landed: boolean;
	/**
	 * A cut not yet written to the morphed channels: its first morphed write
	 * changes their rows to the pieces (`fromHeld`: their start, from the
	 * held rows on screen).
	 */
	cut: { fromHeld: Uint32Array; rowIds: Float32Array } | null;
	generation: number;
	/** The latest morphed write, in the new layout: written at the swap. */
	morph: Parameters<BaseGPURenderer['writeMorphed']> | null;
	attributes: Map<number, AllowSharedBufferSource>;
	vertex: Map<number, AllowSharedBufferSource>;
	count: number | null;
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

	/** Channels that morph between data updates; created on first use. */
	#morphed: MorphedChannels | null = null;
	/** The band axis of the last morphed write — whose scale's clock they adopt. */
	#morphAxis: 'x' | 'y' | null = null;
	/** The morphed bindings measured on the value axis (writeMorphed's `scaled`). */
	#scaledBindings: readonly number[] = NO_SCALED;

	/** A binned mark's rebin source and this renderer's geometry over bins (setBinning). */
	#binning: {
		source: RebinSource;
		geometry: BinGeometry;
		edges: readonly [number, number] | null;
		seams: number | null;
		seamFade: { binding: number; offset: number } | null;
	} | null = null;
	/** Whether the seams slot holds seams (dropped with their layout). */
	#seamsWritten = false;
	/** The seam fade's clock (created on first use), direction and current value. */
	#fadeClock: TransitionClock | null = null;
	#fadeDir: 'open' | 'close' | null = null;
	#fadeNow = 1;
	/** Numbers fades, so a rest from an earlier one does nothing (#onFadeRest). */
	#fadeGeneration = 0;
	#fadeScratch = new Float32Array(1);
	/** The data version the rebin decision was taken for: one per version. */
	#rebinVersion = -1;
	/** The decision's forward map, for this version's first morphed write. */
	#pendingRemap: Uint32Array | null = null;
	/**
	 * What each static slot last uploaded, by reference (the result's own
	 * arrays): the layout on the GPU, which a cut copies into its pieces.
	 */
	#lastStatic = new Map<number, AllowSharedBufferSource>();
	#lastVertex = new Map<number, AllowSharedBufferSource>();
	/** A merge holding the drawn layout (#beginWrite), or null. */
	#hold: Hold | null = null;
	/** Numbers holds, so a landing callback from an earlier one does nothing. */
	#holdGeneration = 0;

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
	#readsChartScales: boolean;
	#space: 'plot' | 'cell';
	#xScaleType: string;
	#yScaleType: string;
	/** The last config passed to `initialize`, so it can be re-run. */
	#initConfig: InitConfig | null = null;
	/**
	 * The scale types the current pipeline was COMPILED against.
	 *
	 * The shader is specialised per scale type — `scaleBand` resolves an id
	 * through the slot table, `scaleLinear` does not — so the pipeline depends
	 * on a value that is not known when a chart starts. A mark whose axis type
	 * is inferred from the table schema registers nothing until that arrives,
	 * and a renderer built inside that window compiled against the `linear`
	 * fallback and stayed there: every row drawn, none discarded, positions
	 * read as numbers instead of resolved as identities. Recorded so it can be
	 * compared and rebuilt rather than assumed to have been right.
	 */
	#builtScaleTypes: { x: string; y: string } | null = null;
	/**
	 * The types the latest compile started with: what `syncScaleTypes`
	 * compares against. `#builtScaleTypes` is only set when a compile finishes,
	 * so while one runs it names the previous pipeline, and a change during the
	 * compile that returns to those types looked like no change: the compile
	 * then finished with the types it read at its start, wrong, and nothing
	 * re-checked.
	 */
	#compilingScaleTypes: { x: string; y: string } | null = null;
	/**
	 * Whether the chart's scales have NOT been ready since the latest compile
	 * started: its types are still provisional (an unresolved axis reads as
	 * `linear`, marks still register, a changed type brings a scale with no
	 * domain yet), and nothing it drew had a domain. A rebuild then is quiet;
	 * once the scales have been ready (noteScalesReady), a rebuild corrects what
	 * was drawn, and is said. Readiness after the compile counts, not only at it.
	 * Set when a compile starts, kept with the built pipeline, reset on failure.
	 */
	#provisional = false;
	#builtProvisional = false;

	/**
	 * Bindings whose buffer belongs to another renderer (a label reads its
	 * host's record), each looked up through `get` when this renderer binds,
	 * with what it was last bound to. An array, walked by index at every draw.
	 */
	#external: { binding: number; get: () => GPUBuffer | undefined; bound: GPUBuffer | null }[] = [];

	// Placement (gpu/placement.ts): kernels writing the record the draw reads.
	#placement: PlacementConfig | null = null;
	#kernels: KernelState[] = [];
	#record: GPUBuffer | null = null;
	/** The placement registrations, one per chart the renderer draws in. */
	#placementKeys: string[] = [];

	// Facet support: one renderer registered across multiple facet cell charts
	#facetLayerControls: { chartId: string; control: LayerRegistrationResult }[] = [];
	#facetChartIds: string[] = [];
	/**
	 * The redraw list for a mark that is not faceted: just its own chart.
	 *
	 * Held and rewritten in place rather than built per call. The clock asks for
	 * this on every frame it drives, so returning a fresh array made one
	 * allocation per frame per morphing mark — on the animation path, which the
	 * coordinator is otherwise built to keep free of garbage.
	 */
	#ownChartIds: string[] = [''];

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
		this.#readsChartScales = options.readsChartScales ?? true;
		this.#space = options.space ?? 'plot';
		this.#xScaleType = options.xScaleType || 'linear';
		this.#yScaleType = options.yScaleType || 'linear';
		this.#onError = options.onError ?? null;
	}

	#onError: ((error: unknown) => void) | null;

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

			const scaleTypes = this.#scaleTypes();
			this.#compilingScaleTypes = scaleTypes;
			this.#provisional = !this.#chartContext.scalesReady;
			const result = await this.#gpuCoordinator.acquirePipeline(
				this.#rendererId,
				this.#markType,
				scaleTypes,
				markShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition
			);

			if (this.#isDestroyed || this.#initGeneration !== currentGen) {
				this.#releaseSuperseded(scaleTypes);
				return;
			}

			const kernels: KernelState[] = [];
			if (config.placement) {
				for (const kernel of config.placement.kernels) {
					const compiled = await this.#gpuCoordinator.acquireComputePipeline(
						this.#rendererId,
						`${this.#markType}-place-${kernel.name}`,
						scaleTypes,
						kernel.code,
						kernel.bindings.map(placementLayoutEntry),
						rendererDefinition as never
					);
					kernels.push({
						pipeline: compiled.pipeline,
						layout: compiled.dataLayout,
						bindings: kernel.bindings,
						bindGroup: null,
						bound: kernel.bindings.map(() => null)
					});
				}
				if (this.#isDestroyed || this.#initGeneration !== currentGen) {
					this.#releaseSuperseded(scaleTypes);
					return;
				}
			}

			this.#pipeline = result.pipeline;
			this.#perDataLayout = result.dataLayout;
			this.#initConfig = config;
			this.#builtScaleTypes = scaleTypes;
			// As it stands now: the scales may have been ready while this compiled.
			this.#builtProvisional = this.#provisional;
			this.#placement = config.placement ?? null;
			this.#kernels = kernels;
			if (this.#placement) this.#ensureRecord(this.#instanceCount);
			this.#resourcesCreated = true;

			// Initial empty bind group
			this.#rebuildBindGroup();

			// The specialisation is named because it is otherwise invisible: a mark
			// compiled against the wrong axis logic renders, silently and wrongly.

			// The types were read when this compile started; if the chart's moved
			// while it ran, the change that announced them was compared against
			// this compile's types or found no compile to compare against (the
			// first, at mount). Catch up once; syncScaleTypes never rejects.
			const now = this.#scaleTypes();
			if (now.x !== scaleTypes.x || now.y !== scaleTypes.y) void this.syncScaleTypes();
		} catch (error) {
			if (!this.#isDestroyed && this.#initGeneration === currentGen) {
				// Nothing was built for the types this compile read: compare against
				// what was, or a sync back to these types would skip the retry.
				this.#compilingScaleTypes = this.#builtScaleTypes;
				this.#provisional = this.#builtProvisional;
				console.error(`${this.#markType} initialization failed:`, error);
				throw error;
			}
		}
	}

	/**
	 * A compile that a newer one superseded (or that finished after destroy)
	 * releases what it acquired itself: its pipeline and kernels, keyed by the
	 * types it read. Not everything under this renderer's id, which would also
	 * drop the newer compile's resources when it finished first (a cached
	 * pipeline does) — unless the newer one reads the same types, in which case
	 * the resources are the same entries and stay.
	 */
	#releaseSuperseded(scaleTypes: { x: string; y: string }): void {
		if (this.#isDestroyed) {
			this.#gpuCoordinator.releaseRenderer(this.#rendererId);
			return;
		}
		const newest = this.#compilingScaleTypes;
		if (newest && newest.x === scaleTypes.x && newest.y === scaleTypes.y) return;
		this.#gpuCoordinator.releaseRendererTypes(this.#rendererId, scaleTypes);
	}

	/**
	 * The specialisation this mark's shader should be compiled for.
	 *
	 * The chart's types win; the constructor's are the fallback for an axis the
	 * chart names none for, which is how ParallelLines pins its own y. Both fall
	 * back to `linear`, and that last step is a GUESS — see #builtScaleTypes for
	 * what it costs — which is why `syncScaleTypes` exists to correct it rather
	 * than the guess being made once and trusted.
	 */
	#scaleTypes(): { x: string; y: string } {
		return {
			x: this.#chartContext.scaleTypes?.x || this.#xScaleType,
			y: this.#chartContext.scaleTypes?.y || this.#yScaleType
		};
	}

	/**
	 * The chart's scales are ready: what this renderer compiled for has now drawn
	 * with a domain, so a later change of type is worth a warning. Called by its
	 * host after `syncScaleTypes`, from the effect that tracks both.
	 */
	noteScalesReady(): void {
		this.#provisional = false;
		this.#builtProvisional = false;
	}

	/**
	 * Rebuild the pipeline if the chart's scale types have moved away from the
	 * ones it was compiled against. A no-op otherwise, and cheap: two string
	 * comparisons.
	 *
	 * Called whenever the chart's types change. Two cases reach it — an axis
	 * whose type resolved after this renderer was built (a mark that infers its
	 * scale from the table schema), and one that genuinely changes later,
	 * when a mark joins the chart and MANDATEs a different type. Only the second
	 * warns: the first comes before the chart's scales have been ready since
	 * this compiled (see #provisional), and is how every guide on a time or band
	 * axis starts.
	 *
	 * The data survives: `initialize` releases the coordinator's pipeline and
	 * shader references but not the buffers this renderer owns, and rebuilds the
	 * bind group from them. `#resourcesCreated` goes false and back to true,
	 * which re-runs every component effect gated on it, so anything that did
	 * need rewriting is rewritten.
	 *
	 * The chart's render plan caches a pipeline per layer, so it has to be
	 * rebuilt too — otherwise the swap is invisible and the chart keeps drawing
	 * through the old one.
	 *
	 * Never rejects: a failed recompile goes to the `onError` option (the host
	 * records it as it does a failed mount), so a caller may drop the promise.
	 */
	async syncScaleTypes(): Promise<void> {
		const config = this.#initConfig;
		const built = this.#builtScaleTypes;
		const target = this.#compilingScaleTypes ?? built;
		if (!config || !built || !target || this.#isDestroyed) return;

		const want = this.#scaleTypes();
		if (want.x === target.x && want.y === target.y) return;

		// Scales not ready since this compiled: provisional types, rebuilt quietly.
		// Once they have been ready, types that move are said.
		if (!this.#provisional)
			console.warn(
				`[${this.#markType}] rebuilding pipeline: the chart's scales moved from ` +
					`(${target.x}, ${target.y}) to (${want.x}, ${want.y}) after this mark compiled ` +
					`against them. Anything drawn in between used the wrong axis logic.`
			);
		try {
			await this.initialize(config);
		} catch (error) {
			this.#onError?.(error);
			return;
		}
		this.#gpuCoordinator.rebuildRenderPlan(this.#chartContext.chartId);
		for (const { chartId } of this.#facetLayerControls) {
			this.#gpuCoordinator.rebuildRenderPlan(chartId);
		}
	}

	// ===== HIGH-LEVEL DATA API =====

	/**
	 * Write data to a specific shader binding.
	 * Handles buffer creation, smart resizing, and bind group invalidation.
	 */
	writeAttribute(binding: number, data: AllowSharedBufferSource): void {
		if (!this.#device || !data) return;
		this.#beginWrite();
		if (this.#hold) {
			this.#hold.attributes.set(binding, data);
			return;
		}
		this.#writeAttributeNow(binding, data);
	}

	/**
	 * Drop `binding`'s buffer: a channel nothing reads any more (a label layer
	 * that unmounted). Its readers stop drawing when `bufferFor` finds nothing.
	 */
	releaseAttribute(binding: number): void {
		this.#hold?.attributes.delete(binding);
		this.#lastStatic.delete(binding);
		this.#morphed?.drop(binding);
		const buffer = this.#ownedResources.buffers.get(binding);
		if (!buffer) return;
		this.#ownedResources.buffers.delete(binding);
		buffer.destroy();
		this.#scheduleBindGroupUpdate();
	}

	/** writeAttribute's upload, whatever a hold defers: what the GPU holds for `binding`. */
	#writeAttributeNow(binding: number, data: AllowSharedBufferSource): void {
		if (!this.#device) return;
		this.#lastStatic.set(binding, data);

		// A channel that morphed and does not any more gives its buffers back, and
		// the binding needs rebinding to the static buffer allocated below.
		if (this.#morphed?.drop(binding)) this.#scheduleBindGroupUpdate();

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
	 * Charts to redraw while this mark's own clock runs.
	 *
	 * Asked per frame rather than captured, because the answer changes: a facet
	 * grid registers its cells after the mark's first data has landed. Both
	 * branches return a held array, so asking costs one comparison and no
	 * allocation.
	 */
	#chartsToRedraw(): string[] {
		if (this.#facetChartIds.length > 0) return this.#facetChartIds;
		const chartId = this.#chartContext.chartId;
		if (this.#ownChartIds[0] !== chartId) this.#ownChartIds[0] = chartId;
		return this.#ownChartIds;
	}

	/**
	 * Write one data update's morphing channels together.
	 *
	 * `bandIds` are the category of each row, on `bandAxis`: they are how a
	 * row set that is not the one being animated gets noticed and snapped, and
	 * the band axis's scale is whose clock these channels adopt. See
	 * MorphedChannels for the fold, the snap and the clock.
	 */
	writeMorphed(
		bandAxis: 'x' | 'y',
		bandIds: ArrayLike<number>,
		channels: readonly (readonly [number, AllowSharedBufferSource])[],
		/** Bindings that land at once rather than travel (see MorphedChannels.write). */
		land?: readonly number[] | 'all',
		/**
		 * Bindings whose values are measured on the value axis (the one that is
		 * not `bandAxis`): they resolve in pixel space under that scale, so they
		 * glide linearly on screen even while the scale moves. Not a band id or
		 * an Other share.
		 */
		scaled: readonly number[] = NO_SCALED
	): void {
		if (!this.#device) return;
		this.#beginWrite();
		if (this.#hold) {
			if (this.#gatherInto(bandAxis, bandIds, channels, land, scaled)) return;
			// A channel the held rows do not have: the new layout goes up now.
			this.#endHoldNow();
		}
		// A rebin's map from the rows on screen to these (MorphedChannels.write):
		// the first morphed write of the version takes it, later ones are aligned.
		const remap = this.#pendingRemap;
		this.#pendingRemap = null;

		if (!MorphedChannels.supported) {
			if (!warnedMorphUnsupported) {
				warnedMorphUnsupported = true;
				console.warn(
					'[Fjader] WGSL immediates are not available, so values will not animate between updates.'
				);
			}
			for (const [binding, data] of channels) this.writeAttribute(binding, data);
			return;
		}

		this.#morphed ??= new MorphedChannels({
			device: this.#device,
			host: this.#gpuCoordinator,
			label: this.#rendererId,
			// Runs on every frame a mark encodes, so no template strings.
			clockHost: () => {
				const axis = this.#morphAxis;
				const scale =
					axis === 'x'
						? this.#chartContext.xScaleState
						: axis === 'y'
							? this.#chartContext.yScaleState
							: null;
				const slots = (scale as { slots?: Partial<ClockHost> } | null)?.slots;
				return slots?.clock && slots.startTransition ? (slots as ClockHost) : null;
			},
			affectedCharts: () => this.#chartsToRedraw(),
			// The value axis's scale, for the bindings measured on it. Runs on
			// every encode: an array scan of two, no allocation.
			scaleFor: (binding) => {
				if (!this.#scaledBindings.includes(binding)) return null;
				const axis = this.#morphAxis;
				const scale =
					axis === 'x'
						? this.#chartContext.yScaleState
						: axis === 'y'
							? this.#chartContext.xScaleState
							: null;
				return (scale as ChannelScale | null) ?? null;
			}
		});
		this.#scaledBindings = scaled;

		// A binding that was static until now gives up its buffer; the morphed
		// channel's resolved buffer takes its place in the bind group.
		let rebind = false;
		for (const [binding] of channels) {
			this.#lastStatic.delete(binding);
			const stale = this.#ownedResources.buffers.get(binding);
			if (stale) {
				stale.destroy();
				this.#ownedResources.buffers.delete(binding);
				rebind = true;
			}
		}

		this.#morphAxis = bandAxis;
		if (this.#morphed.write(bandIds, channels, land, remap) || rebind) {
			this.#scheduleBindGroupUpdate();
		} else if (!this.#bindGroupUpdateScheduled) {
			this.invalidateLayer();
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
		// The mark rewrote its uniform whole: a seam fade's value goes back on top.
		if (this.#seamsWritten && this.#binning?.seamFade?.binding === binding) {
			this.#setFade(this.#fadeNow);
		}

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
		this.#beginWrite();
		if (this.#hold) {
			this.#hold.vertex.set(slot, data);
			return;
		}
		this.#writeVertexNow(slot, data);
	}

	/** writeVertexBuffer's upload, whatever a hold defers. */
	#writeVertexNow(slot: number, data: AllowSharedBufferSource): void {
		if (!this.#device) return;
		// A cut's seams are its own, not data a later cut copies.
		if (slot !== this.#binning?.seams) this.#lastVertex.set(slot, data);

		let buffer = this.#vertexBuffers.get(slot);
		const requiredSize = data.byteLength;

		if (!buffer || buffer.size < requiredSize) {
			if (buffer) buffer.destroy();

			const MEMORY_BLOCK_SIZE = 256;
			const desiredSize = Math.ceil(requiredSize * 1.5);
			const size = (Math.ceil(desiredSize / MEMORY_BLOCK_SIZE) * MEMORY_BLOCK_SIZE + 3) & ~3;

			buffer = this.#device.createBuffer({
				size,
				// STORAGE too: a placement kernel reads seams and facet indices as
				// storage, having no vertex input.
				usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
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
		return this.#morphed?.resolved(binding) ?? this.#ownedResources.buffers.get(binding);
	}

	/**
	 * The buffer `binding` reads right now: what anything binding this
	 * renderer's data should bind (the record, for a label), looked up when it
	 * binds rather than kept. "Right now", not "owned": the morph's resolved
	 * buffer while one runs, and later perhaps a buffer shared across marks.
	 * A consumer compares it with the one it last bound and rebinds when it
	 * differs, at the moment it is about to draw or dispatch, so it never binds
	 * a buffer that has been reallocated or destroyed.
	 */
	bufferFor(binding: number): GPUBuffer | undefined {
		return this.getBuffer(binding);
	}

	/**
	 * Bind `binding` to another renderer's buffer, looked up through `get`
	 * (that renderer's `bufferFor`). See `syncExternal`.
	 */
	setExternalBinding(binding: number, get: () => GPUBuffer | undefined): void {
		this.#external = this.#external.filter((e) => e.binding !== binding);
		this.#external.push({ binding, get, bound: null });
		this.#scheduleBindGroupUpdate();
	}

	/**
	 * Before drawing with external bindings: whether every one has a buffer,
	 * after rebinding to whatever each reads now. Rebuilt at once, here, when
	 * one changed: the owner may have grown or replaced it this frame, and a
	 * bind group holding the old one would bind a destroyed buffer, which fails
	 * the whole submit, every chart's frame with it. A few reads per draw, no
	 * allocation. The caller sets the bind group again after a true return.
	 */
	syncExternal(): boolean {
		let changed = false;
		for (let i = 0; i < this.#external.length; i++) {
			const ext = this.#external[i];
			const buffer = ext.get();
			if (!buffer) return false;
			if (buffer !== ext.bound) changed = true;
		}
		if (changed) this.#rebuildBindGroup();
		return this.#perDataBindGroup !== null;
	}

	// ===== PLACEMENT =====

	/** Whether this renderer places its rows in kernels (its draw reads the record). */
	get placed(): boolean {
		return this.#placement !== null;
	}

	/**
	 * A record buffer for at least `count` rows. Sized to the DRAWN count, which
	 * a rebin hold keeps while new data waits (#setCountNow), so a held layout
	 * is placed as drawn. A new buffer rebuilds the draw's bind group at once:
	 * the draw binds the record, and a frame can run before a microtask.
	 */
	#ensureRecord(count: number): void {
		const placement = this.#placement;
		if (!placement || !this.#device) return;
		const needed = Math.max(1, count) * placement.recordStride;
		if (this.#record && this.#record.size >= needed) return;
		const size = Math.ceil((needed * 1.5) / 256) * 256;
		// WebGPU keeps a buffer alive for work already submitted.
		this.#record?.destroy();
		this.#record = this.#device.createBuffer({
			size,
			usage: GPUBufferUsage.STORAGE,
			label: `${this.#markType}-record`
		});
		this.#ownedResources.buffers.set(placement.recordBinding, this.#record);
		this.#rebuildBindGroup();
	}

	/**
	 * A kernel's bind group, from each binding's buffer as it is now. Looked up
	 * at every dispatch and rebuilt only when one changed: a few map reads per
	 * kernel per frame, no allocation. Built from the same lookup the draw's
	 * bind group uses (getBuffer: the morph's resolved buffer while one runs),
	 * so a kernel never reads raw values mid-morph, and never binds a buffer
	 * freed elsewhere (seams are dropped with their layout, buffers grow).
	 */
	#kernelBindGroup(kernel: KernelState, count: number): GPUBindGroup | null {
		const device = this.#device;
		if (!device) return null;
		let changed = kernel.bindGroup === null;
		const { bindings, bound } = kernel;
		for (let i = 0; i < bindings.length; i++) {
			const buffer = this.#placementSource(bindings[i], count);
			if (!buffer) return null;
			if (bound[i] !== buffer) {
				bound[i] = buffer;
				changed = true;
			}
		}
		if (changed) {
			kernel.bindGroup = device.createBindGroup({
				label: `${this.#markType}-placement`,
				layout: kernel.layout,
				entries: bindings.map((b, i) => ({ binding: b.binding, resource: { buffer: bound[i]! } }))
			});
		}
		return kernel.bindGroup;
	}

	#placementSource(b: PlacementBinding, count: number): GPUBuffer | null {
		switch (b.source) {
			case 'channel':
			case 'uniform':
				return this.getBuffer(b.channel) ?? this.#sharedDummyBuffer;
			case 'vertex': {
				const buffer = this.#vertexBuffers.get(b.slot);
				// Whole or nothing: a buffer short of the drawn rows was written for
				// another layout (see PlacementBinding).
				if (!buffer || (b.rowBytes && buffer.size < count * b.rowBytes)) {
					return this.#sharedDummyBuffer;
				}
				return buffer;
			}
			case 'record':
				return this.#record;
		}
	}

	/**
	 * This renderer's placement for one chart: its kernels over the drawn rows,
	 * in the coordinator's placement pass (groups 0 and 2 already set). The
	 * row count is read here, at encode time, as the draw reads it.
	 */
	#place = (
		pass: GPUComputePassEncoder,
		immediates: Float32Array<ArrayBuffer>,
		rows: Uint32Array<ArrayBuffer>
	): void => {
		const count = this.#instanceCount;
		const record = this.#record;
		const placement = this.#placement;
		if (count === 0 || !record || !placement || record.size < count * placement.recordStride)
			return;
		// Every kernel's bind group before any dispatch: all of them run or none
		// does. One running alone writes half a record: after the record grows,
		// a box with zeroed opacity, every bar invisible for a frame.
		const kernels = this.#kernels;
		for (let i = 0; i < kernels.length; i++) {
			if (!this.#kernelBindGroup(kernels[i], count)) return;
		}
		rows[12] = count;
		rows[13] = 0;
		const groups = Math.ceil(count / PLACEMENT_WORKGROUP);
		for (let i = 0; i < kernels.length; i++) {
			const kernel = kernels[i];
			pass.setPipeline(kernel.pipeline);
			pass.setBindGroup(1, kernel.bindGroup!);
			pass.setImmediates(0, immediates);
			pass.dispatchWorkgroups(groups);
		}
	};

	/** Register #place for `chartIds` (replacing earlier registrations). */
	#registerPlacement(chartIds: readonly string[]): void {
		for (const key of this.#placementKeys) this.#gpuCoordinator.removePlacement(key);
		this.#placementKeys = [];
		if (!this.#placement) return;
		for (const chartId of chartIds) {
			const key = `${this.#rendererId}@${chartId}`;
			this.#gpuCoordinator.registerPlacement(key, chartId, this.#place);
			this.#placementKeys.push(key);
		}
	}

	// ===== REBINS =====
	//
	// A binned mark's results follow its rebins (RebinSource, the lifecycle):
	// - A split, or a merge that cannot hold: the new layout is written at
	//   once and its rows start where the old rows they cover were drawn
	//   (forward map), then travel. A split's children start with the gaps
	//   between them closed, which then open (the seam fade, below).
	// - A merge into bins that nest the drawn ones HOLDS: the drawn layout
	//   stays (static writes and the instance count are deferred) and its
	//   rows travel to their parent's new value (MorphedChannels' gather),
	//   riding the scale's tween, arriving by `swapNear` of it. Then the gaps
	//   between siblings close, and the new layout is written through the
	//   forward map, which starts each parent at its children's mean: where
	//   they already are, so the swap does not show.
	// - A merge whose bins do not nest CUTS the held bars at the new edges
	//   (BinCut), which looks the same, and holds the pieces as above.
	// Every result during a hold is taken against the held layout (nothing is
	// committed): a filter result or a further nested merge gathers again,
	// anything else ends the hold and writes the new layout through a
	// forward map from the held one. Ending flushes every deferred write, not
	// only the slots the new result rewrites: a mark rewrites only what
	// changed.
	//
	// SEAMS (optional, `BinningOptions.seams`): per-row flags in a vertex slot
	// the renderer's pipeline reads. Cut edges draw flush; sibling edges (two
	// rows that are one bar in the other layout) draw their inset scaled by the
	// seam fade, a value at `BinningOptions.seamFade` in the renderer's own
	// uniform, written on the frames a fade runs (a short TransitionClock on the
	// coordinator's loop): per mark, so not an immediate.
	//
	// The geometry says whether this renderer can hold: `interval` (rows span
	// their bins, so siblings at one height draw as their parent). `point`
	// needs a morphing position and presence first; until then it does not
	// hold and merges go forward.

	/**
	 * Make this renderer's rows follow a binned mark's rebins: `source` says
	 * what each result is relative to the rows on the GPU, the options how
	 * this renderer draws rows over bins. null for a mark that is not binned.
	 * A new source (a rebuilt lifecycle) starts over: its first result has
	 * nothing committed to map from.
	 */
	setBinning(source: RebinSource | null, options: BinningOptions): void {
		const b = this.#binning;
		const { geometry, edges = null, seams = null, seamFade = null } = options;
		if (
			b?.source === source &&
			b?.geometry === geometry &&
			b?.edges?.[0] === edges?.[0] &&
			b?.edges?.[1] === edges?.[1] &&
			b?.seams === seams &&
			b?.seamFade?.binding === seamFade?.binding &&
			b?.seamFade?.offset === seamFade?.offset
		) {
			return;
		}
		if (this.#hold) this.#releaseHold();
		this.#stopFade();
		this.#dropSeams();
		this.#binning = source ? { source, geometry, edges, seams, seamFade } : null;
		this.#rebinVersion = -1;
		this.#pendingRemap = null;
	}

	/**
	 * Before any data write: on the first write of a new data version, ask the
	 * source what the result is and commit its layout. Keyed by version, not
	 * by which write comes first: a mark writes each channel from its own
	 * effect, in no order this could rely on, and every write of a version
	 * must see the same decision.
	 */
	#beginWrite(): void {
		const binning = this.#binning;
		if (!binning) return;
		// Untracked, here and wherever the source is asked: a write runs inside
		// the mark's effect, and the source reads the lifecycle's state (the
		// result, its parts). Tracked, every write effect would come to depend
		// on it and rerun, re-uploading unchanged arrays, on each new result.
		const version = untrack(this.#readVersion);
		if (version === this.#rebinVersion) return;
		this.#rebinVersion = version;
		const canHold =
			binning.geometry === 'interval' &&
			binning.edges !== null &&
			this.#morphed !== null &&
			MorphedChannels.supported;
		const decision = this.#take(canHold);
		this.#noteRebin(decision);
		if (decision?.kind === 'cut') {
			this.#startCut(decision.cut, binning.edges!);
			this.#commit();
			return;
		}
		if (decision?.kind === 'hold') {
			// Nothing is committed: the GPU keeps the held layout.
			this.#pendingRemap = null;
			const map = decision.map;
			this.#holding(map, siblingSeams(parentsFromMap(map), map[2], map[3]));
			return;
		}
		if (this.#hold) this.#releaseHold();
		this.#forward(decision);
		this.#commit();
	}

	/**
	 * A result that does not hold: a forward map for the next morphed write.
	 * A new layout's seams: a split's children open their gaps; any other
	 * layout has none. The same rows (no decision) keep a fade that runs.
	 */
	#forward(decision: RebinDecision): void {
		const map = decision?.kind === 'forward' ? decision.map : null;
		this.#pendingRemap = map;
		if (!map) return;
		this.#stopFade();
		const seams =
			this.#binning?.seams != null ? siblingSeams(parentsFromMap(map), map[2], map[3]) : null;
		if (seams && hasSeams(seams)) {
			this.#writeSeams(seams);
			this.#startFade('open');
		} else {
			this.#dropSeams();
		}
	}

	/** The source's data version; a field, so asking untracked allocates nothing per write. */
	#readVersion = (): number => this.#binning?.source.dataVersion() ?? -1;

	/** The source's decision for the current result, untracked (see #beginWrite). */
	#take(canHold: boolean): RebinDecision {
		const source = this.#binning?.source;
		return source ? untrack(() => source.takeRebin(canHold)) : null;
	}

	/** Commit the current result's layout at the source, untracked. */
	#commit(): void {
		const source = this.#binning?.source;
		if (source) untrack(() => source.commitLayout());
	}

	/**
	 * Hold (or keep holding) with this gather map; the hold's deferred writes
	 * are kept. `seams`: the held rows' (siblings under the new parents, and
	 * a cut's own), written now with their gaps open. A fade already closing
	 * keeps closing: a result landing as the gaps close does not reopen them.
	 */
	#holding(map: Uint32Array, seams: Uint32Array): Hold {
		this.#writeSeams(hasSeams(seams) ? seams : null);
		if (this.#fadeDir !== 'close') {
			this.#stopFade();
			this.#setFade(1);
		}
		if (this.#hold) {
			this.#hold.map = map;
			this.#hold.cut = null;
			this.#hold.landed = false;
			return this.#hold;
		}
		this.#hold = {
			map,
			cut: null,
			landed: false,
			generation: ++this.#holdGeneration,
			morph: null,
			attributes: new Map(),
			vertex: new Map(),
			count: null
		};
		return this.#hold;
	}

	/**
	 * A cut: the held bars, cut at the new edges, become the drawn layout; it
	 * looks the same. Its static rows are the held ones' (what this renderer
	 * last uploaded), run by run, with the edge bindings taking the pieces'
	 * edges; then it holds the pieces. The morphed channels change rows at the
	 * version's first morphed write (#gatherInto).
	 */
	#startCut(cut: BinCut, [lowerBinding, upperBinding]: readonly [number, number]): void {
		for (const [binding, data] of this.#lastStatic) {
			const rows =
				binding === lowerBinding
					? cut.side.lower
					: binding === upperBinding
						? cut.side.upper
						: cutRows(data, cut);
			if (rows) this.#writeAttributeNow(binding, rows);
		}
		for (const [slot, data] of this.#lastVertex) {
			const rows = cutRows(data, cut);
			if (rows) this.#writeVertexNow(slot, rows);
		}
		this.#setCountNow(cut.side.lower.length);
		const hold = this.#holding(cut.fromNew, cut.seams);
		hold.cut = { fromHeld: cut.fromHeld, rowIds: cut.side.lower };
	}

	/**
	 * A morphed write during a hold: gathered into the held rows, and kept for
	 * the swap. False when it cannot gather (a channel the held rows lack).
	 */
	#gatherInto(...write: Parameters<BaseGPURenderer['writeMorphed']>): boolean {
		const hold = this.#hold!;
		const morphed = this.#morphed;
		const [bandAxis, bandIds, channels, land, scaled = NO_SCALED] = write;
		if (!morphed || !MorphedChannels.supported) return false;
		// A loop, not `every`: no callback allocated per write.
		for (let i = 0; i < channels.length; i++) if (!morphed.has(channels[i][0])) return false;
		hold.morph = write;
		hold.landed = false;
		this.#morphAxis = bandAxis;
		this.#scaledBindings = scaled;
		// The rows arrive by swapNear of the ride, so the new layout takes over
		// exactly where they are.
		const lead = rebinTuning.swapNear;
		const cut = hold.cut;
		if (cut) {
			// A cut's first morphed write: the rows become the pieces.
			hold.cut = null;
			if (morphed.write(cut.rowIds, channels, land, cut.fromHeld, hold.map, lead)) {
				this.#scheduleBindGroupUpdate();
			}
		} else {
			morphed.write(bandIds, channels, land, null, hold.map, lead);
		}
		// Landing changes buffers the frame's draws bind, so not from inside the
		// encode that notices it: right after it.
		const generation = hold.generation;
		morphed.whenLanding(() => queueMicrotask(() => this.#landed(generation)));
		this.invalidateLayer();
		return true;
	}

	/**
	 * The hold's rows have arrived: close the gaps between siblings, then swap
	 * (#onFadeRest). At once when there are none, or they are closed already
	 * (a later result landed while they closed). Nothing if that hold ended.
	 */
	#landed(generation: number): void {
		const hold = this.#hold;
		if (!hold || hold.generation !== generation || this.#isDestroyed) return;
		hold.landed = true;
		if (!this.#seamsWritten || this.#fadeNow === 0) this.#swap(generation);
		else if (this.#fadeDir !== 'close') this.#startFade('close');
	}

	/** Write the new layout. Nothing if that hold has ended. */
	#swap(generation: number): void {
		const hold = this.#hold;
		if (!hold || hold.generation !== generation || this.#isDestroyed) return;
		if (transitionsObserved()) {
			noteTransition('rebin', false, () => this.#chartsToRedraw(), this.#rendererId, 'swap');
		}
		const morph = hold.morph;
		this.#endHoldNow();
		if (morph) this.writeMorphed(...morph);
	}

	/**
	 * End the hold now: flush what it deferred, then take the current result
	 * against the held layout as a forward map (for the next morphed write)
	 * and commit it.
	 */
	#endHoldNow(): void {
		this.#releaseHold();
		if (!this.#binning) return;
		this.#forward(this.#take(false));
		this.#commit();
	}

	/** A rebin decision, for the transition log: hold (again, during a hold), or forward and why. */
	#noteRebin(decision: RebinDecision): void {
		if (!decision || !transitionsObserved()) return;
		const again = this.#hold ? ' again' : '';
		const detail =
			decision.kind === 'hold'
				? `hold${again}`
				: decision.kind === 'cut'
					? `cut${again}`
					: `forward: ${decision.why}${this.#hold ? ' (ends hold)' : ''}`;
		noteTransition('rebin', false, () => this.#chartsToRedraw(), this.#rendererId, detail);
	}

	/** Stop holding and write every deferred static write and the instance count. */
	#releaseHold(): void {
		const hold = this.#hold;
		if (!hold) return;
		this.#hold = null;
		this.#morphed?.whenLanding(null);
		this.#stopFade();
		this.#dropSeams();
		for (const [binding, data] of hold.attributes) this.writeAttribute(binding, data);
		for (const [slot, data] of hold.vertex) this.writeVertexBuffer(slot, data);
		if (hold.count !== null) this.updateInstanceCount(hold.count);
	}

	/** Seams for the rows about to be drawn, or none (null). */
	#writeSeams(seams: Uint32Array | null): void {
		const slot = this.#binning?.seams;
		if (slot == null) return;
		if (!seams) {
			this.#dropSeams();
			return;
		}
		this.#writeVertexNow(slot, seams);
		this.#seamsWritten = true;
	}

	/**
	 * Seams go with the layout they were written for: the renderer draws
	 * without them (no buffer in the slot) from the next frame. Destroyed now:
	 * a frame that drew with them has been submitted, and WebGPU keeps a
	 * buffer alive for work already submitted.
	 */
	#dropSeams(): void {
		if (!this.#seamsWritten) return;
		this.#seamsWritten = false;
		const slot = this.#binning?.seams;
		if (slot == null) return;
		this.#vertexBuffers.get(slot)?.destroy();
		this.#vertexBuffers.delete(slot);
		this.invalidateLayer();
	}

	/**
	 * Run the seam fade: `open` from 0 (a split's gaps), `close` from 1 (a
	 * hold's, before its swap). Its clock is on the coordinator's loop, which
	 * redraws the mark's charts while it runs; each frame writes the value.
	 */
	#startFade(direction: 'open' | 'close'): void {
		if (!this.#binning?.seamFade) {
			// Nothing to fade: a split shows its gaps, a hold swaps.
			if (direction === 'close') {
				this.#fadeDir = 'close';
				const generation = ++this.#fadeGeneration;
				queueMicrotask(() => this.#onFadeRest(generation));
			}
			return;
		}
		this.#fadeDir = direction;
		this.#setFade(direction === 'open' ? 0 : 1);
		this.#fadeClock ??= new TransitionClock({
			loop: this.#gpuCoordinator,
			stiffness: rebinTuning.seamFadeStiffness,
			precision: SEAM_FADE_PRECISION,
			charts: () => this.#chartsToRedraw(),
			onFrame: this.#onFadeFrame,
			// The fade it ends, by generation: a stop settles the clock too, and
			// a newer fade may have started by the time the microtask runs.
			onRest: () => {
				const generation = this.#fadeGeneration;
				queueMicrotask(() => this.#onFadeRest(generation));
			}
		});
		this.#fadeGeneration++;
		this.#fadeClock.restart();
	}

	/** Each frame of a fade: its value, from the clock. A field: no allocation per frame. */
	#onFadeFrame = (): void => {
		const t = this.#fadeClock?.t ?? 1;
		// No invalidation: the running clock redraws the mark's charts.
		if (this.#fadeDir === 'open') this.#setFade(t, false);
		else if (this.#fadeDir === 'close') this.#setFade(1 - t, false);
	};

	/**
	 * A fade has finished: a split's seams go (its gaps are full, as without
	 * any); a hold that has landed swaps. One whose rows set off again (a
	 * result landed as the gaps closed) waits, closed, for its next landing.
	 */
	#onFadeRest(generation: number): void {
		if (generation !== this.#fadeGeneration) return;
		const direction = this.#fadeDir;
		if (!direction) return;
		this.#fadeDir = null;
		if (direction === 'open') {
			this.#dropSeams();
		} else {
			this.#setFade(0);
			const hold = this.#hold;
			if (hold?.landed) this.#swap(hold.generation);
		}
	}

	/** Stop a running fade where it is (the caller sets what comes next). */
	#stopFade(): void {
		this.#fadeDir = null;
		this.#fadeGeneration++;
		// Off the loop now; its rest is for an ended generation, so it does nothing.
		if (this.#fadeClock?.running) this.#fadeClock.finish();
	}

	/**
	 * The seam fade's value, into the renderer's uniform at the declared
	 * offset: 4 bytes from a held array. Skipped before the uniform exists;
	 * rewritten after the mark writes its uniform (writeUniform).
	 */
	#setFade(value: number, invalidate = true): void {
		this.#fadeNow = value;
		const at = this.#binning?.seamFade;
		const buffer = at ? this.#ownedResources.buffers.get(at.binding) : undefined;
		if (!at || !buffer || !this.#device) return;
		this.#fadeScratch[0] = value;
		this.#device.queue.writeBuffer(buffer, at.offset, this.#fadeScratch);
		if (invalidate) this.invalidateLayer();
	}

	/** The instance count, whatever a hold defers. */
	#setCountNow(count: number): void {
		this.#ensureRecord(count);
		this.#instanceCount = count;
		this.invalidateLayer();
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
		for (const ext of this.#external) ext.bound = ext.get() ?? null;
		const entries = this.#dataBindingConfig.map((config) => {
			const external = this.#external.find((e) => e.binding === config.binding);
			const buffer =
				external?.bound ??
				this.#morphed?.resolved(config.binding) ??
				this.#ownedResources.buffers.get(config.binding);
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
				// Bound to any binding not written yet, uniforms included: as large as
				// the largest uniform struct, or a draw before the first write fails.
				size: UNIFORM_STAND_IN_BYTES,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				label: `${this.#markType}-dummy`
			});
		}
		return this.#dummyBuffer;
	}

	updateInstanceCount(count: number): void {
		this.#beginWrite();
		if (this.#hold) {
			this.#hold.count = count;
			return;
		}
		this.#setCountNow(count);
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
			zIndex: this.#zIndex,
			readsChartScales: this.#readsChartScales,
			space: this.#space
		});
		this.#registerPlacement([chartId]);
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
				zIndex: this.#zIndex,
				readsChartScales: this.#readsChartScales,
				space: this.#space
			});
			this.#facetLayerControls.push({ chartId, control });
			this.#facetChartIds.push(chartId);
		}
		// One placement per cell: each cell's dispatch places that cell's rows
		// with its own frame uniforms (a faceted kernel skips the other cells').
		this.#registerPlacement(chartIds);

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

		this.#hold = null;
		this.#fadeClock?.stop();
		this.#fadeClock = null;
		this.#lastStatic.clear();
		this.#lastVertex.clear();
		// Before the buffers below: it unregisters compute work that reads them.
		this.#morphed?.destroy();
		this.#morphed = null;

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
		for (const key of this.#placementKeys) this.#gpuCoordinator?.removePlacement(key);
		this.#placementKeys = [];
		this.#kernels = [];
		this.#record = null;
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
