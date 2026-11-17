import { untrack } from 'svelte';
import { UNIFORM_STAND_IN_BYTES } from './uniform-sizes';
import type { GPUCoordinator, DataBindingEntry, LayerRegistrationResult } from '$lib/gpu';
import type { ChartContext, WebGPUCanvasContext } from '$lib/types';
import { MorphedChannels, type ClockHost, type ChannelScale } from '$lib/gpu/MorphedChannels';
import {
	cutRows,
	type BinCut,
	type BinGeometry,
	type RebinDecision,
	type RebinSource
} from '$lib/gpu/bin-remap';
import { noteTransition, transitionsObserved } from '$lib/animation/transition-log';

export interface RendererOptions {
	zIndex?: number;
	xScaleType?: string;
	yScaleType?: string;
	/** False for a mark whose shader never reads the chart's x and y scales. */
	readsChartScales?: boolean;
}

export interface InitConfig {
	dataBindingConfig: DataBindingEntry[];
	markShaderCode: string;
	vertexBufferLayout: GPUVertexBufferLayout[];
	rendererDefinition: object;
}

/** Warned once per page, not per mark. */
let warnedMorphUnsupported = false;

/**
 * How far along a hold's rows travel before the swap: the new layout's bars
 * then start at their children's mean and land the rest themselves. At rest
 * (1), converged children stay drawn apart, their insets showing, for the
 * tween's long tail. At 0.75 (chosen on device) the children make most of
 * the movement and land together as the merged bar, and a fast zoom out,
 * whose rebins restart the ride, still reaches the swap. The swap shows as
 * the spread left between siblings, (1 − swapNear) of where they started.
 * Mutable for tuning on device (test pages read `?near=`); read at each
 * hold's write.
 */
export const rebinTuning = { swapNear: 0.75 };

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
	} | null = null;
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

			const scaleTypes = this.#scaleTypes();
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
				this.#gpuCoordinator.releaseRenderer(this.#rendererId);
				return;
			}

			this.#pipeline = result.pipeline;
			this.#perDataLayout = result.dataLayout;
			this.#initConfig = config;
			this.#builtScaleTypes = scaleTypes;
			this.#resourcesCreated = true;

			// Initial empty bind group
			this.#rebuildBindGroup();

			// The specialisation is named because it is otherwise invisible: a mark
			// compiled against the wrong axis logic renders, silently and wrongly.
			console.log(`${this.#markType} renderer initialized (x=${scaleTypes.x}, y=${scaleTypes.y})`);
		} catch (error) {
			if (!this.#isDestroyed && this.#initGeneration === currentGen) {
				console.error(`${this.#markType} initialization failed:`, error);
				throw error;
			}
		}
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
	 * Rebuild the pipeline if the chart's scale types have moved away from the
	 * ones it was compiled against. A no-op otherwise, and cheap: two string
	 * comparisons.
	 *
	 * Called whenever the chart's types change. Two cases reach it — an axis
	 * whose type resolved after this renderer was built (a mark that infers its
	 * scale from the table schema), and one that genuinely changes later,
	 * when a mark joins the chart and MANDATEs a different type.
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
	 */
	async syncScaleTypes(): Promise<void> {
		const config = this.#initConfig;
		const built = this.#builtScaleTypes;
		if (!config || !built || this.#isDestroyed) return;

		const want = this.#scaleTypes();
		if (want.x === built.x && want.y === built.y) return;

		console.warn(
			`[${this.#markType}] rebuilding pipeline: the chart's scales moved from ` +
				`(${built.x}, ${built.y}) to (${want.x}, ${want.y}) after this mark compiled ` +
				`against them. Anything drawn in between used the wrong axis logic.`
		);
		await this.initialize(config);
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
		this.#lastVertex.set(slot, data);

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
		return this.#morphed?.resolved(binding) ?? this.#ownedResources.buffers.get(binding);
	}

	// ===== REBINS =====
	//
	// A binned mark's results follow its rebins (RebinSource, the lifecycle):
	// - A split, or a merge that cannot hold: the new layout is written at
	//   once and its rows start where the old rows they cover were drawn
	//   (forward map), then travel.
	// - A merge into bins that nest the drawn ones HOLDS: the drawn layout
	//   stays (static writes and the instance count are deferred) and its
	//   rows travel to their parent's new value (MorphedChannels' gather),
	//   riding the scale's tween. When they land, the new layout is written
	//   through the forward map, which starts each parent at its children's
	//   mean: where they already are, so the swap does not show.
	// Every result during a hold is taken against the held layout (nothing is
	// committed): a filter result or a further nested merge gathers again,
	// anything else ends the hold and writes the new layout through a
	// forward map from the held one. Ending flushes every deferred write, not
	// only the slots the new result rewrites: a mark rewrites only what
	// changed.
	//
	// The geometry says whether this renderer can hold: `interval` (rows span
	// their bins, so siblings at one height draw as their parent). `point`
	// needs a morphing position and presence first; until then it does not
	// hold and merges go forward.

	/**
	 * Make this renderer's rows follow a binned mark's rebins: `source` says
	 * what each result is relative to the rows on the GPU, `geometry` how
	 * this renderer draws rows over bins. null for a mark that is not binned.
	 * A new source (a rebuilt lifecycle) starts over: its first result has
	 * nothing committed to map from.
	 */
	setBinning(
		source: RebinSource | null,
		geometry: BinGeometry,
		/** The static bindings holding each row's bin edges (lower, upper): a cut writes them. */
		edges: readonly [number, number] | null = null
	): void {
		const b = this.#binning;
		if (
			b?.source === source &&
			b?.geometry === geometry &&
			b?.edges?.[0] === edges?.[0] &&
			b?.edges?.[1] === edges?.[1]
		) {
			return;
		}
		if (this.#hold) this.#releaseHold();
		this.#binning = source ? { source, geometry, edges } : null;
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
			this.#holding(decision.map);
			return;
		}
		if (this.#hold) this.#releaseHold();
		this.#pendingRemap = decision?.kind === 'forward' ? decision.map : null;
		this.#commit();
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

	/** Hold (or keep holding) with this gather map; the hold's deferred writes are kept. */
	#holding(map: Uint32Array): Hold {
		if (this.#hold) {
			this.#hold.map = map;
			this.#hold.cut = null;
			return this.#hold;
		}
		this.#hold = {
			map,
			cut: null,
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
		const hold = this.#holding(cut.fromNew);
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
		this.#morphAxis = bandAxis;
		this.#scaledBindings = scaled;
		const cut = hold.cut;
		if (cut) {
			// A cut's first morphed write: the rows become the pieces.
			hold.cut = null;
			if (morphed.write(cut.rowIds, channels, land, cut.fromHeld, hold.map)) {
				this.#scheduleBindGroupUpdate();
			}
		} else {
			morphed.write(bandIds, channels, land, null, hold.map);
		}
		// The swap writes buffers the frame's draws bind, so not from inside the
		// encode that notices the landing: right after it, one frame later.
		const generation = hold.generation;
		morphed.whenLanding(() => queueMicrotask(() => this.#swap(generation)), rebinTuning.swapNear);
		this.invalidateLayer();
		return true;
	}

	/** The hold's rows have landed: write the new layout. Nothing if that hold has ended. */
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
		const decision = this.#take(false);
		this.#pendingRemap = decision?.kind === 'forward' ? decision.map : null;
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
		for (const [binding, data] of hold.attributes) this.writeAttribute(binding, data);
		for (const [slot, data] of hold.vertex) this.writeVertexBuffer(slot, data);
		if (hold.count !== null) this.updateInstanceCount(hold.count);
	}

	/** The instance count, whatever a hold defers. */
	#setCountNow(count: number): void {
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
		const entries = this.#dataBindingConfig.map((config) => {
			const buffer =
				this.#morphed?.resolved(config.binding) ?? this.#ownedResources.buffers.get(config.binding);
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
			readsChartScales: this.#readsChartScales
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
				zIndex: this.#zIndex,
				readsChartScales: this.#readsChartScales
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

		this.#hold = null;
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
