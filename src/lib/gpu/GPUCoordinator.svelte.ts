import { setContext, getContext } from 'svelte';
import { AnimationLoop } from '$lib/animation';
import { scaleTemplateSystem } from './ScaleTemplateSystem';
import type { RendererDefinition } from './ScaleTemplateSystem';
import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
import { isCategoricalScale } from '$lib/scales/scale-categories';

/** Number of color stops per ramp slot. Shared with ColorScaleState for bakeGradient(). */
export const COLOR_RAMP_RESOLUTION = 256;

// =============================================================================
// TYPE INTERFACES
// =============================================================================

interface ChartConfig {
	chartId: string;
	canvas: HTMLCanvasElement;
	zIndex: number;
	facetIndex: number;
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
}

export interface DataBindingEntry {
	binding: number;
	visibility?: number;
	type?: string;
}

interface ScaleInstance {
	id: string;
	type: string;
	constructor: { name: string };
	gpuState?: { domainMin: number; domainMax: number; domainScale: number; p4: number };
	getConfig?: () => { categoryCount: number; paddingInner: number; paddingOuter: number };
	step: () => void;
	updateRenderState: (dt: number) => void;
	isAtRest: () => boolean;
	_markAtRest: () => void;
	_applyInput?: () => void;
	_affectedChartsArray?: string[];
}

interface ScaleArrayEntry {
	instance: ScaleInstance;
	index: number;
}

type ComputeWorkFn = (commandEncoder: GPUCommandEncoder, scaleBindGroup: GPUBindGroup) => void;
type FrameCallback = (isAnimating: boolean) => void;

interface GPUCoordinatorConfig {
	msaaSampleCount?: number;
}

interface ChartRegistrationConfig {
	zIndex?: number;
	facetIndex?: number;
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

/**
 * Manages mapping from scale IDs to SSBO indices.
 * Rebuilds indices when scale topology changes.
 */
class ScaleIndexManager {
	#scaleIds: string[] = [];
	#scaleIdToIndex = new Map<string, number>();

	rebuild(allCurrentScaleIds: Iterable<string>): number {
		this.#scaleIds = [...allCurrentScaleIds];
		this.#scaleIdToIndex.clear();

		this.#scaleIds.forEach((scaleId, index) => {
			this.#scaleIdToIndex.set(scaleId, index);
		});

		return this.#scaleIds.length;
	}

	getIndex(scaleId: string): number | undefined {
		return this.#scaleIdToIndex.get(scaleId);
	}

	getCount(): number {
		return this.#scaleIds.length;
	}

	getAllScaleIds(): string[] {
		return [...this.#scaleIds];
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
 * - Scale SSBO management for GPU-based domain transforms
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
	#animatedScales = new Set<ScaleInstance>(); // Set for O(1) membership check
	#animatedScalesArray: ScaleInstance[] = []; // Array for O(1) iteration (no allocation)
	#scaleRegistry: ScaleRegistry | null = null;

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
	#computeWork = new Map<string, ComputeWorkFn>(); // key -> computeFn(commandEncoder, scaleBindGroup)

	// =========================================================================
	// SCALE SSBO SYSTEM
	// =========================================================================
	#scaleIndexManager = new ScaleIndexManager();
	#maxScaleSlots = 256;
	#SSBO_SLOT_COUNT = 16;

	#globalScaleLayout: GPUBindGroupLayout | null = null;
	#globalScaleSSBO: GPUBuffer | null = null;
	#slotByteSize: number | null = null;
	#globalScaleBindGroups: GPUBindGroup[] = [];
	#cpuScaleBuffer: Float32Array | null = null; // Reusable CPU buffer for scale data
	/**
	 * Band identity id -> display slot, shared by every band and point scale at
	 * a per-scale base carried in that scale's p4 (§9.5, §14.3).
	 *
	 * A uniform buffer because the vertex stage is already at the default
	 * maxStorageBuffersPerShaderStage of 8. 64 KB is the default
	 * maxUniformBufferBindingSize, so 16384 floats GLOBALLY across all such
	 * scales.
	 *
	 * Layout: index 0 is a permanent zero-length block, then one block per
	 * scale of `[count, slot0, slot1, ...]`. The count makes each block
	 * self-describing, so the shader can reject an id past this scale's end
	 * instead of reading into the next scale's slots — the ids and the table
	 * can disagree transiently while a dim appends. Budget is therefore
	 * 16384 - 1 - (1 per scale) slots.
	 */
	#BAND_SLOT_CAPACITY = 16384;
	/**
	 * Base of the zero-length block. A scale that cannot be placed points here,
	 * so every lookup finds count 0 and discards — which is what the capacity
	 * warning claims happens. Pointing it at a stale base instead left the
	 * scale rendering, from another scale's slots.
	 */
	#BAND_SLOT_EMPTY = 0;
	#bandSlotBuffer: GPUBuffer | null = null;
	#cpuBandSlots: Float32Array | null = null;
	/** Last uploaded slotVersion per scale, so a static chart uploads nothing. */
	#bandSlotVersions = new Map<string, number>();
	/** Per-scale offset into #cpuBandSlots, written into p4 by #fillAllScales. */
	#bandSlotOffsets = new Map<string, number>();

	#scaleIdToInstance = new Map<string, ScaleInstance>(); // scaleId -> scale instance
	#scaleArray: ScaleArrayEntry[] = []; // Flat array for hot loop: [{instance, index}]

	#frameId = 0;

	// =========================================================================
	// COLOR BUFFER DECLARATIONS
	// =========================================================================
	// Color scale buffers (group 2, bindings 1-3)
	#colorConfigBuffer: GPUBuffer | null = null; // 64 configs × 32 bytes = 2KB
	#colorRampBuffer: GPUBuffer | null = null; // 64 ramps × 256 colors × 16 bytes = 256KB
	#colorPaletteBuffer: GPUBuffer | null = null; // 64 palettes × 32 colors × 16 bytes = 32KB

	// Size scale buffer (group 2, binding 4)
	#sizeConfigBuffer: GPUBuffer | null = null; // 64 configs × 16 bytes = 1KB
	#maxSizeSlots = 64;

	// Constants
	#maxColorSlots = 64;
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
	#acquiredTextures: { chartConfig: ChartConfig; texture: GPUTexture; view: GPUTextureView }[] = []; // Reused array for texture acquisition
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
		this.#scaleIndexManager = new ScaleIndexManager();

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
	// SCALE SSBO SYSTEM
	// =========================================================================

	// async #initializeScaleBindGroupLayouts() {
	// 	this.#globalScaleLayout = this.#device.createBindGroupLayout({
	// 		label: 'global-scale-ssbo-layout',
	// 		entries: [
	// 			{
	// 				binding: 0,
	// 				visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
	// 				buffer: { type: 'read-only-storage' }
	// 			}
	// 		]
	// 	});

	// 	this.#createGlobalScaleSSBO();

	// 	// Pre-create bind groups for each slot
	// 	for (let slot = 0; slot < this.#SSBO_SLOT_COUNT; slot++) {
	// 		const slotOffset = slot * this.#slotByteSize;
	// 		this.#globalScaleBindGroups[slot] = this.#device.createBindGroup({
	// 			label: `global-scale-bind-group-slot-${slot}`,
	// 			layout: this.#globalScaleLayout,
	// 			entries: [
	// 				{
	// 					binding: 0,
	// 					resource: {
	// 						buffer: this.#globalScaleSSBO,
	// 						offset: slotOffset,
	// 						size: this.#slotByteSize
	// 					}
	// 				}
	// 			]
	// 		});
	// 	}
	// }

	async #initializeScaleBindGroupLayouts(): Promise<void> {
		this.#globalScaleLayout = this.#device!.createBindGroupLayout({
			label: 'global-scale-ssbo-layout',
			entries: [
				{
					// Binding 0: Coordinate scale params (vertex + fragment + compute for M4 decimation)
					binding: 0,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
					buffer: { type: 'read-only-storage' }
				},
				{
					// Binding 1: Color scale configs (fragment only)
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT, // ← Changed
					buffer: { type: 'read-only-storage' }
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
					// Binding 4: Size scale configs (vertex only)
					binding: 4,
					visibility: GPUShaderStage.VERTEX,
					buffer: { type: 'read-only-storage' }
				},
				{
					// Binding 5: Band identity id -> display slot (vertex only).
					// Uniform, not storage: the vertex stage is at the default
					// storage limit of 8 (§14.1). Declared on every layout even
					// though only band shaders read it — a pipeline layout may
					// expose more than its shader uses, and this group's uniform
					// buffers are nowhere near the default 12.
					binding: 5,
					visibility: GPUShaderStage.VERTEX,
					buffer: { type: 'uniform' }
				}
			]
		});

		this.#createGlobalScaleSSBO();

		// Create color scale buffers (must happen before bind group creation)
		this.#createColorScaleBuffers();
		this.#createBandSlotBuffer();

		// Pre-create bind groups for each slot
		for (let slot = 0; slot < this.#SSBO_SLOT_COUNT; slot++) {
			const slotOffset = slot * this.#slotByteSize!;
			this.#globalScaleBindGroups[slot] = this.#device!.createBindGroup({
				label: `global-scale-bind-group-slot-${slot}`,
				layout: this.#globalScaleLayout,
				entries: [
					{
						// Coordinate scales - uses slot offset
						binding: 0,
						resource: {
							buffer: this.#globalScaleSSBO!,
							offset: slotOffset,
							size: this.#slotByteSize!
						}
					},
					{
						// Color configs - full buffer, no offset
						binding: 1,
						resource: {
							buffer: this.#colorConfigBuffer!
						}
					},
					{
						// Color ramps - full buffer, no offset
						binding: 2,
						resource: {
							buffer: this.#colorRampBuffer!
						}
					},
					{
						// Ordinal palettes - full buffer, no offset
						binding: 3,
						resource: {
							buffer: this.#colorPaletteBuffer!
						}
					},
					{
						// Size configs - full buffer, no offset
						binding: 4,
						resource: {
							buffer: this.#sizeConfigBuffer!
						}
					},
					{
						// Band identity slot table - full buffer, no offset
						binding: 5,
						resource: {
							buffer: this.#bandSlotBuffer!
						}
					}
				]
			});
		}
	}

	#createGlobalScaleSSBO(): void {
		const scaleParamSize = 16; // 4 floats * 4 bytes
		this.#slotByteSize = this.#maxScaleSlots * scaleParamSize;
		const totalSSBOSize = this.#slotByteSize * this.#SSBO_SLOT_COUNT;

		this.#globalScaleSSBO = this.#device!.createBuffer({
			size: totalSSBOSize,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			label: 'global-scale-ssbo-ring'
		});

		// CPU buffer for building scale data (reused each frame)
		this.#cpuScaleBuffer = new Float32Array(this.#slotByteSize / 4);
	}

	#createColorScaleBuffers(): void {
		const device = this.#device!;

		// ColorConfig buffer: 64 slots × 32 bytes each
		this.#colorConfigBuffer = device.createBuffer({
			label: 'ColorConfig SSBO',
			size: this.#maxColorSlots * 32,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
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

		// Size config buffer: 64 slots × 16 bytes each
		this.#sizeConfigBuffer = device.createBuffer({
			label: 'SizeConfig SSBO',
			size: this.#maxSizeSlots * 16,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
	}

	/**
	 * Fill CPU buffer with current scale GPU state.
	 * Zero-allocation hot path.
	 */
	/** 64 KB uniform buffer for the shared band slot table. */
	#createBandSlotBuffer(): void {
		if (this.#bandSlotBuffer) return;
		this.#cpuBandSlots = new Float32Array(this.#BAND_SLOT_CAPACITY);
		this.#cpuBandSlots.fill(-1);
		// The permanent empty block: count 0, so it holds no slots.
		this.#cpuBandSlots[this.#BAND_SLOT_EMPTY] = 0;
		this.#bandSlotBuffer = this.#device!.createBuffer({
			label: 'band-slot-table',
			size: this.#BAND_SLOT_CAPACITY * 4,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
	}

	/**
	 * Pack every band/point scale's slot table into the shared buffer and assign
	 * each one an offset, which #fillAllScales then writes into its p4.
	 *
	 * Uploads only when something moved: slot tables change on reorder, not per
	 * frame, so a static chart costs no writeBuffer here. Offsets are recomputed
	 * every call because a scale appearing or disappearing shifts the ones after
	 * it — cheap, since it is a running sum over a handful of scales.
	 */
	#updateBandSlots(): void {
		if (!this.#cpuBandSlots) return;

		// Index 0 is the permanent empty block; real blocks start after it.
		let offset = 1;
		let dirty = false;
		const seen = new Set<string>();

		for (let i = 0; i < this.#scaleArray.length; i++) {
			const scale = this.#scaleArray[i].instance as unknown as {
				id: string;
				type: string;
				slotTable?: Float32Array;
				slotVersion?: number;
			};
			if (!isCategoricalScale(scale.type) || !scale.slotTable) continue;

			const table = scale.slotTable;
			seen.add(scale.id);

			// One extra float for the block's count header.
			const need = table.length + 1;
			const fits = offset + need <= this.#BAND_SLOT_CAPACITY;
			const base = fits ? offset : this.#BAND_SLOT_EMPTY;
			if (fits) offset += need;

			if (
				this.#bandSlotOffsets.get(scale.id) !== base ||
				this.#bandSlotVersions.get(scale.id) !== scale.slotVersion
			) {
				if (fits) {
					this.#cpuBandSlots[base] = table.length;
					this.#cpuBandSlots.set(table, base + 1);
				} else {
					// Warn on the transition only — this runs every frame.
					console.warn(
						`[GPUCoordinator] Band slot capacity (${this.#BAND_SLOT_CAPACITY}) exhausted; ` +
							`scale "${scale.id}" (${table.length} ids) will not render.`
					);
				}
				this.#bandSlotOffsets.set(scale.id, base);
				this.#bandSlotVersions.set(scale.id, scale.slotVersion ?? 0);
				dirty = true;
			}
			// No break: a later scale with a smaller table may still fit, and one
			// that does not is parked on the empty block rather than left holding
			// a base that now belongs to someone else.
		}

		// Drop entries for scales that have gone away, so a re-registered id
		// cannot inherit a base from a previous life.
		if (this.#bandSlotOffsets.size !== seen.size) {
			for (const id of this.#bandSlotOffsets.keys()) {
				if (!seen.has(id)) {
					this.#bandSlotOffsets.delete(id);
					this.#bandSlotVersions.delete(id);
				}
			}
		}

		if (dirty) {
			this.#device!.queue.writeBuffer(
				this.#bandSlotBuffer!,
				0,
				this.#cpuBandSlots as Float32Array<ArrayBuffer>,
				0,
				offset
			);
		}
	}

	#fillAllScales(view: Float32Array): void {
		const len = this.#scaleArray.length;
		for (let i = 0; i < len; i++) {
			const item = this.#scaleArray[i];
			const scale = item.instance;
			const off = item.index << 2;

			if (isCategoricalScale(scale.type)) {
				// BAND SCALE: Write configuration
				const config = scale.getConfig!();

				view[off] = config.categoryCount;
				view[off + 1] = config.paddingInner;
				view[off + 2] = config.paddingOuter;
				// p4: this scale's base offset into the shared band slot table.
				view[off + 3] = this.#bandSlotOffsets.get((scale as { id: string }).id) ?? 0;
			} else {
				// CONTINUOUS SCALE: Write domain state (linear, time, log, symlog)
				const s = scale.gpuState!;

				view[off] = s.domainMin;
				view[off + 1] = s.domainMax;
				view[off + 2] = s.domainScale;
				view[off + 3] = s.p4; // symlog constant C, 0 for linear/log/time
			}
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
		const len = this.#animatedScalesArray.length;
		for (let i = 0; i < len; i++) {
			this.#animatedScalesArray[i].step();
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
		for (let i = 0; i < this.#animatedScalesArray.length; i++) {
			this.#animatedScalesArray[i]._applyInput?.();
		}

		// 2. Update render state with extrapolation for ALL scales first
		const len = this.#animatedScalesArray.length;
		for (let i = 0; i < len; i++) {
			this.#animatedScalesArray[i].updateRenderState(extrapolationDt);
		}

		// 3. Gather charts to render BEFORE removing rested scales
		const chartArray = this.#chartsToRenderArray;
		chartArray.length = 0;
		const currentRenderId = this.#frameId;

		// Add charts affected by animated scales
		for (let i = 0; i < this.#animatedScalesArray.length; i++) {
			const scale = this.#animatedScalesArray[i];
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
		for (let i = this.#animatedScalesArray.length - 1; i >= 0; i--) {
			const scale = this.#animatedScalesArray[i];

			if (scale.isAtRest()) {
				scale._markAtRest();
				// Swap and pop removal (O(1))
				this.#animatedScales.delete(scale);
				const last = this.#animatedScalesArray.pop()!;
				if (i < this.#animatedScalesArray.length) {
					this.#animatedScalesArray[i] = last;
				}
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
		this.#isAnimating = this.#animatedScales.size > 0;
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
			this.#animatedScales.size === 0 &&
			this.#dirtyChartsArray.length === 0 &&
			this.#hoveredCharts.size === 0 &&
			this.#pendingReleases.length === 0
		);
	};

	// =========================================================================
	// RENDER PIPELINE
	// =========================================================================

	#coordinatedRender(chartsNeedingRender: ChartConfig[]): void {
		const slot = this.#frameId % this.#SSBO_SLOT_COUNT;

		// PHASE 1: EARLY TEXTURE ACQUISITION
		this.#acquiredTextures.length = 0;

		const numCharts = chartsNeedingRender.length;
		for (let i = 0; i < numCharts; i++) {
			const chartConfig = chartsNeedingRender[i];
			const texture = chartConfig.context.getCurrentTexture();
			const view = texture.createView();
			this.#acquiredTextures.push({ chartConfig, texture, view });
		}

		// PHASE 2: CPU WORK (Scale buffer updates)
		this.#updateBandSlots();
		this.#fillAllScales(this.#cpuScaleBuffer!);

		const dstOffset = slot * this.#slotByteSize!;
		this.#device!.queue.writeBuffer(
			this.#globalScaleSSBO!,
			dstOffset,
			this.#cpuScaleBuffer! as Float32Array<ArrayBuffer>,
			0,
			this.#cpuScaleBuffer!.length
		);

		// PHASE 3: GPU COMMAND ENCODING
		const commandEncoder = this.#device!.createCommandEncoder(this.#encoderDescriptor);
		const currentScaleBindGroup = this.#globalScaleBindGroups[slot];

		// PHASE 3a: PRE-RENDER COMPUTE (M4 decimation, etc.)
		if (this.#computeWork.size > 0) {
			for (const computeFn of this.#computeWork.values()) {
				computeFn(commandEncoder, currentScaleBindGroup);
			}
		}

		for (let i = 0; i < this.#acquiredTextures.length; i++) {
			// for (let i = 0; i < numCharts; i++) {
			const { chartConfig, texture, view } = this.#acquiredTextures[i];
			// const chartConfig = chartsNeedingRender[i];
			// const texture = chartConfig.context.getCurrentTexture();
			// const view = texture.createView();

			if (chartConfig.needsPlanRebuild) {
				this.#buildRenderPlanForChart(chartConfig);
			}

			const passEncoder = commandEncoder.beginRenderPass(
				this.#createRenderPassDescriptor(view, chartConfig)
				// this.#createRenderPassDescriptor(view, chartConfig.canvas, chartConfig.chartId)
			);

			if (chartConfig.perFrameBindGroup) {
				passEncoder.setBindGroup(0, chartConfig.perFrameBindGroup);
				passEncoder.setBindGroup(2, currentScaleBindGroup);

				const plan = chartConfig.renderPlan;
				const planLen = plan.length;

				let currentPipeline: GPURenderPipeline | null = null;
				let currentPerDataBindGroup: GPUBindGroup | null = null;

				for (let j = 0; j < planLen; j++) {
					const layer = plan[j];
					const renderer = layer.renderer;

					if (!renderer || !renderer.perDataBindGroup) continue;

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
		}

		// PHASE 4: SUBMIT
		this.#submitArray[0] = commandEncoder.finish();
		this.#device!.queue.submit(this.#submitArray as [GPUCommandBuffer]);

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

		// Generate stable resource key (includes scale topology and renderer definition)
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
					bindGroupLayouts: [frameLayout, dataLayout, this.#globalScaleLayout!]
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

		// Clear and rebuild
		const ids: string[] = [];
		this.#scaleIdToInstance.clear();
		this.#scaleArray = [];

		for (const [scaleInstance, chartIds] of usageMap) {
			// Only positional scales (Linear, Band, Time) have id and _affectedChartsArray
			const scale = scaleInstance as unknown as ScaleInstance;
			if (!scale?.id) continue;

			if (chartIds && typeof chartIds[Symbol.iterator] === 'function') {
				scale._affectedChartsArray = Array.from(chartIds);
			} else {
				scale._affectedChartsArray = [];
			}

			ids.push(scale.id);
			this.#scaleIdToInstance.set(scale.id, scale);
		}

		const count = this.#scaleIndexManager.rebuild(ids);

		// Build flat array for hot loop
		for (const scale of this.#scaleIdToInstance.values()) {
			const idx = this.#scaleIndexManager.getIndex(scale.id);
			if (idx !== undefined) {
				this.#scaleArray.push({ instance: scale, index: idx });
			}
		}

		// Grow SSBO if needed
		if (count > this.#maxScaleSlots) {
			let newSlots = this.#maxScaleSlots;
			while (newSlots < count) newSlots *= 2;
			this.#maxScaleSlots = newSlots;
			this.#recreateGlobalScalesSSBOAndBindGroups();
		}

		// Update per-chart uniforms (scale indices may have changed)
		for (const [chartId] of this.#registeredCharts) {
			this.updateChartFrameUniforms(chartId);
		}
	}

	#recreateGlobalScalesSSBOAndBindGroups(): void {
		console.log('Resizing Global Scale SSBO...');

		const oldSSBO = this.#globalScaleSSBO;

		const scaleParamSize = 16;
		this.#slotByteSize = this.#maxScaleSlots * scaleParamSize;
		const totalSSBOSize = this.#slotByteSize * this.#SSBO_SLOT_COUNT;

		try {
			const newSSBO = this.#device!.createBuffer({
				size: totalSSBOSize,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				label: `global-scale-ssbo-ring-v${this.#frameId}`
			});

			const newBindGroups: GPUBindGroup[] = [];
			for (let slot = 0; slot < this.#SSBO_SLOT_COUNT; slot++) {
				const offset = slot * this.#slotByteSize;
				newBindGroups[slot] = this.#device!.createBindGroup({
					label: `global-scale-bind-group-slot-${slot}`,
					layout: this.#globalScaleLayout!,
					entries: [
						{
							binding: 0,
							resource: {
								buffer: newSSBO,
								offset,
								size: this.#slotByteSize
							}
						},
						{
							binding: 1,
							resource: { buffer: this.#colorConfigBuffer! }
						},
						{
							binding: 2,
							resource: { buffer: this.#colorRampBuffer! }
						},
						{
							binding: 3,
							resource: { buffer: this.#colorPaletteBuffer! }
						},
						{
							binding: 4,
							resource: { buffer: this.#sizeConfigBuffer! }
						},
						{
							// Band slot table. Must be present here too — this path
							// rebuilds the bind groups on SSBO growth, and a bind
							// group missing an entry its layout declares is a
							// validation error at draw time, not here.
							binding: 5,
							resource: { buffer: this.#bandSlotBuffer! }
						}
					]
				});
			}

			this.#globalScaleSSBO = newSSBO;
			this.#globalScaleBindGroups = newBindGroups;
			this.#cpuScaleBuffer = new Float32Array(this.#slotByteSize / 4);

			if (oldSSBO) {
				oldSSBO.destroy();
			}
		} catch (error) {
			console.error('Failed to resize Scale SSBO. Keeping old buffer.', error);
		}
	}

	// =========================================================================
	// COLOR SCALE API
	// =========================================================================

	/**
	 * Write a ColorConfig struct to the config buffer.
	 *
	 * @param {number} slot - Config slot index (0-63)
	 * @param {ArrayBuffer} configData - 32-byte config struct from ColorScaleState
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

		const byteOffset = slot * 32;
		this.#device!.queue.writeBuffer(this.#colorConfigBuffer, byteOffset, configData);
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

	addAnimatingScale(scale: ScaleInstance): void {
		// console.log(`=== addAnimatingScale ${scale.name} (${scale.id}) ===`);
		let idx = this.#scaleIndexManager.getIndex(scale.id);
		// console.log('Initial index lookup:', idx);

		if (idx === undefined) {
			// console.log('Index undefined, calling registerScale...');
			this.registerScale(scale.id, 'linear');
			idx = this.#scaleIndexManager.getIndex(scale.id);
			// console.log('Index after registerScale:', idx);
			if (idx === undefined) {
				console.error(`Scale ${scale.id} still not registered after auto-register`);
				return;
			}
		}

		// console.log('Already in animatedScales Set?', this.#animatedScales.has(scale));

		if (!this.#animatedScales.has(scale)) {
			this.#animatedScales.add(scale);
			this.#animatedScalesArray.push(scale);
			// console.log('Added to animatedScales, new length:', this.#animatedScalesArray.length);
		}

		this.#animationLoop!.requestStart();
	}

	removeAnimatingScale(scale: ScaleInstance): void {
		if (this.#animatedScales.delete(scale)) {
			const idx = this.#animatedScalesArray.indexOf(scale);
			if (idx !== -1) {
				const lastItem = this.#animatedScalesArray.pop()!;
				if (idx < this.#animatedScalesArray.length) {
					this.#animatedScalesArray[idx] = lastItem;
				}
			}
		}
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

		const xScaleIndex = this.#scaleIndexManager.getIndex(chartConfig.xScaleId!) ?? 0;
		const yScaleIndex = this.#scaleIndexManager.getIndex(chartConfig.yScaleId!) ?? 1;

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
		u32[8] = xScaleIndex >>> 0;
		u32[9] = yScaleIndex >>> 0;
		u32[10] = (chartConfig.facetIndex ?? 0) >>> 0;
		u32[11] = 0; // padding
		f32[12] = nullColor[0]; // R
		f32[13] = nullColor[1]; // G
		f32[14] = nullColor[2]; // B
		f32[15] = nullColor[3]; // A

		this.#device!.queue.writeBuffer(chartConfig.frameUniformsBuffer!, 0, buf);

		// console.log(`📏 Frame uniforms for chart ${chartId}:`, {
		// 	rangeMinY: rangeMinY,
		// 	rangeMaxY: rangeMaxY,
		// 	rangeSize: rangeMaxY - rangeMinY,
		// 	yScaleIndex: yScaleIndex
		// });
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

	get globalScaleLayout(): GPUBindGroupLayout | null {
		return this.#globalScaleLayout;
	}

	getScaleIndex(scaleId: string): number | undefined {
		return this.#scaleIndexManager.getIndex(scaleId);
	}

	// =========================================================================
	// PRE-RENDER COMPUTE WORK
	// =========================================================================

	/**
	 * Register a compute function to run before render passes each frame.
	 * Used by M4 decimation and other GPU compute optimizations.
	 * @param {string} key - Unique identifier for this compute work
	 * @param {function(GPUCommandEncoder, GPUBindGroup): void} computeFn
	 */
	registerComputeWork(key: string, computeFn: ComputeWorkFn): void {
		this.#computeWork.set(key, computeFn);
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

		this.#colorConfigBuffer = null;
		this.#colorRampBuffer = null;
		this.#colorPaletteBuffer = null;
		this.#sizeConfigBuffer = null;
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

		this.#animatedScales.clear();
		this.#animatedScalesArray.length = 0;
		this.#hoveredCharts.clear();

		// Cleanup MSAA textures
		// for (const msaa of this.#msaaCache.values()) {
		// 	msaa.texture?.destroy();
		// }
		// this.#msaaCache.clear();

		// Cleanup SSBO
		this.#globalScaleSSBO?.destroy();
		this.#globalScaleLayout = null;

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
