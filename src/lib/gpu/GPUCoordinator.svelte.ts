import { setContext, getContext } from 'svelte';
import { AnimationLoop } from '$lib/animation';
import { scaleTemplateSystem, CHART_SCALE_IMMEDIATE_SIZE } from './ScaleTemplateSystem';
import type { RendererDefinition } from './ScaleTemplateSystem';
import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
import type { FieldActivity } from '$lib/query-engine/FieldActivity.svelte';
import { isCategoricalScale } from '$lib/scales/scale-categories';
import { MAX_SIZE_SLOTS } from './SizeScaleShaderLib';
import { RESOLVE_IMMEDIATE_SIZE, RESOLVE_WORKGROUP, resolvePipelineFor } from './ResolveShader';
import {
	IDENTITY_SLOT_CAPACITY,
	IDENTITY_SLOT_EMPTY,
	createIdentitySlotState,
	packIdentitySlots,
	type IdentitySlotScale,
	type SlotSource,
	type IdentitySlotState
} from './identity-slot-packing';
import { frameUniformIsStale } from './frame-uniform-sync';
import { immediatesSupported, IMMEDIATES_MISSING_MESSAGE } from './immediates';
import {
	COLOR_CONFIG_BYTES,
	COLOR_CONFIG_SLOT_BASE_OFFSET,
	MAX_COLOR_SLOTS
} from './ColorScaleShaderLib';
import { trackScalesById } from './tracked-scales';

/** Number of color stops per ramp slot. Shared with ColorScaleState for bakeGradient(). */
export const COLOR_RAMP_RESOLUTION = 256;

// =============================================================================
// TYPE INTERFACES
// =============================================================================

interface ChartConfig {
	chartId: string;
	canvas: HTMLCanvasElement;
	zIndex: number;
	/** This cell's DISPLAY position in the facet grid. */
	facetIndex: number;
	/**
	 * The facet BandScaleState itself, not its id.
	 *
	 * An id would mean a registry lookup, and a facet scale is not in the
	 * registry by the time this matters: ScaleRegistry.deregisterChart deletes
	 * it from scaleUsage and storage when its chart-id usage hits zero, which a
	 * faceted container always triggers when it stops being one chart and
	 * becomes a grid. The instance survives — the container and the cells hold
	 * it — but nothing can look it up. Holding the reference is what makes the
	 * per-cell facet value resolvable at all.
	 */
	facetScale: FacetScaleRef | null;
	/** Last _version whose value was written into this chart's uniform. */
	_facetVersion: number;
	visible: boolean;
	context: GPUCanvasContext;
	contextConfigured: boolean;
	layers: Map<string, LayerConfig>;
	renderPlan: LayerConfig[];
	needsPlanRebuild: boolean;
	xScaleId: string | null;
	yScaleId: string | null;
	frameUniformsBuffer: GPUBuffer | null;
	perFrameBindGroup: GPUBindGroup | null;
	renderPassDescriptor: GPURenderPassDescriptor | null;
	msaa: { texture: GPUTexture; view: GPUTextureView } | null;
	_lastRenderFrame: number;
	_isDirty: boolean;
}

interface LayerConfig {
	id: string;
	draw: (passEncoder: GPURenderPassEncoder) => void;
	markType: string;
	renderer: { pipeline: GPURenderPipeline | null; perDataBindGroup: GPUBindGroup | null };
	componentId?: string;
	zIndex: number;
	cachedPipeline?: GPURenderPipeline | null;
	/**
	 * Whether the layer's shader reads the chart's x and y scales. False for a
	 * mark that brings scales of its own — parallel coordinates, one per axis —
	 * and so draws in a chart that has no y scale at all. Unset means true.
	 */
	readsChartScales?: boolean;
}

/**
 * A layer draws once its data is bound, and — when it reads the chart's scales
 * — once both are known. One missing a scale draws nothing rather than through
 * a guess; one that never reads them is not held back by their absence.
 */
function layerCanDraw(layer: LayerConfig, chartScalesKnown: boolean): boolean {
	return (
		!!layer.renderer?.perDataBindGroup && (chartScalesKnown || layer.readsChartScales === false)
	);
}

export interface DataBindingEntry {
	binding: number;
	visibility?: number;
	type?: string;
}

/**
 * What the fixed-timestep loop actually requires of a participant.
 *
 * Four methods and a list of charts to redraw. Notably NOT `id`, `type` or any
 * GPU state: those belong to a scale, and the loop has never read them. Keeping
 * this separate from `ScaleInstance` is what lets a mark drive a transition —
 * a data update it owns, with no scale to hang it on.
 */
export interface AnimatedSource {
	step: () => void;
	updateRenderState: (dt: number) => void;
	isAtRest: () => boolean;
	_markAtRest: () => void;
	/** Applied before the physics step, for sources that consume queued input. */
	_applyInput?: () => void;
	/** Charts to redraw while this is running. */
	_affectedChartsArray?: string[];
}

interface ScaleInstance extends AnimatedSource {
	id: string;
	type: string;
	constructor: { name: string };
	gpuState?: { domainMin: number; domainMax: number; domainScale: number; p4: number };
	getConfig?: () => { categoryCount: number; paddingInner: number; paddingOuter: number };
}

/**
 * A mark's own list of scales, as one uniform the shader indexes: parallel
 * coordinates, one scale per axis. The coordinator fills it on frames the
 * mark's chart draws, through the same writer as a chart's immediates, and
 * uploads only when a value moved.
 */
export interface ScaleBlock {
	scaleIds: readonly string[];
	/** Read each frame, so a renderer that reallocates is followed. */
	buffer: () => GPUBuffer | undefined;
}

interface ScaleBlockEntry extends ScaleBlock {
	/** This frame's params, four floats per scale. */
	view: Float32Array;
	/** What the buffer holds; NaN until the first upload. */
	last: Float32Array;
}

type ComputeWorkFn = (commandEncoder: GPUCommandEncoder) => void;

interface ComputeWork {
	fn: ComputeWorkFn;
	/** The chart whose draw reads the result; the work runs only on frames it draws. */
	chartId: string | null;
}
type FrameCallback = (isAnimating: boolean) => void;

interface GPUCoordinatorConfig {
	msaaSampleCount?: number;
}

/**
 * A scale that carries its slot-table base in its own uploaded config, rather
 * than in the p4 the coordinator refills every frame.
 *
 * It is told its base and decides what to do with it — including whether the
 * base moved at all, which is why nothing here caches what was last handed out.
 */
interface SlotBaseConsumer {
	setSlotBase(base: number): void;
}

/** No fields to pack, for a coordinator without filter groups. */
const NO_FIELDS: readonly FieldActivity[] = [];

/** What the coordinator needs from a facet scale: which id sits at a cell. */
export interface FacetScaleRef {
	idAtSlot(slot: number): number | null;
	/** Bumped whenever the permutation could have moved. */
	readonly _version: number;
}

interface ChartRegistrationConfig {
	zIndex?: number;
	facetIndex?: number;
	facetScale?: FacetScaleRef | null;
}

/**
 * One chart's pixels as the coordinator rendered them, for the scale-source
 * parity check. Tightly packed rows in the canvas's own format.
 */
export interface ChartCapture {
	width: number;
	height: number;
	pixels: Uint8Array;
	/** Whether the pass issued any draw. A chart can be blank for two reasons. */
	drew: boolean;
}

interface PendingCapture {
	canvas: HTMLCanvasElement;
	buffer: GPUBuffer;
	width: number;
	height: number;
	bytesPerRow: number;
	drew: boolean;
}

interface CaptureRequest {
	resolve: (captures: Map<HTMLCanvasElement, ChartCapture>) => void;
	reject: (error: unknown) => void;
	copies: PendingCapture[];
}

export interface ChartRegistrationResult {
	setContextReady: () => void;
	setVisible: (visible: boolean) => void;
	invalidate: () => void;
	remove: () => void;
}

export interface LayerRegistrationResult {
	remove: () => void;
}

interface PipelineResult {
	pipeline: GPURenderPipeline;
	frameLayout: GPUBindGroupLayout;
	dataLayout: GPUBindGroupLayout;
}

// =============================================================================
// HELPER CLASSES
// =============================================================================

/**
 * Rolling average calculator for performance metrics.
 * Filters out negative/invalid values (important for GPU timestamps).
 */
class NonNegativeRollingAverage {
	#total = 0;
	#samples: number[] = [];
	#cursor = 0;
	#numSamples;

	constructor(numSamples: number = 120) {
		this.#numSamples = numSamples;
	}

	addSample(v: number): void {
		if (!Number.isNaN(v) && Number.isFinite(v) && v >= 0) {
			this.#total += v - (this.#samples[this.#cursor] || 0);
			this.#samples[this.#cursor] = v;
			this.#cursor = (this.#cursor + 1) % this.#numSamples;
		}
	}

	get(): number {
		return this.#samples.length > 0 ? this.#total / this.#samples.length : 0;
	}
}

// =============================================================================
// GPU COORDINATOR
// =============================================================================

/**
 * GPUCoordinator manages WebGPU resources and coordinates rendering across charts.
 *
 * Key responsibilities:
 * - WebGPU device/context management
 * - Shared pipeline and resource caching with ref-counting
 * - Registry pattern for tracking renderer → resource ownership
 * - Animation loop with fixed-timestep physics
 * - Scale params into shaders: a chart's as immediates, per pass
 * - Multi-chart render coordination
 */
export class GPUCoordinator {
	// =========================================================================
	// CORE WEBGPU RESOURCES (Raw fields, no $state overhead)
	// =========================================================================
	#device: GPUDevice | null = null;
	#presentationFormat: GPUTextureFormat | null = null;
	#initialized = $state(false);

	// Promise-based initialization (eliminates polling in WebGPUCanvas)
	#readyPromise: Promise<boolean>;
	#resolveReady!: (value: boolean) => void;

	// Timestamp query resources (optional, for GPU timing)
	#canTimestamp = false;
	#querySet: GPUQuerySet | null = null;
	#resolveBuffer: GPUBuffer | null = null;
	#resultBuffer: GPUBuffer | null = null;

	// =========================================================================
	// RESOURCE REGISTRY (Renderer → Resources tracking)
	// =========================================================================
	// Maps rendererId → Map<resourceKey, {type, key}>
	// This is the single source of truth for "who owns what"
	#rendererRegistry = new Map<string, Map<string, { type: string; key: string }>>();

	// =========================================================================
	// SHARED RESOURCES (Reference Counted)
	// =========================================================================
	#sharedResources = {
		pipelines: new Map<
			string,
			{ pipeline: GPURenderPipeline; refCount: number; createdAt: number }
		>(), // key -> { pipeline, refCount }
		shaderModules: new Map<
			string,
			{ module: GPUShaderModule; refCount: number; createdAt: number }
		>(), // key -> { module, refCount }
		bindGroupLayouts: new Map<string, { layout: GPUBindGroupLayout; refCount: number }>() // key -> { layout, refCount }
	};

	// =========================================================================
	// CHART MANAGEMENT
	// =========================================================================
	#registeredCharts = new Map<string, ChartConfig>(); // chartId -> chartConfig
	// #msaaCache = new Map(); // chartId -> { texture, view }
	#dirtyChartsArray: ChartConfig[] = [];
	#retainedRenderers = new Map<string, { destroy: () => void }>();
	#pendingReleases: { destroy: () => void }[] = [];
	#msaaSampleCount = 1;

	// =========================================================================
	// ANIMATION SYSTEM
	// =========================================================================
	#animationLoop: AnimationLoop | null = null;
	/**
	 * Everything the fixed-timestep loop is currently driving.
	 *
	 * Scales, and anything else that animates. The loop has only ever used four
	 * methods and a redraw list, so the list was never really about scales — but
	 * the way to JOIN it was, because `addAnimatingScale` allocates a scale
	 * parameter slot, which a mark has no use for. `addAnimatedSource` is the
	 * same list without that step, so a mark can drive a transition of its own
	 * when there is no categorical scale to adopt a clock from.
	 */
	#animatedSources = new Set<AnimatedSource>(); // Set for O(1) membership check
	#animatedSourcesArray: AnimatedSource[] = []; // Array for O(1) iteration (no allocation)
	#scaleRegistry: ScaleRegistry | null = null;
	#filterGroups: FilterGroupRegistry | null = null;

	// =========================================================================
	// HOVER STATE (Keep loop warm while any chart is hovered)
	// =========================================================================
	#hoveredCharts = new Set<string>();

	// =========================================================================
	// VIEWPORT VISIBILITY (IntersectionObserver + Page Visibility API)
	// =========================================================================
	#visibilityObserver: IntersectionObserver | null = null;
	#observedElements = new Map<string, HTMLElement>(); // chartId -> element
	#visibilityCallbacks = new Map<string, (visible: boolean) => void>();
	#chartIOVisible = new Map<string, boolean>(); // per-chart IO state
	#pageVisible = true;
	#boundPageVisibilityHandler: (() => void) | null = null;

	// =========================================================================
	// PER-FRAME CALLBACKS (for tooltip scheduling, etc.)
	// =========================================================================
	#frameCallbacks: FrameCallback[] = [];
	#isAnimating = false; // True when scales are actively animating (pan/zoom)

	// =========================================================================
	// PRE-RENDER COMPUTE WORK (M4 decimation, etc.)
	// =========================================================================
	#computeWork = new Map<string, ComputeWork>();
	#scaleBlocks = new Map<string, Set<ScaleBlockEntry>>(); // chartId -> its marks' scale blocks

	// =========================================================================
	// SHARED SCALE RESOURCES (@group(2))
	// =========================================================================
	/**
	 * What every chart and mark shares: colour configs, ramps and palettes,
	 * size configs, and the resolved band slot table. Each buffer is created
	 * once and written on change, so one bind group serves every pass.
	 */
	#scaleResourcesLayout: GPUBindGroupLayout | null = null;
	#scaleResourcesBindGroup: GPUBindGroup | null = null;
	/**
	 * Band identity id -> display slot, shared by every band and point scale at
	 * a per-scale base carried in that scale's p4. This is the `from` half.
	 *
	 * The block layout is owned by identity-slot-packing.ts, which writes it;
	 * see that file rather than a restatement here.
	 */
	#identitySlotBuffer: GPUBuffer | null = null;
	/**
	 * The `to` half. Same size, same per-scale bases, written from the same pack.
	 * The resolve pass mixes the two with each scale's t as an immediate, so a
	 * reorder in flight uploads nothing per frame.
	 */
	#identitySlotBufferTo: GPUBuffer | null = null;
	/**
	 * CPU mirror plus the per-scale bases and versions. Allocation lives in
	 * identity-slot-packing.ts; this class owns only the GPU buffer and the upload.
	 */
	#identitySlots: IdentitySlotState | null = null;
	/** Reused per frame so the hot path allocates nothing. */
	#identitySlotScales: IdentitySlotScale[] = [];
	#identitySlotEntryPool: IdentitySlotScale[] = [];
	/** Index-aligned with #identitySlotScales. Reused; null where not applicable. */
	#slotBaseConsumers: (SlotBaseConsumer | null)[] = [];
	/** Reused for the four-byte config patch. */
	#slotBasePatch = new Uint32Array(1);

	/** What the render stages read: `mix(from, to, t)`, written by compute. */
	#identitySlotResolved: GPUBuffer | null = null;
	#slotResolveBindGroup: GPUBindGroup | null = null;
	/** Built once; encoded on every frame a t or table moves. */
	#slotResolvePassDescriptor: GPUComputePassDescriptor = { label: 'slot-resolve' };
	/** `count`, `t`, `offset` for each block's dispatch, pushed as immediates. */
	#slotResolveImmediates = new ArrayBuffer(RESOLVE_IMMEDIATE_SIZE);
	#slotResolveImmediatesView = new DataView(this.#slotResolveImmediates);

	#scaleIdToInstance = new Map<string, ScaleInstance>(); // scaleId -> scale instance
	/** The same scales as a flat array, for loops that run every frame. */
	#scales: ScaleInstance[] = [];

	#frameId = 0;

	// =========================================================================
	// COLOR BUFFER DECLARATIONS
	// =========================================================================
	// Color scale buffers (group 2, bindings 1-3)
	#colorConfigBuffer: GPUBuffer | null = null; // 64 configs × 48 bytes = 3KB
	#colorRampBuffer: GPUBuffer | null = null; // 64 ramps × 256 colors × 16 bytes = 256KB
	#colorPaletteBuffer: GPUBuffer | null = null; // 64 palettes × 32 colors × 16 bytes = 32KB

	// Size scale buffer (group 2, binding 4). UNIFORM, not storage — see
	// SIZE_SCALE_BINDINGS for why, and for what it buys.
	#sizeConfigBuffer: GPUBuffer | null = null; // MAX_SIZE_SLOTS × 16 bytes = 1KB
	#maxSizeSlots = MAX_SIZE_SLOTS;

	// Constants
	#maxColorSlots = MAX_COLOR_SLOTS;
	#rampColorsPerSlot = COLOR_RAMP_RESOLUTION;
	#paletteColorsPerSlot = 32;

	// =========================================================================
	// LAYOUT CACHES
	// =========================================================================
	#frameLayout: GPUBindGroupLayout | null = null;
	#dataLayouts = new Map<string, GPUBindGroupLayout>(); // markType-config -> GPUBindGroupLayout

	// =========================================================================
	// PENDING OPERATIONS
	// =========================================================================
	#pendingScaleMappings = new Map<string, { xScaleId: string; yScaleId: string }>(); // chartId -> { xScaleId, yScaleId }
	#pendingFrameUpdates = new Map<string, { timestamp: number }>(); // chartId -> update params
	#pendingLayers = new Map<string, LayerConfig[]>(); // chartId -> [{ layerConfig, layerId }]
	#topologyUpdateScheduled = false;

	// =========================================================================
	// RENDER LOOP STATE (Zero-Allocation)
	// =========================================================================
	#chartsToRenderArray: ChartConfig[] = []; // Reused array for charts to render
	/**
	 * This frame's swapchain views, INDEX-ALIGNED with the charts being
	 * rendered, and valid only within one `#coordinatedRender`.
	 *
	 * Acquisition is separated from encoding because `getCurrentTexture` is the
	 * call that can block on the compositor, and doing all of them up front
	 * keeps that out of the middle of command encoding.
	 *
	 * Not a list of `{ chart, view }` pairs. The mapping is 1:1 and dense, so
	 * the chart is already addressable by the same index and the pair was an
	 * object per chart per frame for nothing — under a banner promising zero
	 * allocation. It also carried the GPUTexture, which nothing ever read.
	 *
	 * Deliberately NOT the `#identitySlotEntryPool` idiom, which exists one
	 * function away for a list that is FILTERED — entries there have no
	 * index to align with, so a pooled object is the cheapest thing available.
	 * Here there is an index, so the right number of objects is none.
	 */
	#acquiredViews: (GPUTextureView | null)[] = [];
	#encoderDescriptor = { label: 'frame-encoder' };
	#submitArray: [GPUCommandBuffer | null] = [null]; // Reused array for queue.submit()
	#framesInFlight = 0;
	#maxFramesInFlight = 2; // Double-buffering: allow 2 frames in flight

	// =========================================================================
	// PERFORMANCE TRACKING (used for debugging — accessed via dev console)
	// =========================================================================
	// eslint-disable-next-line no-unused-private-class-members
	#fpsAverage = new NonNegativeRollingAverage(30);
	// eslint-disable-next-line no-unused-private-class-members
	#cpuAverage = new NonNegativeRollingAverage(30);
	// eslint-disable-next-line no-unused-private-class-members
	#gpuAverage = new NonNegativeRollingAverage(30);
	timings = $state({ cpu: '0', fps: '0', gpu: '0' });

	// Promise cache for pipeline creation (prevents "thundering herd")
	#pipelineCreationPromises = new Map<string, Promise<GPURenderPipeline>>();

	// =========================================================================
	// CONSTRUCTOR
	// =========================================================================

	constructor(config: GPUCoordinatorConfig = {}) {
		this.#msaaSampleCount = config.msaaSampleCount ?? 4;

		// Create ready promise (resolved when WebGPU initialization completes)
		this.#readyPromise = new Promise((resolve) => {
			this.#resolveReady = resolve;
		});

		// Create animation loop with callbacks
		this.#animationLoop = new AnimationLoop({
			onPhysicsStep: this.#physicsStep,
			onRender: this.#renderFrame,
			onIdleCheck: this.#idleCheck
		});

		// Viewport visibility observer — shared across all charts.
		// rootMargin provides 200px lookahead so charts pre-warm before scrolling into view.
		if (typeof IntersectionObserver !== 'undefined') {
			this.#visibilityObserver = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						const chartId = (entry.target as HTMLElement).dataset.chartId;
						if (chartId) this.#handleVisibilityChange(chartId, entry.isIntersecting);
					}
				},
				{ rootMargin: '200px' }
			);
		}

		// Page Visibility API — pause all charts when tab is hidden
		if (typeof document !== 'undefined') {
			this.#boundPageVisibilityHandler = () => {
				this.#pageVisible = !document.hidden;
				for (const [chartId, ioVisible] of this.#chartIOVisible) {
					this.#applyVisibility(chartId, this.#pageVisible && ioVisible);
				}
			};
			document.addEventListener('visibilitychange', this.#boundPageVisibilityHandler);
		}
	}

	// =========================================================================
	// INITIALIZATION
	// =========================================================================

	async initialize(): Promise<void> {
		if (this.#initialized) return;

		try {
			await this.#initWebGPU();
			await this.#initializeScaleBindGroupLayouts();

			this.#initialized = true;
			this.#handleScaleTopologyChange();
			// this.#createColorScaleBuffers();

			console.log('GPUCoordinator initialized with Registry Pattern');
		} catch (error) {
			console.error('GPUCoordinator initialization failed:', error);
			throw error;
		}
	}

	async #initWebGPU(): Promise<void> {
		if (typeof window === 'undefined' || typeof navigator === 'undefined') {
			throw new Error('WebGPU initialization attempted server-side');
		}

		if (!navigator.gpu) {
			throw new Error('WebGPU not supported');
		}

		const adapter = await navigator.gpu.requestAdapter({
			powerPreference: 'high-performance'
		});

		if (!adapter) {
			throw new Error('No appropriate GPUAdapter found');
		}

		this.#canTimestamp = adapter.features.has('timestamp-query');

		// Before any pipeline is built. Both resolve kernels declare
		// `requires immediate_address_space`, and a device that cannot compile
		// them produces an invalid pipeline, an encoder poisoned by the dispatch
		// that uses it, and a blank canvas — with only a WGSL feature name to go
		// on. See immediates.ts for why the floor is deliberate.
		if (!immediatesSupported()) {
			throw new Error(IMMEDIATES_MISSING_MESSAGE);
		}

		this.#device = await adapter.requestDevice({
			requiredFeatures: this.#canTimestamp ? ['timestamp-query'] : []
		});

		this.#presentationFormat = navigator.gpu.getPreferredCanvasFormat();

		// Setup timestamp query resources if available
		if (this.#canTimestamp) {
			this.#querySet = this.#device.createQuerySet({
				type: 'timestamp',
				count: 2
			});

			this.#resolveBuffer = this.#device.createBuffer({
				size: this.#querySet.count * 8,
				usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
			});

			this.#resultBuffer = this.#device.createBuffer({
				size: this.#resolveBuffer.size,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
			});
		}

		// Signal that initialization is complete
		this.#resolveReady(true);
	}

	// =========================================================================
	// SHARED SCALE RESOURCES
	// =========================================================================

	/**
	 * Binding 0 was the global scale table; a chart's scales now arrive as
	 * immediates, M4's and parallel coordinates' through their own. The rest
	 * keep their numbers, so no shader that reads them changed.
	 */
	async #initializeScaleBindGroupLayouts(): Promise<void> {
		this.#scaleResourcesLayout = this.#device!.createBindGroupLayout({
			label: 'scale-resources-layout',
			entries: [
				{
					// Binding 1: Color scale configs.
					//
					// Uniform, and visible to the VERTEX stage as well: selection
					// dimming reads a colour scale's slotBase per vertex. As storage
					// it would take the last of the vertex stage's default 8 storage
					// buffers on Rects, which uses 7; as a uniform it counts against
					// the separate uniform limit and leaves that slot free. Same move
					// as binding 4.
					binding: 1,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: 'uniform' }
				},
				{
					// Binding 2: Color ramps (fragment only)
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT, // ← Changed
					buffer: { type: 'read-only-storage' }
				},
				{
					// Binding 3: Ordinal palettes (fragment only)
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT, // ← Changed
					buffer: { type: 'read-only-storage' }
				},
				{
					// Binding 4: Size scale configs (vertex only).
					//
					// Uniform rather than storage. 1 KB of 16-byte configs written on
					// a domain change, which is what uniform buffers are for — and it
					// returns a slot to the vertex stage's storage budget, which sits
					// at the default 8 and has to fit a `from` and a `to` per animated
					// value channel.
					//
					binding: 4,
					visibility: GPUShaderStage.VERTEX,
					buffer: { type: 'uniform' }
				},
				{
					// Binding 5: the RESOLVED slot table — identity id -> where that
					// id is right now. A compute pass writes it once per frame from
					// `from`, `to` and each block's `t`; the render stages read this one
					// buffer and do no interpolation.
					//
					// Storage, where it used to be two uniforms. It costs the vertex
					// stage one binding where the pair cost none — Rects lands at 7 of
					// the default maxStorageBuffersPerShaderStage of 8, its six channels
					// and this — and in exchange
					// the vec4 packing, the 64 KB uniform binding cap and the
					// 16384-float global ceiling all go away with the address space.
					//
					// `from` and `to` are not here at all any more. They are bound to
					// the compute pipeline, which has its own budget.
					//
					// FRAGMENT as well as VERTEX: band axes resolve a slot in the
					// vertex stage, and ordinal colour resolves its palette rank in
					// the fragment stage. Both read their selection activity, the
					// second half of each block, in the vertex stage.
					binding: 5,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: 'read-only-storage' }
				}
			]
		});

		// Create color scale buffers (must happen before bind group creation)
		this.#createColorScaleBuffers();
		this.#createIdentitySlotBuffer();

		this.#scaleResourcesBindGroup = this.#device!.createBindGroup({
			label: 'scale-resources',
			layout: this.#scaleResourcesLayout,
			entries: [
				{ binding: 1, resource: { buffer: this.#colorConfigBuffer! } },
				{ binding: 2, resource: { buffer: this.#colorRampBuffer! } },
				{ binding: 3, resource: { buffer: this.#colorPaletteBuffer! } },
				{ binding: 4, resource: { buffer: this.#sizeConfigBuffer! } },
				// The resolved slot table, written by the compute pass.
				{ binding: 5, resource: { buffer: this.#identitySlotResolved! } }
			]
		});
	}

	#createColorScaleBuffers(): void {
		const device = this.#device!;

		// ColorConfig buffer: 64 slots × 48 bytes each. A uniform, so the vertex
		// stage can read it without a storage binding — see COLOR_SCALE_BINDINGS.
		this.#colorConfigBuffer = device.createBuffer({
			label: 'ColorConfig uniform',
			size: this.#maxColorSlots * COLOR_CONFIG_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});

		// Color ramp buffer: 64 slots × 256 colors × 4 floats × 4 bytes
		this.#colorRampBuffer = device.createBuffer({
			label: 'ColorRamp SSBO',
			size: this.#maxColorSlots * this.#rampColorsPerSlot * 4 * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});

		// Ordinal palette buffer: 64 slots × 32 colors × 4 floats × 4 bytes
		this.#colorPaletteBuffer = device.createBuffer({
			label: 'OrdinalPalette SSBO',
			size: this.#maxColorSlots * this.#paletteColorsPerSlot * 4 * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});

		// Size config buffer: MAX_SIZE_SLOTS slots × 16 bytes each. The size is
		// not just an allocation any more — a uniform array is declared at a fixed
		// length, so the bound buffer must be at least that big or pipeline
		// creation fails. Both come from the same constant.
		this.#sizeConfigBuffer = device.createBuffer({
			label: 'SizeConfig uniform',
			size: this.#maxSizeSlots * 16,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
	}

	/**
	 * Fill CPU buffer with current scale GPU state.
	 * Zero-allocation hot path.
	 */
	/**
	 * Buffers for the slot table and its per-frame resolve.
	 *
	 * `from` and `to` are compute-stage inputs; `resolved` is what the render
	 * stages bind. The pipeline is the shared resolve kernel's, the same one a
	 * mark's morphing channels use.
	 *
	 * Nothing ever dispatches over the permanent empty block, so `resolved`
	 * relies on WebGPU zero-initialising a new buffer for that block's count of
	 * 0 — which the spec guarantees, and which is exactly what a parked scale
	 * must read.
	 */
	#createIdentitySlotBuffer(): void {
		if (this.#identitySlotBuffer) return;
		const device = this.#device!;
		const bytes = IDENTITY_SLOT_CAPACITY * 4;
		this.#identitySlots = createIdentitySlotState(IDENTITY_SLOT_CAPACITY);

		const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
		this.#identitySlotBuffer = device.createBuffer({
			label: 'identity-slot-table-from',
			size: bytes,
			usage: storage
		});
		this.#identitySlotBufferTo = device.createBuffer({
			label: 'identity-slot-table-to',
			size: bytes,
			usage: storage
		});
		this.#identitySlotResolved = device.createBuffer({
			label: 'identity-slot-table-resolved',
			size: bytes,
			usage: GPUBufferUsage.STORAGE
		});
		this.#slotResolveBindGroup = device.createBindGroup({
			label: 'slot-resolve-bind-group',
			layout: resolvePipelineFor(device).layout,
			entries: [
				{ binding: 0, resource: { buffer: this.#identitySlotBuffer } },
				{ binding: 1, resource: { buffer: this.#identitySlotBufferTo } },
				{ binding: 2, resource: { buffer: this.#identitySlotResolved } }
			]
		});
	}

	/**
	 * Encode the resolve: one dispatch per block the pack listed, each with its
	 * own `count`, `t` and `offset`.
	 *
	 * A block is listed when its table was rewritten or its `t` moved. Settling
	 * is one of those — t lands on 1 and the table is repacked — so the final
	 * position is resolved without a special case, and a frame where nothing
	 * moved (a pan, a hover, another mark's own animation) dispatches nothing.
	 *
	 * Reads the pack from this same frame: #updateIdentitySlots runs first in
	 * #coordinatedRender, and the list is overwritten by the next pack.
	 */
	#encodeSlotResolve(encoder: GPUCommandEncoder): void {
		const state = this.#identitySlots;
		if (!state) return;
		const { resolves, resolveCount } = state.result;
		if (resolveCount === 0) return;

		const immediates = this.#slotResolveImmediatesView;
		const pass = encoder.beginComputePass(this.#slotResolvePassDescriptor);
		pass.setPipeline(resolvePipelineFor(this.#device!).pipeline);
		pass.setBindGroup(0, this.#slotResolveBindGroup!);
		for (let i = 0; i < resolveCount; i++) {
			const block = resolves[i];
			immediates.setUint32(0, block.length, true);
			immediates.setFloat32(4, block.t, true);
			immediates.setUint32(8, block.base, true);
			pass.setImmediates(0, this.#slotResolveImmediates);
			pass.dispatchWorkgroups(Math.ceil(block.length / RESOLVE_WORKGROUP));
		}
		pass.end();
	}

	/**
	 * Pack every band/point scale's slot table into the shared buffer and assign
	 * each one an offset, which #writeScaleParam then writes into its p4.
	 *
	 * Uploads only the range that moved: slot tables change on reorder, not per
	 * frame, so a static chart costs no writeBuffer here, and neither does an
	 * animating one — its `t` goes to the resolve as an immediate. Offsets are
	 * recomputed every call because a scale appearing or disappearing shifts
	 * the ones after it — cheap, since it is a running sum over a handful of
	 * scales.
	 */
	#updateIdentitySlots(): void {
		const state = this.#identitySlots;
		if (!state) return;

		// Collect this frame's band/point scales into the reused array. The
		// packing itself is pure — see identity-slot-packing.ts, which is where the
		// allocator, the capacity fallback and the eviction sweep are tested.
		// Entries are pooled and overwritten in place: this runs every frame, and
		// an object per scale per frame is garbage for nothing.
		const scales = this.#identitySlotScales;
		const pool = this.#identitySlotEntryPool;
		scales.length = 0;
		const consumers = this.#slotBaseConsumers;
		consumers.length = 0;
		for (let i = 0; i < this.#scales.length; i++) {
			const scale = this.#scales[i] as unknown as {
				id: string;
				slots?: SlotSource;
				identityKey?: string | null;
			};
			// Any scale that offers slots wants them packed. It used to gate on
			// band|point, which was the same set at the time; ordinal colour offers
			// them now, and gating on the type would have meant listing every kind
			// here as each migrates.
			const slots = scale.slots;
			if (!slots) continue;
			const entry = (pool[scales.length] ??= { id: '', slots, field: null });
			entry.id = scale.id;
			entry.slots = slots;
			// The field whose activity block this scale's header points at. Every
			// field a scale draws has one, so a selection moves nothing; the
			// registry creates its FieldActivity once (a Map lookup after that).
			const field = scale.identityKey ?? null;
			entry.field = field;
			if (field) this.#filterGroups?.field(field);
			scales.push(entry);
			// Index-aligned with `scales`, so the base can be handed back after
			// packing without searching for the instance again.
			consumers.push(
				(scale as unknown as SlotBaseConsumer).setSlotBase
					? (scale as unknown as SlotBaseConsumer)
					: null
			);
		}

		// Every field follows its live identity here, where nothing is reactive:
		// a reload snaps its fades, a grown dim extends them. Two comparisons a
		// field when nothing moved.
		const registry = this.#filterGroups;
		const fields = registry?.fields ?? NO_FIELDS;
		for (let i = 0; i < fields.length; i++) fields[i].reconcile();

		const { uploadStart, uploadEnd } = packIdentitySlots(
			scales,
			state,
			fields,
			registry?.groupCount ?? 0
		);

		// Hand back the base to any scale that reads it from its own config rather
		// than from p4. A band scale's base is refilled into p4 every frame; an
		// ordinal colour scale's lives in a config uploaded only when the scale
		// changes, so it patches the four bytes itself. Without that a colour
		// scale keeps a base that belonged to it before a neighbour resized, and
		// reads another scale's ranks.
		//
		// Told unconditionally, because whether the base actually moved is the
		// scale's own state to compare — it holds the last one it was given, and
		// an instance that has never received one cannot match. Deduplicating
		// here instead meant a cache of another object's field, on an object
		// owned by neither.
		//
		// Walks the parallel array captured during collection rather than
		// searching #scales per entry: this runs every frame.
		for (let i = 0; i < consumers.length; i++) {
			const scale = consumers[i];
			if (!scale) continue;
			const base = state.offsets.get(scales[i].id);
			if (base === undefined) continue;
			scale.setSlotBase(base);
		}

		if (uploadEnd === 0) return;

		const queue = this.#device!.queue;
		const bytes = uploadStart * 4;
		const size = uploadEnd - uploadStart;
		queue.writeBuffer(
			this.#identitySlotBuffer!,
			bytes,
			state.buffer as Float32Array<ArrayBuffer>,
			uploadStart,
			size
		);
		queue.writeBuffer(
			this.#identitySlotBufferTo!,
			bytes,
			state.bufferTo as Float32Array<ArrayBuffer>,
			uploadStart,
			size
		);
	}

	/**
	 * Rewrite the frame uniform of any chart whose facet cell now shows a
	 * different id.
	 *
	 * The uniform carries one piece of derived state, the facet id at this cell,
	 * and a facet reorder moves it without touching the chart — nothing
	 * event-driven fires on it. So it is reconciled here instead: one compare per
	 * faceted chart per frame, and a write only on a reorder or a remount. The
	 * rule is `frameUniformIsStale`.
	 */
	#refreshStaleFrameUniforms(): void {
		for (const chart of this.#registeredCharts.values()) {
			if (frameUniformIsStale(chart)) this.updateChartFrameUniforms(chart.chartId);
		}
	}

	/**
	 * One scale's four floats, as every shader reads them: half of a chart's
	 * immediates, M4's x scale, or one axis of a parallel coordinates block.
	 * Written in one place so they cannot disagree about what a scale looks
	 * like to the GPU.
	 */
	#writeScaleParam(scale: ScaleInstance, view: Float32Array, off: number): void {
		if (isCategoricalScale(scale.type)) {
			// BAND SCALE: Write configuration
			const config = scale.getConfig!();

			view[off] = config.categoryCount;
			view[off + 1] = config.paddingInner;
			view[off + 2] = config.paddingOuter;
			// p4: this scale's base offset into the shared band slot table.
			view[off + 3] = this.#identitySlots?.offsets.get(scale.id) ?? IDENTITY_SLOT_EMPTY;
		} else {
			// CONTINUOUS SCALE: Write domain state (linear, time, log, symlog)
			const s = scale.gpuState!;

			view[off] = s.domainMin;
			view[off + 1] = s.domainMax;
			view[off + 2] = s.domainScale;
			view[off + 3] = s.p4; // symlog constant C, 0 for linear/log/time
		}
	}

	/**
	 * Fill a chart's immediates — its x scale's params, then its y scale's — and
	 * say whether it has both.
	 *
	 * Looked up by id on every pass rather than held: the lookup is two Map reads
	 * per chart per frame, and a value asked for each time cannot go stale the
	 * way an index written once did. A chart whose scale is not registered yet
	 * gets false, and the caller draws nothing for it rather than drawing through
	 * a guess.
	 */
	#writeChartScales(chart: ChartConfig, view: Float32Array): boolean {
		return (
			!!chart.xScaleId &&
			!!chart.yScaleId &&
			this.writeScaleParams(chart.xScaleId, view, 0) &&
			this.writeScaleParams(chart.yScaleId, view, 4)
		);
	}

	/**
	 * One scale's four floats into `view` at `offset`, looked up by id. A
	 * chart's draw pass fills its immediates through this, and so does compute
	 * work that pushes a scale of its own — M4 binning by the x scale its chart
	 * draws through. False for a scale that is not registered, and `view` is
	 * left alone.
	 */
	writeScaleParams(scaleId: string, view: Float32Array, offset: number): boolean {
		const scale = this.#scaleIdToInstance.get(scaleId);
		if (!scale) return false;
		this.#writeScaleParam(scale, view, offset);
		return true;
	}

	/**
	 * Fill a scale block and upload it if any value moved. At rest that is a
	 * compare and no write; during an axis transition, one write of 16 bytes per
	 * scale. A scale not registered yet leaves the buffer as it was.
	 */
	#refreshScaleBlock(block: ScaleBlockEntry): void {
		const buffer = block.buffer();
		if (!buffer) return;
		const { scaleIds, view, last } = block;
		for (let i = 0; i < scaleIds.length; i++) {
			if (!this.writeScaleParams(scaleIds[i], view, i << 2)) return;
		}
		let moved = false;
		for (let i = 0; i < view.length; i++) {
			if (view[i] !== last[i]) {
				moved = true;
				break;
			}
		}
		if (!moved) return;
		this.#device!.queue.writeBuffer(buffer, 0, view as Float32Array<ArrayBuffer>);
		last.set(view);
	}

	/** Reused per pass: the chart's x and y ScaleParam, pushed as immediates. */
	#chartScaleImmediates = new Float32Array(CHART_SCALE_IMMEDIATE_SIZE / 4);

	// =========================================================================
	// READBACK (test-only)
	// =========================================================================

	/**
	 * Configure canvases so the coordinator can copy from them. Test-only: set
	 * it before the charts mount, since a canvas reads it when it configures
	 * its context. Production leaves canvas usage at the default.
	 */
	readbackEnabled = false;

	#captureRequest: CaptureRequest | null = null;

	/**
	 * Render every chart once more and read back what it drew.
	 *
	 * Why here and not from the page. A WebGPU canvas's texture expires once it
	 * is presented, and `createImageBitmap` on the element after that returned
	 * transparent pixels for every chart while all of them were on screen. The
	 * copy has to be encoded in the frame that draws, so the coordinator does it.
	 *
	 * Charts that do not render in that frame — hidden, or not configured yet —
	 * are absent from the map.
	 */
	captureCharts(): Promise<Map<HTMLCanvasElement, ChartCapture>> {
		if (!this.readbackEnabled) {
			return Promise.reject(new Error('captureCharts needs readbackEnabled set before mount.'));
		}
		if (this.#captureRequest) {
			return Promise.reject(new Error('A capture is already pending.'));
		}
		return new Promise((resolve, reject) => {
			this.#captureRequest = { resolve, reject, copies: [] };
			for (const chartId of this.#registeredCharts.keys()) this.invalidateChart(chartId);
		});
	}

	/** Encode one chart's copy, right after its pass. Runs only while capturing. */
	#encodeCapture(
		encoder: GPUCommandEncoder,
		chart: ChartConfig,
		drew: boolean,
		copies: PendingCapture[]
	): void {
		const texture = chart.context.getCurrentTexture();
		const { width, height } = texture;
		// copyTextureToBuffer wants rows aligned to 256 bytes.
		const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
		const buffer = this.#device!.createBuffer({
			label: `capture-${chart.chartId}`,
			size: bytesPerRow * height,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
		encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
		copies.push({ canvas: chart.canvas, buffer, width, height, bytesPerRow, drew });
	}

	/** Map the frame's copies once it is submitted, and hand them over. */
	async #resolveCapture(request: CaptureRequest): Promise<void> {
		try {
			const captures = new Map<HTMLCanvasElement, ChartCapture>();
			await Promise.all(request.copies.map((c) => c.buffer.mapAsync(GPUMapMode.READ)));
			for (const c of request.copies) {
				const padded = new Uint8Array(c.buffer.getMappedRange());
				const rowBytes = c.width * 4;
				const pixels = new Uint8Array(rowBytes * c.height);
				for (let row = 0; row < c.height; row++) {
					pixels.set(
						padded.subarray(row * c.bytesPerRow, row * c.bytesPerRow + rowBytes),
						row * rowBytes
					);
				}
				c.buffer.unmap();
				c.buffer.destroy();
				captures.set(c.canvas, { width: c.width, height: c.height, pixels, drew: c.drew });
			}
			request.resolve(captures);
		} catch (error) {
			request.reject(error);
		}
	}

	// =========================================================================
	// ANIMATION LOOP CALLBACKS
	// =========================================================================

	/**
	 * Physics step - called at fixed rate (360Hz).
	 * Steps all animated scales.
	 */
	#physicsCallbacks: (() => void)[] = [];

	#physicsStep = (): void => {
		const len = this.#animatedSourcesArray.length;
		for (let i = 0; i < len; i++) {
			this.#animatedSourcesArray[i].step();
		}
		for (let i = 0; i < this.#physicsCallbacks.length; i++) {
			this.#physicsCallbacks[i]();
		}
	};

	/**
	 * Render frame - called once per RAF with extrapolation time.
	 * Updates render state and triggers GPU render.
	 */

	#renderFrame = (extrapolationDt: number): void => {
		// GPU back-pressure: skip render if too many frames are queued
		if (this.#framesInFlight >= this.#maxFramesInFlight) {
			return;
		}

		// 1. Apply any accumulated input (zoom, etc.)
		for (let i = 0; i < this.#animatedSourcesArray.length; i++) {
			this.#animatedSourcesArray[i]._applyInput?.();
		}

		// 2. Update render state with extrapolation for ALL scales first
		const len = this.#animatedSourcesArray.length;
		for (let i = 0; i < len; i++) {
			this.#animatedSourcesArray[i].updateRenderState(extrapolationDt);
		}

		// 3. Gather charts to render BEFORE removing rested scales
		const chartArray = this.#chartsToRenderArray;
		chartArray.length = 0;
		const currentRenderId = this.#frameId;

		// Add charts affected by animated scales
		for (let i = 0; i < this.#animatedSourcesArray.length; i++) {
			const scale = this.#animatedSourcesArray[i];
			const affected = scale._affectedChartsArray;

			if (affected) {
				const affectedLen = affected.length;
				for (let j = 0; j < affectedLen; j++) {
					const chartId = affected[j];
					const chart = this.#registeredCharts.get(chartId);

					if (chart && chart._lastRenderFrame !== currentRenderId) {
						if (chart.visible && chart.contextConfigured) {
							chart._lastRenderFrame = currentRenderId;
							chartArray.push(chart);
						}
					}
				}
			}
		}

		// Add dirty charts (from resize, data updates, etc.)
		const dirtyLen = this.#dirtyChartsArray.length;
		for (let i = 0; i < dirtyLen; i++) {
			const chart = this.#dirtyChartsArray[i];

			if (!chart._isDirty) continue; // Removed or already processed
			chart._isDirty = false;

			if (chart._lastRenderFrame !== currentRenderId) {
				if (chart.visible && chart.contextConfigured) {
					chart._lastRenderFrame = currentRenderId;
					chartArray.push(chart);
				}
			}
		}
		this.#dirtyChartsArray.length = 0;

		// 4. Remove scales that are at rest (backwards for safe removal)
		for (let i = this.#animatedSourcesArray.length - 1; i >= 0; i--) {
			const scale = this.#animatedSourcesArray[i];

			if (scale.isAtRest()) {
				// Swap and pop removal (O(1))
				this.#animatedSources.delete(scale);
				const last = this.#animatedSourcesArray.pop()!;
				if (i < this.#animatedSourcesArray.length) {
					this.#animatedSourcesArray[i] = last;
				}
				// Removed BEFORE it is told, so a source that restarts itself from
				// its rest callback rejoins rather than being dropped right after.
				// Iterating backwards, a rejoin appends past `i` and is not revisited.
				scale._markAtRest();
			}
		}

		// 5. Render if needed
		if (chartArray.length > 0) {
			this.#coordinatedRender(chartArray);
		}

		// 5b. Process deferred renderer releases (after render so new frame is submitted)
		if (this.#pendingReleases.length > 0) {
			for (let i = 0; i < this.#pendingReleases.length; i++) {
				this.#pendingReleases[i].destroy();
			}
			this.#pendingReleases.length = 0;
		}

		// 6. Per-frame callbacks (tooltip scheduling, etc.)
		this.#isAnimating = this.#animatedSources.size > 0;
		const cbLen = this.#frameCallbacks.length;
		for (let i = 0; i < cbLen; i++) {
			this.#frameCallbacks[i](this.#isAnimating);
		}
	};

	/**
	 * Idle check - return true if animation should stop.
	 */
	#idleCheck = (): boolean => {
		return (
			this.#animatedSources.size === 0 &&
			this.#dirtyChartsArray.length === 0 &&
			this.#hoveredCharts.size === 0 &&
			this.#pendingReleases.length === 0
		);
	};

	// =========================================================================
	// RENDER PIPELINE
	// =========================================================================

	#coordinatedRender(chartsNeedingRender: ChartConfig[]): void {
		// PHASE 1: EARLY TEXTURE ACQUISITION
		const numCharts = chartsNeedingRender.length;
		const views = this.#acquiredViews;
		for (let i = 0; i < numCharts; i++) {
			views[i] = chartsNeedingRender[i].context.getCurrentTexture().createView();
		}
		// Drop any tail left by a frame that rendered more charts than this one,
		// so a grid shrinking from forty cells to two stops holding thirty-eight
		// views of swapchain textures the browser has already moved on from. The
		// live entries are overwritten above rather than cleared, since every one
		// of them is reassigned before it is read.
		for (let i = numCharts; i < views.length; i++) views[i] = null;

		// PHASE 2: CPU WORK (Scale buffer updates)
		this.#updateIdentitySlots();
		this.#refreshStaleFrameUniforms();
		for (let i = 0; i < numCharts; i++) {
			const blocks = this.#scaleBlocks.get(chartsNeedingRender[i].chartId);
			if (blocks) for (const block of blocks) this.#refreshScaleBlock(block);
		}

		// PHASE 3: GPU COMMAND ENCODING
		const commandEncoder = this.#device!.createCommandEncoder(this.#encoderDescriptor);

		// PHASE 3a: PRE-RENDER COMPUTE
		// The slot resolve goes first: registered compute work may read a band
		// scale, and everything in the render passes below reads `resolved`.
		this.#encodeSlotResolve(commandEncoder);

		// Work tied to a chart runs only when that chart is in this frame's draw
		// list, which stamped it with this frame's id. Its output buffers keep the
		// last result in between, and the next frame that draws the chart runs
		// the work first, in this same encoder.
		if (this.#computeWork.size > 0) {
			for (const work of this.#computeWork.values()) {
				if (work.chartId !== null) {
					const chart = this.#registeredCharts.get(work.chartId);
					if (chart?._lastRenderFrame !== this.#frameId) continue;
				}
				work.fn(commandEncoder);
			}
		}

		const capture = this.#captureRequest;

		for (let i = 0; i < numCharts; i++) {
			const chartConfig = chartsNeedingRender[i];
			const view = views[i]!;

			if (chartConfig.needsPlanRebuild) {
				this.#buildRenderPlanForChart(chartConfig);
			}

			const passEncoder = commandEncoder.beginRenderPass(
				this.#createRenderPassDescriptor(view, chartConfig)
			);

			// The chart's scales, written once for the whole pass and before the
			// first draw. Every pipeline declares the same
			// CHART_SCALE_IMMEDIATE_SIZE and a draw requires every declared byte to
			// have been set, so this is the whole range, every pass. Immediate data
			// survives setPipeline between layouts of the same size, which is what
			// makes once enough. Pushed even when the chart's scales are not both
			// known: a layer that does not read them still needs every byte set
			// before it may draw.
			const scalesKnown = this.#writeChartScales(chartConfig, this.#chartScaleImmediates);
			passEncoder.setImmediates(0, this.#chartScaleImmediates);

			if (chartConfig.perFrameBindGroup) {
				passEncoder.setBindGroup(0, chartConfig.perFrameBindGroup);
				passEncoder.setBindGroup(2, this.#scaleResourcesBindGroup!);

				const plan = chartConfig.renderPlan;
				const planLen = plan.length;

				let currentPipeline: GPURenderPipeline | null = null;
				let currentPerDataBindGroup: GPUBindGroup | null = null;

				for (let j = 0; j < planLen; j++) {
					const layer = plan[j];
					if (!layerCanDraw(layer, scalesKnown)) continue;
					const renderer = layer.renderer;

					if (layer.cachedPipeline !== currentPipeline) {
						passEncoder.setPipeline(layer.cachedPipeline!);
						currentPipeline = layer.cachedPipeline!;
					}

					if (renderer.perDataBindGroup !== currentPerDataBindGroup) {
						passEncoder.setBindGroup(1, renderer.perDataBindGroup);
						currentPerDataBindGroup = renderer.perDataBindGroup;
					}

					layer.draw(passEncoder);
				}
			}

			passEncoder.end();

			if (capture) {
				const drew =
					!!chartConfig.perFrameBindGroup &&
					chartConfig.renderPlan.some((layer) => layerCanDraw(layer, scalesKnown));
				this.#encodeCapture(commandEncoder, chartConfig, drew, capture.copies);
			}
		}

		// PHASE 4: SUBMIT
		this.#submitArray[0] = commandEncoder.finish();
		this.#device!.queue.submit(this.#submitArray as [GPUCommandBuffer]);

		if (capture) {
			this.#captureRequest = null;
			void this.#resolveCapture(capture);
		}

		this.#framesInFlight++;
		this.#device!.queue.onSubmittedWorkDone().then(() => {
			this.#framesInFlight--;
		});

		this.#frameId++;
	}

	// =========================================================================
	// RESOURCE ACQUISITION (Registry Pattern)
	// =========================================================================

	/**
	 * Acquire pipeline resources for a renderer.
	 * Tracks acquisition in registry for proper cleanup.
	 *
	 * @param {string} rendererId - Unique renderer identifier
	 * @param {string} markType - Mark type (dots, rects, etc.)
	 * @param {object} scaleTypes - {x: string, y: string}
	 * @param {string} markShaderCode - Mark-specific shader code
	 * @param {array} vertexBufferLayout - Vertex buffer layout
	 * @param {array} dataBindingConfig - Data binding configuration
	 * @param {object} [rendererDefinition] - Optional declarative renderer definition
	 * @returns {Promise<{pipeline, frameLayout, dataLayout}>}
	 */
	async acquirePipeline(
		rendererId: string,
		markType: string,
		scaleTypes: { x: string; y: string },
		markShaderCode: string,
		vertexBufferLayout: GPUVertexBufferLayout[],
		dataBindingConfig: DataBindingEntry[],
		rendererDefinition: RendererDefinition
	): Promise<PipelineResult> {
		if (!rendererDefinition) {
			throw new Error(
				`acquirePipeline requires a rendererDefinition for mark type '${markType}'. ` +
					"Define the renderer's semantic concepts (position/extent) and placeholders."
			);
		}
		if (!rendererId) throw new Error('acquirePipeline requires a rendererId');

		// Generate stable resource key (includes scale types and renderer definition)
		const topologySuffix = `${scaleTypes.x}-${scaleTypes.y}`;
		const defSuffix = `-${rendererDefinition.x?.concept || 'none'}-${rendererDefinition.y?.concept || 'none'}`;
		const resourceKey = `${markType}-${topologySuffix}${defSuffix}`;

		// Prepare local registry for this renderer
		if (!this.#rendererRegistry.has(rendererId)) {
			this.#rendererRegistry.set(rendererId, new Map());
		}
		const localRegistry = this.#rendererRegistry.get(rendererId)!;

		// --- Acquire Shader (with idempotency check) ---
		let shaderModule: GPUShaderModule | undefined;
		const shaderLookupKey = `shader:${resourceKey}`;

		if (localRegistry.has(shaderLookupKey)) {
			// Already owned by this renderer - get reference without incrementing refCount
			const cached = this.#sharedResources.shaderModules.get(resourceKey);
			if (!cached) {
				// Defensive: global cache inconsistent, clear local entry
				localRegistry.delete(shaderLookupKey);
			} else {
				shaderModule = cached.module;
			}
		}

		if (!shaderModule) {
			// Create/Get and increment RefCount
			// Pass rendererDefinition and markType to generateShader
			const templateResult = scaleTemplateSystem.generateShader(
				scaleTypes,
				markShaderCode,
				rendererDefinition,
				markType
			);
			shaderModule = await this.#getOrCreateSharedShader(resourceKey, templateResult.shaderCode);
			localRegistry.set(shaderLookupKey, { type: 'shader', key: resourceKey });
		}

		// --- Acquire Layouts ---
		const frameLayout = this.#getOrCreateFrameLayout();
		const dataLayout = this.#getOrCreateDataLayout(markType, dataBindingConfig);

		// --- Acquire Pipeline (with idempotency check) ---
		let pipeline: GPURenderPipeline | undefined;
		const pipelineLookupKey = `pipeline:${resourceKey}`;

		if (localRegistry.has(pipelineLookupKey)) {
			const cached = this.#sharedResources.pipelines.get(resourceKey);
			if (!cached) {
				localRegistry.delete(pipelineLookupKey);
			} else {
				pipeline = cached.pipeline;
			}
		}

		if (!pipeline) {
			// Create/Get and increment RefCount
			// Note: pipelineLayout created inside callback to avoid waste when cached
			pipeline = await this.#getOrCreateSharedPipeline(resourceKey, async () => {
				const pipelineLayout = this.#device!.createPipelineLayout({
					label: `${resourceKey}-pipeline-layout`,
					bindGroupLayouts: [frameLayout, dataLayout, this.#scaleResourcesLayout!],
					// The same for every render pipeline, so it adds no cache
					// permutations — and it has to be: a draw needs every declared
					// byte set, and the pass sets exactly this many.
					immediateSize: CHART_SCALE_IMMEDIATE_SIZE
				});

				return this.#device!.createRenderPipeline({
					label: `${resourceKey}-pipeline`,
					layout: pipelineLayout,
					vertex: {
						module: shaderModule!,
						entryPoint: 'vertexMain',
						buffers: vertexBufferLayout || []
					},
					fragment: {
						module: shaderModule!,
						entryPoint: 'fragmentMain',
						targets: [
							{
								format: this.#presentationFormat!,
								blend: {
									color: {
										srcFactor: 'one',
										dstFactor: 'one-minus-src-alpha',
										operation: 'add'
									},
									alpha: {
										srcFactor: 'one',
										dstFactor: 'one-minus-src-alpha',
										operation: 'add'
									}
								}
							}
						]
					},
					primitive: { topology: 'triangle-list' },
					multisample: { count: this.#msaaSampleCount > 1 ? this.#msaaSampleCount : 1 }
				});
			});

			localRegistry.set(pipelineLookupKey, { type: 'pipeline', key: resourceKey });
		}

		return { pipeline, frameLayout, dataLayout };
	}

	/**
	 * Release all resources tracked for a specific renderer ID.
	 * Called by BaseGPURenderer.destroy()
	 */
	releaseRenderer(rendererId: string): void {
		const localRegistry = this.#rendererRegistry.get(rendererId);
		if (!localRegistry) return;

		for (const res of localRegistry.values()) {
			if (res.type === 'pipeline') {
				this.#releaseSharedPipeline(res.key);
			} else if (res.type === 'shader') {
				this.#releaseSharedShader(res.key);
			}
		}

		this.#rendererRegistry.delete(rendererId);
	}

	// =========================================================================
	// INTERNAL REF-COUNTING (Private)
	// =========================================================================

	async #getOrCreateSharedPipeline(
		key: string,
		createFn: () => Promise<GPURenderPipeline>
	): Promise<GPURenderPipeline> {
		// Fast path: Check cache first
		const existing = this.#sharedResources.pipelines.get(key);
		if (existing) {
			existing.refCount++;
			return existing.pipeline;
		}

		// In-flight path: Return existing promise if creation is already in progress
		// This eliminates the "thundering herd" problem - all concurrent requests
		// for the same pipeline share a single creation promise
		if (this.#pipelineCreationPromises.has(key)) {
			const pipeline = await this.#pipelineCreationPromises.get(key)!;
			// After await completes, increment refCount on the now-cached pipeline
			const cached = this.#sharedResources.pipelines.get(key);
			if (cached) {
				cached.refCount++;
				return cached.pipeline;
			}
			return pipeline;
		}

		// Cold path: Create new pipeline and cache the promise
		const creationPromise = (async () => {
			try {
				const pipeline = await createFn();
				this.#sharedResources.pipelines.set(key, {
					pipeline,
					refCount: 1,
					createdAt: Date.now()
				});
				return pipeline;
			} finally {
				// Clean up promise cache regardless of success/failure
				this.#pipelineCreationPromises.delete(key);
			}
		})();

		this.#pipelineCreationPromises.set(key, creationPromise);
		return creationPromise;
	}

	#releaseSharedPipeline(key: string): void {
		const resource = this.#sharedResources.pipelines.get(key);
		if (!resource) return;

		resource.refCount--;
		if (resource.refCount <= 0) {
			this.#sharedResources.pipelines.delete(key);
		}
	}

	async #getOrCreateSharedShader(key: string, code: string): Promise<GPUShaderModule> {
		const existing = this.#sharedResources.shaderModules.get(key);
		if (existing) {
			existing.refCount++;
			return existing.module;
		}

		const module = this.#device!.createShaderModule({ code });
		this.#sharedResources.shaderModules.set(key, {
			module,
			refCount: 1,
			createdAt: Date.now()
		});
		return module;
	}

	#releaseSharedShader(key: string): void {
		const resource = this.#sharedResources.shaderModules.get(key);
		if (!resource) return;

		resource.refCount--;
		if (resource.refCount <= 0) {
			this.#sharedResources.shaderModules.delete(key);
		}
	}

	// =========================================================================
	// SCALE REGISTRATION
	// =========================================================================

	setScaleRegistry(scaleRegistry: ScaleRegistry): void {
		this.#scaleRegistry = scaleRegistry;
	}

	/**
	 * The page's filter groups, whose field activity the packer writes into the
	 * identity slot table. Their fades run on this loop and redraw the charts
	 * drawing any scale on their field. Set before any selection, so no fade is
	 * created without the loop.
	 */
	setFilterGroups(filterGroups: FilterGroupRegistry): void {
		this.#filterGroups = filterGroups;
		filterGroups.setAnimation(this, (key, out) =>
			this.#scaleRegistry ? this.#scaleRegistry.chartsDrawingField(key, out) : out
		);
	}

	registerScale(scaleId: string, scaleType: string = 'linear'): void {
		if (!this.#initialized) return;
		this.#handleScaleTopologyChange();
	}

	unregisterScale(scaleId: string): void {
		this.#handleScaleTopologyChange();
	}

	scheduleTopologyUpdate(): void {
		if (this.#topologyUpdateScheduled) return;
		this.#topologyUpdateScheduled = true;

		queueMicrotask(() => {
			this.#topologyUpdateScheduled = false;
			this.#handleScaleTopologyChange();
		});
	}

	#handleScaleTopologyChange(): void {
		if (!this.#scaleRegistry) return;

		const usageMap = this.#scaleRegistry.scaleUsage;
		if (!usageMap || typeof usageMap[Symbol.iterator] !== 'function') return;

		// Clear and rebuild: every scale with an id — positional scales, and
		// ordinal colour, whose slots the packer needs too. The id map is only
		// looked up with a chart's x and y scale ids, so a colour scale in it is
		// never mistaken for a positional one.
		//
		// The redraw list is NOT rebuilt here any more. It belongs to the
		// registry, derived from the same usage map this reads, and a scale asks
		// for it. Copying it from a second owner is how it went stale.
		trackScalesById(usageMap.keys() as unknown as Iterable<ScaleInstance>, this.#scaleIdToInstance);

		this.#scales = [...this.#scaleIdToInstance.values()];
	}

	// =========================================================================
	// COLOR SCALE API
	// =========================================================================

	/**
	 * Write a ColorConfig struct to the config buffer.
	 *
	 * @param {number} slot - Config slot index (0-63)
	 * @param {ArrayBuffer} configData - 48-byte config struct from ColorScaleState
	 */
	writeColorConfig(slot: number, configData: ArrayBufferLike): void {
		if (!this.#colorConfigBuffer) {
			console.warn('[GPUCoordinator] Color config buffer not initialized');
			return;
		}

		if (slot < 0 || slot >= this.#maxColorSlots) {
			console.warn(`[GPUCoordinator] Invalid color config slot: ${slot}`);
			return;
		}

		const byteOffset = slot * COLOR_CONFIG_BYTES;
		this.#device!.queue.writeBuffer(this.#colorConfigBuffer, byteOffset, configData);
	}

	/**
	 * Patch one colour config's `slotBase` — the four bytes that move when the
	 * packer shifts this scale's block in the shared slot table.
	 *
	 * Separate from `writeColorConfig` because the rest of the struct is written
	 * when the SCALE changes, while the base moves whenever a NEIGHBOURING scale
	 * resizes. The scale calls this itself; the coordinator owns the buffer, not
	 * the decision.
	 */
	writeColorConfigSlotBase(slot: number, base: number): void {
		if (!this.#colorConfigBuffer) return;
		if (slot < 0 || slot >= this.#maxColorSlots) {
			console.warn(`[GPUCoordinator] Invalid color config slot: ${slot}`);
			return;
		}
		this.#slotBasePatch[0] = base;
		this.#device!.queue.writeBuffer(
			this.#colorConfigBuffer,
			slot * COLOR_CONFIG_BYTES + COLOR_CONFIG_SLOT_BASE_OFFSET,
			this.#slotBasePatch
		);
	}

	/**
	 * Write a 256-color gradient ramp to the ramp buffer.
	 *
	 * @param {number} slot - Ramp slot index (0-63)
	 * @param {Float32Array} rampData - 1024 floats (256 colors × RGBA)
	 */
	writeColorRamp(slot: number, rampData: Float32Array<ArrayBuffer>): void {
		if (!this.#colorRampBuffer) {
			console.warn('[GPUCoordinator] Color ramp buffer not initialized');
			return;
		}

		if (slot < 0 || slot >= this.#maxColorSlots) {
			console.warn(`[GPUCoordinator] Invalid color ramp slot: ${slot}`);
			return;
		}

		// Each slot = 256 colors × 4 floats × 4 bytes = 4096 bytes
		const byteOffset = slot * this.#rampColorsPerSlot * 4 * 4;
		this.#device!.queue.writeBuffer(this.#colorRampBuffer, byteOffset, rampData);
	}

	/**
	 * Write a 32-color ordinal palette to the palette buffer.
	 *
	 * @param {number} slot - Palette slot index (0-63)
	 * @param {Float32Array} paletteData - 128 floats (32 colors × RGBA)
	 */
	writeColorPalette(slot: number, paletteData: Float32Array<ArrayBuffer>): void {
		if (!this.#colorPaletteBuffer) {
			console.warn('[GPUCoordinator] Color palette buffer not initialized');
			return;
		}

		if (slot < 0 || slot >= this.#maxColorSlots) {
			console.warn(`[GPUCoordinator] Invalid color palette slot: ${slot}`);
			return;
		}

		// Each slot = 32 colors × 4 floats × 4 bytes = 512 bytes
		const byteOffset = slot * this.#paletteColorsPerSlot * 4 * 4;
		this.#device!.queue.writeBuffer(this.#colorPaletteBuffer, byteOffset, paletteData);
	}

	/**
	 * Write a SizeConfig struct to the size config buffer.
	 *
	 * @param {number} slot - Config slot index (0-63)
	 * @param {ArrayBuffer} configData - 16-byte config struct from SizeScaleState
	 */
	writeSizeConfig(slot: number, configData: ArrayBufferLike): void {
		if (!this.#sizeConfigBuffer) {
			console.warn('[GPUCoordinator] Size config buffer not initialized');
			return;
		}

		if (slot < 0 || slot >= this.#maxSizeSlots) {
			console.warn(`[GPUCoordinator] Invalid size config slot: ${slot}`);
			return;
		}

		const byteOffset = slot * 16;
		this.#device!.queue.writeBuffer(this.#sizeConfigBuffer, byteOffset, configData);
	}

	// =========================================================================
	// ANIMATED SCALE MANAGEMENT
	// =========================================================================

	/**
	 * Join the loop.
	 *
	 * For a scale, prefer `addAnimatingScale`, which also makes sure the scale
	 * is registered, so its params can be found by id. Anything that is not a scale —
	 * a mark driving its own data transition — has no such slot and wants this.
	 */
	addAnimatedSource(source: AnimatedSource): void {
		if (!this.#animatedSources.has(source)) {
			this.#animatedSources.add(source);
			this.#animatedSourcesArray.push(source);
		}
		this.#animationLoop!.requestStart();
	}

	removeAnimatedSource(source: AnimatedSource): void {
		if (this.#animatedSources.delete(source)) {
			const idx = this.#animatedSourcesArray.indexOf(source);
			if (idx !== -1) {
				const lastItem = this.#animatedSourcesArray.pop()!;
				if (idx < this.#animatedSourcesArray.length) {
					this.#animatedSourcesArray[idx] = lastItem;
				}
			}
		}
	}

	addAnimatingScale(scale: ScaleInstance): void {
		if (!this.#scaleIdToInstance.has(scale.id)) {
			this.registerScale(scale.id, 'linear');
			if (!this.#scaleIdToInstance.has(scale.id)) {
				console.error(`Scale ${scale.id} still not registered after auto-register`);
				return;
			}
		}

		// Registered; the rest is just joining the loop.
		this.addAnimatedSource(scale);
	}

	removeAnimatingScale(scale: ScaleInstance): void {
		this.removeAnimatedSource(scale);
	}

	// =========================================================================
	// CHART REGISTRATION
	// =========================================================================

	/**
	 * Mark a chart as hovered - keeps animation loop warm for instant response.
	 * @param {string} chartId
	 */
	setChartHovered(chartId: string): void {
		this.#hoveredCharts.add(chartId);
		this.#animationLoop!.requestStart();
	}

	/**
	 * Mark a chart as no longer hovered.
	 * @param {string} chartId
	 */
	setChartUnhovered(chartId: string): void {
		this.#hoveredCharts.delete(chartId);
		// Loop will stop on its own via idle check if nothing else is active
	}

	/**
	 * Register a callback to be called once per animation frame.
	 * Callback receives { isAnimating: boolean } — true when scales are actively
	 * animating (pan/zoom), useful for skipping non-essential work like tooltips.
	 */
	addFrameCallback(fn: FrameCallback): void {
		this.#frameCallbacks.push(fn);
	}

	removeFrameCallback(fn: FrameCallback): void {
		const idx = this.#frameCallbacks.indexOf(fn);
		if (idx !== -1) this.#frameCallbacks.splice(idx, 1);
	}

	addPhysicsCallback(fn: () => void): void {
		this.#physicsCallbacks.push(fn);
	}

	removePhysicsCallback(fn: () => void): void {
		const idx = this.#physicsCallbacks.indexOf(fn);
		if (idx !== -1) this.#physicsCallbacks.splice(idx, 1);
	}

	registerChart(
		chartId: string,
		canvas: HTMLCanvasElement,
		config: ChartRegistrationConfig
	): ChartRegistrationResult {
		if (this.#registeredCharts.has(chartId)) {
			console.warn(`Chart ${chartId} already registered, updating config`);
		}

		const chartConfig: ChartConfig = {
			chartId,
			canvas,
			zIndex: config.zIndex || 0,
			facetIndex: config.facetIndex ?? 0,
			facetScale: config.facetScale ?? null,
			_facetVersion: -1,
			visible: true,
			context: canvas.getContext('webgpu')!,
			contextConfigured: false,
			layers: new Map(),
			renderPlan: [],
			needsPlanRebuild: true,
			xScaleId: null,
			yScaleId: null,
			frameUniformsBuffer: null,
			perFrameBindGroup: null,
			renderPassDescriptor: null,
			msaa: null,
			_lastRenderFrame: -1,
			_isDirty: false
		};

		this.#registeredCharts.set(chartId, chartConfig);

		// Observe canvas for viewport visibility
		if (this.#visibilityObserver) {
			canvas.dataset.chartId = chartId;
			this.#visibilityObserver.observe(canvas);
			this.#observedElements.set(chartId, canvas);
			this.#chartIOVisible.set(chartId, true); // assume visible until IO fires
		}

		const pendingMapping = this.#pendingScaleMappings.get(chartId);
		if (pendingMapping) {
			this.setChartScaleMapping(chartId, pendingMapping);
			this.#pendingScaleMappings.delete(chartId);
		}

		const pendingLayerList = this.#pendingLayers.get(chartId);
		if (pendingLayerList) {
			for (const layerConfig of pendingLayerList) {
				chartConfig.layers.set(layerConfig.id, layerConfig);
			}
			chartConfig.needsPlanRebuild = true;
			this.#pendingLayers.delete(chartId);
		}

		return {
			setContextReady: () => {
				const chart = this.#registeredCharts.get(chartId);
				if (chart) {
					chart.contextConfigured = true;
					this.#processPendingFrameUpdates(chartId);
					// Ensure frame resources exist and trigger initial render.
					// Pending layers/mappings were applied in registerChart, but
					// earlier invalidateChart calls were no-ops (chart not ready).
					this.updateChartFrameUniforms(chartId);
					this.invalidateChart(chartId);
				}
			},
			setVisible: (visible: boolean) => {
				const cfg = this.#registeredCharts.get(chartId);
				if (cfg && cfg.visible !== visible) {
					cfg.visible = visible;
					this.invalidateChart(chartId);
				}
			},
			invalidate: () => this.invalidateChart(chartId),
			remove: () => this.unregisterChart(chartId)
		};
	}

	unregisterChart(chartId: string): void {
		const chartConfig = this.#registeredCharts.get(chartId);
		if (chartConfig) {
			chartConfig._isDirty = false;

			if (chartConfig.frameUniformsBuffer) {
				chartConfig.frameUniformsBuffer.destroy();
			}

			if (chartConfig.msaa) {
				chartConfig.msaa.texture.destroy();
				chartConfig.msaa = null;
			}

			this.#registeredCharts.delete(chartId);
			this.#hoveredCharts.delete(chartId);

			// Stop observing visibility
			const observed = this.#observedElements.get(chartId);
			if (observed && this.#visibilityObserver) {
				this.#visibilityObserver.unobserve(observed);
			}
			this.#observedElements.delete(chartId);
			this.#chartIOVisible.delete(chartId);
			this.#visibilityCallbacks.delete(chartId);

			// const msaa = this.#msaaCache.get(chartId);
			// if (msaa) {
			// 	msaa.texture.destroy();
			// 	this.#msaaCache.delete(chartId);
			// }

			this.#pendingScaleMappings.delete(chartId);
		}
	}

	// =========================================================================
	// VIEWPORT VISIBILITY
	// =========================================================================

	/**
	 * Register a callback invoked when a chart's effective visibility changes.
	 * Effective visibility = IntersectionObserver visible AND page visible.
	 * Used by ChartCell to toggle Mosaic client.enabled.
	 */
	setVisibilityCallback(chartId: string, callback: (visible: boolean) => void): () => void {
		this.#visibilityCallbacks.set(chartId, callback);
		return () => this.#visibilityCallbacks.delete(chartId);
	}

	#handleVisibilityChange(chartId: string, ioVisible: boolean): void {
		this.#chartIOVisible.set(chartId, ioVisible);
		this.#applyVisibility(chartId, this.#pageVisible && ioVisible);
	}

	#applyVisibility(chartId: string, visible: boolean): void {
		const cfg = this.#registeredCharts.get(chartId);
		if (!cfg || cfg.visible === visible) return;

		cfg.visible = visible;
		this.#visibilityCallbacks.get(chartId)?.(visible);

		if (visible) {
			// Chart became visible — trigger re-render with current state
			this.invalidateChart(chartId);
		}
	}

	invalidateChart(chartId: string): void {
		const chart = this.#registeredCharts.get(chartId);
		if (chart && !chart._isDirty) {
			chart._isDirty = true;
			this.#dirtyChartsArray.push(chart);
			this.#animationLoop!.requestStart();
		}
	}

	/**
	 * Signal that a mark's renderer should be retained on next unmount.
	 * Called before setup.destroy() so the renderer keeps drawing during replacement.
	 */
	markForRetain(markId: string): void {
		// If a previous retained renderer hasn't been released yet (lifecycle $effect
		// re-ran before the new renderer mounted), queue it for destruction now.
		// Without this, the old entry would be overwritten by the sentinel and leaked.
		const existing = this.#retainedRenderers.get(markId);
		if (existing) {
			this.#pendingReleases.push(existing);
		}
		// Sentinel entry — renderer.onDestroy will replace it with the actual renderer
		this.#retainedRenderers.set(markId, { destroy() {} });
	}

	/**
	 * Check if a mark is flagged for retention, and store its actual renderer.
	 * Called from renderer onDestroy — swaps the sentinel with the real destroyable.
	 */
	retainRenderer(markId: string, destroyable: { destroy: () => void }): boolean {
		if (this.#retainedRenderers.has(markId)) {
			this.#retainedRenderers.set(markId, destroyable);
			return true;
		}
		return false;
	}

	/**
	 * Queue a retained renderer for destruction after the next render cycle.
	 * The old renderer keeps drawing until the new one has rendered a frame.
	 */
	releaseRetained(markId: string): void {
		const retained = this.#retainedRenderers.get(markId);
		if (retained) {
			this.#retainedRenderers.delete(markId);
			this.#pendingReleases.push(retained);
			// Ensure a render cycle runs to process the release
			this.#animationLoop!.requestStart();
		}
	}

	setChartScaleMapping(
		chartId: string,
		{ xScaleId, yScaleId }: { xScaleId: string; yScaleId: string }
	): void {
		const chartConfig = this.#registeredCharts.get(chartId);
		if (!chartConfig) {
			this.#pendingScaleMappings.set(chartId, { xScaleId, yScaleId });
			return;
		}

		const changed = chartConfig.xScaleId !== xScaleId || chartConfig.yScaleId !== yScaleId;

		chartConfig.xScaleId = xScaleId;
		chartConfig.yScaleId = yScaleId;

		// No uniform write here, deliberately. The index this mapping decides is
		// reconciled per frame by #refreshStaleFrameUniforms, which compares the
		// ids a chart holds against the ones its uniform was written for. Pushing
		// it from every writer is what left this one behind.
		if (changed) {
			chartConfig.needsPlanRebuild = true;
			this.invalidateChart(chartId);
		}
	}

	// =========================================================================
	// FRAME UNIFORMS
	// =========================================================================

	#getOrCreateFrameLayout(): GPUBindGroupLayout {
		if (!this.#frameLayout) {
			this.#frameLayout = this.#device!.createBindGroupLayout({
				label: 'shared-frame-layout',
				entries: [
					{
						binding: 0,
						visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
						buffer: { type: 'uniform' }
					}
				]
			});
		}
		return this.#frameLayout;
	}

	#getOrCreateDataLayout(
		markType: string,
		dataBindingConfig: DataBindingEntry[]
	): GPUBindGroupLayout {
		const layoutKey = `${markType}-${JSON.stringify(dataBindingConfig)}`;

		if (!this.#dataLayouts.has(layoutKey)) {
			const layout = this.#device!.createBindGroupLayout({
				label: `${markType}-data-layout`,
				entries: dataBindingConfig.map((config) => ({
					binding: config.binding,
					// visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					visibility:
						config.visibility !== undefined
							? config.visibility
							: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: (config.type || 'read-only-storage') as GPUBufferBindingType }
				}))
			});
			this.#dataLayouts.set(layoutKey, layout);
		}

		return this.#dataLayouts.get(layoutKey)!;
	}

	#createChartFrameResources(chartId: string): void {
		const chartConfig = this.#registeredCharts.get(chartId);
		if (!chartConfig || chartConfig.frameUniformsBuffer) return;

		chartConfig.frameUniformsBuffer = this.#device!.createBuffer({
			size: 64,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			label: `frame-uniforms-${chartId}`
		});

		this.#createChartFrameBindGroup(chartId);
	}

	#createChartFrameBindGroup(chartId: string): void {
		const chartConfig = this.#registeredCharts.get(chartId);
		if (!chartConfig?.frameUniformsBuffer || chartConfig.perFrameBindGroup) return;

		const frameLayout = this.#getOrCreateFrameLayout();

		chartConfig.perFrameBindGroup = this.#device!.createBindGroup({
			label: `per-frame-bind-group-${chartId}`,
			layout: frameLayout,
			entries: [
				{
					binding: 0,
					resource: { buffer: chartConfig.frameUniformsBuffer }
				}
			]
		});
	}

	// nullColor, where should we set this? per chart or per mark or theme wide?
	updateChartFrameUniforms(chartId: string, nullColor: number[] = [0.5, 0.5, 0.5, 1.0]): void {
		const chartConfig = this.#registeredCharts.get(chartId);
		if (!chartConfig?.contextConfigured) {
			this.#pendingFrameUpdates.set(chartId, { timestamp: Date.now() });
			return;
		}

		if (!chartConfig.frameUniformsBuffer) {
			this.#createChartFrameResources(chartId);
		}

		const dpr = window.devicePixelRatio || 1;
		const canvas = chartConfig.canvas;

		const resX = canvas.width;
		const resY = canvas.height;

		const rangeMinX = 0;
		const rangeMaxX = canvas.clientWidth * dpr;
		const rangeMinY = 0; // Top of chart (screen coords)
		const rangeMaxY = canvas.clientHeight * dpr;

		const buf = new ArrayBuffer(64);
		const f32 = new Float32Array(buf);
		const u32 = new Uint32Array(buf);

		f32[0] = resX;
		f32[1] = resY;
		f32[2] = rangeMinX;
		f32[3] = rangeMinY;
		f32[4] = rangeMaxX;
		f32[5] = rangeMaxY;
		f32[6] = dpr;
		// f32[7] = padding
		// u32[8], u32[9] = padding (were the chart's scale indices)
		// The facet value this cell renders. The vertex shaders compare their
		// __facet channel against this, and that channel now carries a dim id
		// rather than a cell index — so this has to be the id displayed at this
		// cell, not the cell's position. idAtSlot handles both: with identity it
		// is displayOrder[slot], without it the slot passes through unchanged,
		// which is what makes this a no-op until the facet scale is migrated.
		//
		// Resolved here rather than captured at registration, because registerChart
		// runs once at mount and a reorder moves which id sits at this cell long
		// after. Note this method is event-driven, NOT per frame — #updateIdentitySlots
		// is what notices a facet permutation moving and calls it.
		const facetSlot = chartConfig.facetIndex ?? 0;
		u32[10] = (chartConfig.facetScale?.idAtSlot(facetSlot) ?? facetSlot) >>> 0;
		chartConfig._facetVersion = chartConfig.facetScale?._version ?? -1;
		u32[11] = 0; // padding
		f32[12] = nullColor[0]; // R
		f32[13] = nullColor[1]; // G
		f32[14] = nullColor[2]; // B
		f32[15] = nullColor[3]; // A

		this.#device!.queue.writeBuffer(chartConfig.frameUniformsBuffer!, 0, buf);
	}

	#processPendingFrameUpdates(chartId: string): void {
		if (this.#pendingFrameUpdates.has(chartId)) {
			this.updateChartFrameUniforms(chartId);
			this.#pendingFrameUpdates.delete(chartId);
		}
	}

	// =========================================================================
	// LAYER MANAGEMENT
	// =========================================================================

	registerLayer(chartId: string, layerConfig: Partial<LayerConfig>): LayerRegistrationResult {
		const layerId = layerConfig.id || `layer-${crypto.randomUUID().slice(0, 8)}`;
		const chart = this.#registeredCharts.get(chartId);

		if (!chart) {
			// Queue for when the chart registers (e.g. facet cells registering async)
			if (!this.#pendingLayers.has(chartId)) {
				this.#pendingLayers.set(chartId, []);
			}
			this.#pendingLayers
				.get(chartId)!
				.push({ ...layerConfig, id: layerId, zIndex: layerConfig.zIndex ?? 0 } as LayerConfig);

			return {
				remove: () => {
					const pending = this.#pendingLayers.get(chartId);
					if (pending) {
						const idx = pending.findIndex((l) => l.id === layerId);
						if (idx !== -1) pending.splice(idx, 1);
					} else {
						this.unregisterLayer(chartId, layerId);
					}
				}
			};
		}

		chart.layers.set(layerId, {
			...layerConfig,
			id: layerId,
			zIndex: layerConfig.zIndex ?? 0
		} as LayerConfig);
		chart.needsPlanRebuild = true;
		this.invalidateChart(chartId);

		return {
			remove: () => this.unregisterLayer(chartId, layerId)
		};
	}

	/**
	 * Drop a chart's cached render plan, so the next frame rebuilds it.
	 *
	 * The plan caches one pipeline per layer, read from the renderer when it was
	 * built. A renderer that swaps its pipeline — recompiling for a scale type
	 * that resolved after it started — is otherwise invisible here, and the
	 * chart goes on drawing through the pipeline it cached.
	 */
	rebuildRenderPlan(chartId: string): void {
		const chart = this.#registeredCharts.get(chartId);
		if (!chart) return;
		chart.needsPlanRebuild = true;
		this.invalidateChart(chartId);
	}

	/**
	 * Which scale each chart resolves its axes through.
	 *
	 * A mark's shader reads its chart's scales as immediates, written per pass
	 * from these ids, so a chart pointing at the wrong scale renders through another chart's band layout
	 * and slot table — every id resolving to a slot it does not own. Nothing on
	 * the CPU side shows that: the scale, its domain and its axis are all
	 * correct, and only the pixels are wrong. This is the join between them.
	 */
	debugChartScales(): Array<Record<string, unknown>> {
		const out: Array<Record<string, unknown>> = [];
		for (const chart of this.#registeredCharts.values()) {
			out.push({
				chartId: chart.chartId,
				xScaleId: chart.xScaleId,
				yScaleId: chart.yScaleId,
				layers: [...chart.layers.values()].map((l) => l.markType).join(', ')
			});
		}
		return out;
	}

	/**
	 * Every scale the coordinator can write params for, as it sees them.
	 *
	 * The registry's inventory is not this list. The coordinator holds scale
	 * INSTANCES, and one the registry has dropped — destroyed on a refcount
	 * reaching zero while a component still held it — stays here until the next
	 * rebuild. So a chart can resolve an id to an object no inventory of the
	 * registry can show.
	 */
	debugScales(): Array<Record<string, unknown>> {
		return this.#scales.map((instance) => {
			const scale = instance as unknown as {
				id: string;
				name?: string;
				type?: string;
				sourceField?: string;
				isDestroyed?: boolean;
				getConfig?: () => { categoryCount: number };
				slots?: SlotSource;
			};
			return {
				id: scale.id,
				field: scale.sourceField ?? scale.name,
				type: scale.type,
				destroyed: scale.isDestroyed ?? false,
				categoryCount: scale.getConfig?.().categoryCount,
				slotBase: this.#identitySlots?.offsets.get(scale.id),
				slots: scale.slots ? Array.from(scale.slots.to).join(', ') : null
			};
		});
	}

	unregisterLayer(chartId: string, layerId: string): void {
		const chart = this.#registeredCharts.get(chartId);
		if (chart?.layers.has(layerId)) {
			chart.layers.delete(layerId);
			chart.needsPlanRebuild = true;
			this.invalidateChart(chartId);
		}
	}

	#buildRenderPlanForChart(chartConfig: ChartConfig): void {
		const layers = Array.from(chartConfig.layers.values());
		if (layers.length === 0) {
			chartConfig.renderPlan = [];
			chartConfig.needsPlanRebuild = false;
			return;
		}

		const zIndexGroups = new Map<number, LayerConfig[]>();
		for (const layer of layers) {
			const zIndex = layer.zIndex;
			if (!zIndexGroups.has(zIndex)) zIndexGroups.set(zIndex, []);
			zIndexGroups.get(zIndex)!.push(layer);
		}

		const sortedZLevels = Array.from(zIndexGroups.keys()).sort((a, b) => a - b);
		const newPlan: LayerConfig[] = [];

		for (const zLevel of sortedZLevels) {
			const layersInZLevel = zIndexGroups.get(zLevel)!;

			// Cache pipeline references, then group by pipeline identity
			// to minimize setPipeline calls within a render pass
			const pipelineGroups = new Map<GPURenderPipeline | null, LayerConfig[]>();
			for (const layer of layersInZLevel) {
				layer.cachedPipeline = layer.renderer?.pipeline ?? null;
				const key = layer.cachedPipeline;
				if (!pipelineGroups.has(key)) pipelineGroups.set(key, []);
				pipelineGroups.get(key)!.push(layer);
			}

			for (const batchedLayers of pipelineGroups.values()) {
				newPlan.push(...batchedLayers);
			}
		}

		chartConfig.renderPlan = newPlan;
		chartConfig.needsPlanRebuild = false;
	}

	// =========================================================================
	// RENDER PASS DESCRIPTOR
	// =========================================================================

	// #createRenderPassDescriptor(textureView, canvas, chartId) {
	// 	const chart = this.#registeredCharts.get(chartId);

	// 	if (this.#msaaSampleCount > 1) {
	// 		let msaa = this.#msaaCache.get(chartId);

	// 		if (!msaa || msaa.texture.width !== canvas.width || msaa.texture.height !== canvas.height) {
	// 			msaa?.texture.destroy();

	// 			const newTexture = this.#device.createTexture({
	// 				size: { width: canvas.width, height: canvas.height },
	// 				sampleCount: this.#msaaSampleCount,
	// 				format: this.#presentationFormat,
	// 				usage: GPUTextureUsage.RENDER_ATTACHMENT
	// 			});

	// 			msaa = { texture: newTexture, view: newTexture.createView() };
	// 			this.#msaaCache.set(chartId, msaa);

	// 			if (chart) chart.renderPassDescriptor = null;
	// 		}

	// 		if (chart?.renderPassDescriptor) {
	// 			chart.renderPassDescriptor.colorAttachments[0].resolveTarget = textureView;
	// 			return chart.renderPassDescriptor;
	// 		}

	// 		const desc = {
	// 			colorAttachments: [
	// 				{
	// 					view: msaa.view,
	// 					resolveTarget: textureView,
	// 					clearValue: { r: 0, g: 0, b: 0, a: 0 },
	// 					loadOp: 'clear',
	// 					storeOp: 'store'
	// 				}
	// 			]
	// 		};

	// 		if (chart) chart.renderPassDescriptor = desc;
	// 		return desc;
	// 	} else {
	// 		if (chart?.renderPassDescriptor) {
	// 			chart.renderPassDescriptor.colorAttachments[0].view = textureView;
	// 			return chart.renderPassDescriptor;
	// 		}

	// 		const desc = {
	// 			colorAttachments: [
	// 				{
	// 					view: textureView,
	// 					clearValue: { r: 0, g: 0, b: 0, a: 0 },
	// 					loadOp: 'clear',
	// 					storeOp: 'store'
	// 				}
	// 			]
	// 		};

	// 		if (chart) chart.renderPassDescriptor = desc;
	// 		return desc;
	// 	}
	// }

	#createRenderPassDescriptor(
		textureView: GPUTextureView,
		chartConfig: ChartConfig
	): GPURenderPassDescriptor {
		const canvas = chartConfig.canvas;

		if (this.#msaaSampleCount > 1) {
			let msaa = chartConfig.msaa;

			if (!msaa || msaa.texture.width !== canvas.width || msaa.texture.height !== canvas.height) {
				// console.warn('MSAA RECREATE!', {
				// 	hadMsaa: !!msaa,
				// 	oldSize: msaa ? `${msaa.texture.width}x${msaa.texture.height}` : 'none',
				// 	newSize: `${canvas.width}x${canvas.height}`,
				// 	chartId: chartConfig.chartId
				// });

				msaa?.texture.destroy();

				// TRANSIENT_ATTACHMENT (Chrome 146+) hints that the MSAA texture is only
				// needed within this render pass. On tile-based GPUs (Apple Silicon), this
				// avoids VRAM allocation and keeps the texture in fast on-chip tile memory.
				const transient =
					(GPUTextureUsage as unknown as Record<string, number>).TRANSIENT_ATTACHMENT ?? 0;

				const newTexture = this.#device!.createTexture({
					size: { width: canvas.width, height: canvas.height },
					sampleCount: this.#msaaSampleCount,
					format: this.#presentationFormat!,
					usage: GPUTextureUsage.RENDER_ATTACHMENT | transient
				});

				msaa = { texture: newTexture, view: newTexture.createView() };
				chartConfig.msaa = msaa;
				chartConfig.renderPassDescriptor = null;
			}

			if (chartConfig.renderPassDescriptor) {
				(
					chartConfig.renderPassDescriptor.colorAttachments as GPURenderPassColorAttachment[]
				)[0].resolveTarget = textureView;
				return chartConfig.renderPassDescriptor;
			}

			const desc: GPURenderPassDescriptor = {
				colorAttachments: [
					{
						view: msaa.view,
						resolveTarget: textureView,
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
						loadOp: 'clear' as GPULoadOp,
						// storeOp: 'store'
						storeOp: 'discard' as GPUStoreOp
					}
				]
			};

			chartConfig.renderPassDescriptor = desc;
			return desc;
		} else {
			if (chartConfig.renderPassDescriptor) {
				(
					chartConfig.renderPassDescriptor.colorAttachments as GPURenderPassColorAttachment[]
				)[0].view = textureView;
				return chartConfig.renderPassDescriptor;
			}

			const desc: GPURenderPassDescriptor = {
				colorAttachments: [
					{
						view: textureView,
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
						loadOp: 'clear' as GPULoadOp,
						storeOp: 'store' as GPUStoreOp
					}
				]
			};

			chartConfig.renderPassDescriptor = desc;
			return desc;
		}
	}
	// =========================================================================
	// GETTERS
	// =========================================================================

	get device(): GPUDevice | null {
		return this.#device;
	}
	get presentationFormat(): GPUTextureFormat | null {
		return this.#presentationFormat;
	}
	get msaaSampleCount(): number {
		return this.#msaaSampleCount;
	}
	get isInitialized(): boolean {
		return this.#initialized;
	}

	/**
	 * Promise that resolves when WebGPU initialization completes.
	 * Use this instead of polling isInitialized.
	 * @returns {Promise<boolean>}
	 */
	get ready(): Promise<boolean> {
		return this.#readyPromise;
	}

	get colorConfigBuffer(): GPUBuffer | null {
		return this.#colorConfigBuffer;
	}

	get colorRampBuffer(): GPUBuffer | null {
		return this.#colorRampBuffer;
	}

	get colorPaletteBuffer(): GPUBuffer | null {
		return this.#colorPaletteBuffer;
	}

	/**
	 * Keep a mark's scale block filled on frames its chart draws. Register
	 * again with new ids, after removing the old one, when the list changes.
	 */
	registerScaleBlock(chartId: string, block: ScaleBlock): { remove(): void } {
		const n = block.scaleIds.length * 4;
		const entry: ScaleBlockEntry = {
			...block,
			view: new Float32Array(n),
			last: new Float32Array(n).fill(NaN)
		};
		let blocks = this.#scaleBlocks.get(chartId);
		if (!blocks) this.#scaleBlocks.set(chartId, (blocks = new Set()));
		blocks.add(entry);
		this.invalidateChart(chartId);
		return {
			remove: () => {
				blocks.delete(entry);
				if (blocks.size === 0 && this.#scaleBlocks.get(chartId) === blocks)
					this.#scaleBlocks.delete(chartId);
			}
		};
	}

	// =========================================================================
	// PRE-RENDER COMPUTE WORK
	// =========================================================================

	/**
	 * Register a compute function to run before the render passes.
	 *
	 * With a `chartId`, only on frames that chart draws: M4 decimation, whose
	 * output only its own chart reads, and which otherwise re-binned on every
	 * frame any chart on the page drew. Without one, every rendered frame.
	 */
	registerComputeWork(key: string, computeFn: ComputeWorkFn, chartId: string | null = null): void {
		this.#computeWork.set(key, { fn: computeFn, chartId });
	}

	removeComputeWork(key: string): void {
		this.#computeWork.delete(key);
	}

	// =========================================================================
	// CLEANUP
	// =========================================================================

	#destroyColorScaleBuffers(): void {
		this.#colorConfigBuffer?.destroy();
		this.#colorRampBuffer?.destroy();
		this.#colorPaletteBuffer?.destroy();
		this.#sizeConfigBuffer?.destroy();
		// The slot tables and their resolve inputs and output.
		this.#identitySlotBuffer?.destroy();
		this.#identitySlotBufferTo?.destroy();
		this.#identitySlotResolved?.destroy();

		this.#colorConfigBuffer = null;
		this.#colorRampBuffer = null;
		this.#colorPaletteBuffer = null;
		this.#sizeConfigBuffer = null;
		this.#identitySlotBuffer = null;
		this.#identitySlotBufferTo = null;
		this.#identitySlotResolved = null;
		this.#slotResolveBindGroup = null;
		this.#identitySlots = null;
	}

	destroy(): void {
		console.log('Destroying GPUCoordinator');

		// Stop animation loop
		this.#animationLoop?.destroy();
		this.#animationLoop = null;

		// Cleanup timestamp query resources (FIXED: was leaking)
		this.#resolveBuffer?.destroy();
		this.#resultBuffer?.destroy();
		this.#querySet = null; // QuerySet has no destroy(), just null reference

		// Destroy retained and pending-release renderers
		for (const retained of this.#retainedRenderers.values()) {
			retained.destroy();
		}
		this.#retainedRenderers.clear();
		for (let i = 0; i < this.#pendingReleases.length; i++) {
			this.#pendingReleases[i].destroy();
		}
		this.#pendingReleases.length = 0;

		// Force release all renderer resources
		for (const rendererId of this.#rendererRegistry.keys()) {
			this.releaseRenderer(rendererId);
		}
		this.#rendererRegistry.clear();

		this.#animatedSources.clear();
		this.#animatedSourcesArray.length = 0;
		this.#hoveredCharts.clear();

		// Cleanup MSAA textures
		// for (const msaa of this.#msaaCache.values()) {
		// 	msaa.texture?.destroy();
		// }
		// this.#msaaCache.clear();

		this.#scaleResourcesLayout = null;
		this.#scaleResourcesBindGroup = null;

		this.#destroyColorScaleBuffers();

		// Cleanup charts
		for (const [, chartConfig] of this.#registeredCharts) {
			chartConfig.frameUniformsBuffer?.destroy();
		}
		this.#registeredCharts.clear();
		this.#dirtyChartsArray.length = 0;

		// Cleanup layouts
		this.#dataLayouts.clear();
		this.#frameLayout = null;
		this.#pendingScaleMappings.clear();
		this.#scaleBlocks.clear();
		this.#pendingLayers.clear();

		// Destroy device
		this.#device?.destroy();
		this.#device = null;

		this.#initialized = false;
		console.log('GPUCoordinator destruction complete');
	}
}

// =============================================================================
// CONTEXT HELPERS
// =============================================================================

export function setGPUCoordinator(config: GPUCoordinatorConfig = {}): GPUCoordinator {
	const coordinator = new GPUCoordinator(config);

	if (typeof window !== 'undefined') {
		coordinator.initialize().catch((error) => {
			console.error('Failed to initialize GPU coordinator:', error);
		});
	}

	return setContext('gpu-coordinator', coordinator);
}

export function getGPUContext(): GPUCoordinator | null {
	const coordinator = getContext<GPUCoordinator>('gpu-coordinator');

	if (!coordinator) {
		console.error(
			'GPU Coordinator context missing. Make sure to call setGPUCoordinator() in a parent component.'
		);
		return null;
	}

	return coordinator;
}
