import { setContext, getContext } from 'svelte';
import { AnimationLoop } from '$lib/animation';
import { scaleTemplateSystem } from './ScaleTemplateSystem.js';

// =============================================================================
// HELPER CLASSES
// =============================================================================

/**
 * Rolling average calculator for performance metrics.
 * Filters out negative/invalid values (important for GPU timestamps).
 */
class NonNegativeRollingAverage {
	#total = 0;
	#samples = [];
	#cursor = 0;
	#numSamples;

	constructor(numSamples = 120) {
		this.#numSamples = numSamples;
	}

	addSample(v) {
		if (!Number.isNaN(v) && Number.isFinite(v) && v >= 0) {
			this.#total += v - (this.#samples[this.#cursor] || 0);
			this.#samples[this.#cursor] = v;
			this.#cursor = (this.#cursor + 1) % this.#numSamples;
		}
	}

	get() {
		return this.#samples.length > 0 ? this.#total / this.#samples.length : 0;
	}
}

/**
 * Manages mapping from scale IDs to SSBO indices.
 * Rebuilds indices when scale topology changes.
 */
class ScaleIndexManager {
	#scaleIds = [];
	#scaleIdToIndex = new Map();

	rebuild(allCurrentScaleIds) {
		this.#scaleIds = [...allCurrentScaleIds];
		this.#scaleIdToIndex.clear();

		this.#scaleIds.forEach((scaleId, index) => {
			this.#scaleIdToIndex.set(scaleId, index);
		});

		return this.#scaleIds.length;
	}

	getIndex(scaleId) {
		return this.#scaleIdToIndex.get(scaleId);
	}

	getCount() {
		return this.#scaleIds.length;
	}

	getAllScaleIds() {
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
	#device = null;
	#presentationFormat = null;
	#initialized = $state(false);

	// Promise-based initialization (eliminates polling in WebGPUCanvas)
	#readyPromise;
	#resolveReady;

	// Timestamp query resources (optional, for GPU timing)
	#canTimestamp = false;
	#querySet = null;
	#resolveBuffer = null;
	#resultBuffer = null;

	// =========================================================================
	// RESOURCE REGISTRY (Renderer → Resources tracking)
	// =========================================================================
	// Maps rendererId → Map<resourceKey, {type, key}>
	// This is the single source of truth for "who owns what"
	#rendererRegistry = new Map();

	// =========================================================================
	// SHARED RESOURCES (Reference Counted)
	// =========================================================================
	#sharedResources = {
		pipelines: new Map(), // key -> { pipeline, refCount }
		shaderModules: new Map(), // key -> { module, refCount }
		bindGroupLayouts: new Map() // key -> { layout, refCount }
	};

	// =========================================================================
	// CHART MANAGEMENT
	// =========================================================================
	#registeredCharts = new Map(); // chartId -> chartConfig
	// #msaaCache = new Map(); // chartId -> { texture, view }
	#dirtyChartsArray = [];
	#msaaSampleCount = 1;

	// =========================================================================
	// ANIMATION SYSTEM
	// =========================================================================
	#animationLoop = null;
	#animatedScales = new Set(); // Set for O(1) membership check
	#animatedScalesArray = []; // Array for O(1) iteration (no allocation)
	#scaleRegistry = null;

	// =========================================================================
	// HOVER STATE (Keep loop warm while any chart is hovered)
	// =========================================================================
	#hoveredCharts = new Set();

	// =========================================================================
	// PER-FRAME CALLBACKS (for tooltip scheduling, etc.)
	// =========================================================================
	#frameCallbacks = [];
	#isAnimating = false; // True when scales are actively animating (pan/zoom)

	// =========================================================================
	// SCALE SSBO SYSTEM
	// =========================================================================
	#scaleIndexManager = new ScaleIndexManager();
	#maxScaleSlots = 256;
	#SSBO_SLOT_COUNT = 16;

	#globalScaleLayout = null;
	#globalScaleSSBO = null;
	#slotByteSize = null;
	#globalScaleBindGroups = [];
	#cpuScaleBuffer = null; // Reusable CPU buffer for scale data

	#scaleIdToInstance = new Map(); // scaleId -> scale instance
	#scaleArray = []; // Flat array for hot loop: [{instance, index}]

	#frameId = 0;

	// =========================================================================
	// COLOR BUFFER DECLARATIONS
	// =========================================================================
	// Color scale buffers (group 2, bindings 1-3)
	#colorConfigBuffer = null; // 64 configs × 32 bytes = 2KB
	#colorRampBuffer = null; // 64 ramps × 256 colors × 16 bytes = 256KB
	#colorPaletteBuffer = null; // 64 palettes × 32 colors × 16 bytes = 32KB

	// Size scale buffer (group 2, binding 4)
	#sizeConfigBuffer = null; // 64 configs × 16 bytes = 1KB
	#maxSizeSlots = 64;

	// Constants
	#maxColorSlots = 64;
	#rampColorsPerSlot = 256;
	#paletteColorsPerSlot = 32;

	// =========================================================================
	// LAYOUT CACHES
	// =========================================================================
	#templateSystem = scaleTemplateSystem;
	#frameLayout = null;
	#dataLayouts = new Map(); // markType-config -> GPUBindGroupLayout

	// =========================================================================
	// PENDING OPERATIONS
	// =========================================================================
	#pendingScaleMappings = new Map(); // chartId -> { xScaleId, yScaleId }
	#pendingFrameUpdates = new Map(); // chartId -> update params
	#topologyUpdateScheduled = false;

	// =========================================================================
	// RENDER LOOP STATE (Zero-Allocation)
	// =========================================================================
	#chartsToRenderArray = []; // Reused array for charts to render
	#acquiredTextures = []; // Reused array for texture acquisition
	#encoderDescriptor = { label: 'frame-encoder' };
	#submitArray = [null]; // Reused array for queue.submit()
	// #gpuReady = true;
	#framesInFlight = 0; // TODO Test remove
	#maxFramesInFlight = 1; // TODO Test remove

	#lastRenderTime = 0;
	#gaps = [];

	// =========================================================================
	// PERFORMANCE TRACKING
	// =========================================================================
	#fpsAverage = new NonNegativeRollingAverage(30);
	#cpuAverage = new NonNegativeRollingAverage(30);
	#gpuAverage = new NonNegativeRollingAverage(30);
	timings = $state({ cpu: '0', fps: '0', gpu: '0' });

	// Promise cache for pipeline creation (prevents "thundering herd")
	#pipelineCreationPromises = new Map();

	// =========================================================================
	// CONSTRUCTOR
	// =========================================================================

	constructor(config = {}) {
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
	}

	// =========================================================================
	// INITIALIZATION
	// =========================================================================

	async initialize() {
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

	async #initWebGPU() {
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

	async #initializeScaleBindGroupLayouts() {
		this.#globalScaleLayout = this.#device.createBindGroupLayout({
			label: 'global-scale-ssbo-layout',
			entries: [
				{
					// Binding 0: Coordinate scale params (used in vertex)
					binding: 0,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
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
				}
			]
		});

		this.#createGlobalScaleSSBO();

		// Create color scale buffers (must happen before bind group creation)
		this.#createColorScaleBuffers();

		// Pre-create bind groups for each slot
		for (let slot = 0; slot < this.#SSBO_SLOT_COUNT; slot++) {
			const slotOffset = slot * this.#slotByteSize;
			this.#globalScaleBindGroups[slot] = this.#device.createBindGroup({
				label: `global-scale-bind-group-slot-${slot}`,
				layout: this.#globalScaleLayout,
				entries: [
					{
						// Coordinate scales - uses slot offset
						binding: 0,
						resource: {
							buffer: this.#globalScaleSSBO,
							offset: slotOffset,
							size: this.#slotByteSize
						}
					},
					{
						// Color configs - full buffer, no offset
						binding: 1,
						resource: {
							buffer: this.#colorConfigBuffer
						}
					},
					{
						// Color ramps - full buffer, no offset
						binding: 2,
						resource: {
							buffer: this.#colorRampBuffer
						}
					},
					{
						// Ordinal palettes - full buffer, no offset
						binding: 3,
						resource: {
							buffer: this.#colorPaletteBuffer
						}
					},
					{
						// Size configs - full buffer, no offset
						binding: 4,
						resource: {
							buffer: this.#sizeConfigBuffer
						}
					}
				]
			});
		}
	}

	#createGlobalScaleSSBO() {
		const scaleParamSize = 16; // 4 floats * 4 bytes
		this.#slotByteSize = this.#maxScaleSlots * scaleParamSize;
		const totalSSBOSize = this.#slotByteSize * this.#SSBO_SLOT_COUNT;

		this.#globalScaleSSBO = this.#device.createBuffer({
			size: totalSSBOSize,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			label: 'global-scale-ssbo-ring'
		});

		// CPU buffer for building scale data (reused each frame)
		this.#cpuScaleBuffer = new Float32Array(this.#slotByteSize / 4);
	}

	#createColorScaleBuffers() {
		const device = this.#device;

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
	#fillAllScales(view) {
		const len = this.#scaleArray.length;
		for (let i = 0; i < len; i++) {
			const item = this.#scaleArray[i];
			const scale = item.instance;
			const off = item.index << 2;

			const scaleTypeName = scale.constructor.name;

			if (scaleTypeName === 'BandScaleState') {
				// BAND SCALE: Write configuration
				const config = scale.getConfig();

				view[off] = config.categoryCount;
				view[off + 1] = config.paddingInner;
				view[off + 2] = config.paddingOuter;
				view[off + 3] = 0; // padding (unused)
			} else {
				// LINEAR SCALE: Write domain state
				const s = scale.gpuState;

				view[off] = s.domainMin;
				view[off + 1] = s.domainMax;
				view[off + 2] = s.domainScale;
				view[off + 3] = 0; // padding (unused)
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
	#physicsStep = () => {
		const len = this.#animatedScalesArray.length;
		for (let i = 0; i < len; i++) {
			this.#animatedScalesArray[i].step();
		}
	};

	/**
	 * Render frame - called once per RAF with extrapolation time.
	 * Updates render state and triggers GPU render.
	 */

	#renderFrame = (extrapolationDt) => {
		// console.log('=== RENDER FRAME ===');
		// console.log('animatedScalesArray length:', this.#animatedScalesArray.length);

		// const now = performance.now();
		// if (this.#lastRenderTime > 0 && now - this.#lastRenderTime < 8) {
		// 	return;
		// }
		// this.#lastRenderTime = now;

		// if (this.#framesInFlight >= this.#maxFramesInFlight) {
		// 	console.log('Skipping frame - too many in flight:', this.#framesInFlight);
		// 	return;
		// }

		// 1. Apply any accumulated input (zoom, etc.)
		for (let i = 0; i < this.#animatedScalesArray.length; i++) {
			this.#animatedScalesArray[i]._applyInput?.();
		}

		// 2. Update render state with extrapolation for ALL scales first
		const len = this.#animatedScalesArray.length;
		for (let i = 0; i < len; i++) {
			this.#animatedScalesArray[i].updateRenderState(extrapolationDt);
		}

		// DEBUG: Log scale values
		// if (this.#animatedScalesArray.length > 0) {
		// 	const s = this.#animatedScalesArray[0];
		// 	console.log('scale:', s.gpuState.domainMin.toFixed(4), s.gpuState.domainMax.toFixed(4));
		// }

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
				const last = this.#animatedScalesArray.pop();
				if (i < this.#animatedScalesArray.length) {
					this.#animatedScalesArray[i] = last;
				}
			}
		}

		// 5. Render if needed
		if (chartArray.length > 0) {
			this.#coordinatedRender(chartArray);
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
	#idleCheck = () => {
		return (
			this.#animatedScales.size === 0 &&
			this.#dirtyChartsArray.length === 0 &&
			this.#hoveredCharts.size === 0
		);
	};

	// =========================================================================
	// RENDER PIPELINE
	// =========================================================================

	#coordinatedRender(chartsNeedingRender) {
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
		this.#fillAllScales(this.#cpuScaleBuffer);

		const dstOffset = slot * this.#slotByteSize;
		this.#device.queue.writeBuffer(
			this.#globalScaleSSBO,
			dstOffset,
			this.#cpuScaleBuffer,
			0,
			this.#cpuScaleBuffer.length
		);

		// PHASE 3: GPU COMMAND ENCODING
		const commandEncoder = this.#device.createCommandEncoder(this.#encoderDescriptor);
		const currentScaleBindGroup = this.#globalScaleBindGroups[slot];

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

				let currentPipeline = null;
				let currentPerDataBindGroup = null;

				for (let j = 0; j < planLen; j++) {
					const layer = plan[j];
					const renderer = layer.renderer;

					if (!renderer || !renderer.perDataBindGroup) continue;

					if (layer.cachedPipeline !== currentPipeline) {
						passEncoder.setPipeline(layer.cachedPipeline);
						currentPipeline = layer.cachedPipeline;
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
		this.#device.queue.submit(this.#submitArray);

		// this.#framesInFlight++;
		// this.#device.queue.onSubmittedWorkDone().then(() => {
		// 	this.#framesInFlight--;
		// });

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
		rendererId,
		markType,
		scaleTypes,
		markShaderCode,
		vertexBufferLayout,
		dataBindingConfig,
		rendererDefinition
	) {
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
		const localRegistry = this.#rendererRegistry.get(rendererId);

		// --- Acquire Shader (with idempotency check) ---
		let shaderModule;
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
		let pipeline;
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
				const pipelineLayout = this.#device.createPipelineLayout({
					label: `${resourceKey}-pipeline-layout`,
					bindGroupLayouts: [frameLayout, dataLayout, this.#globalScaleLayout]
				});

				return this.#device.createRenderPipeline({
					label: `${resourceKey}-pipeline`,
					layout: pipelineLayout,
					vertex: {
						module: shaderModule,
						entryPoint: 'vertexMain',
						buffers: vertexBufferLayout || []
					},
					fragment: {
						module: shaderModule,
						entryPoint: 'fragmentMain',
						targets: [
							{
								format: this.#presentationFormat,
								blend: {
									color: {
										srcFactor: 'src-alpha',
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
	releaseRenderer(rendererId) {
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

	async #getOrCreateSharedPipeline(key, createFn) {
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
			const pipeline = await this.#pipelineCreationPromises.get(key);
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

	#releaseSharedPipeline(key) {
		const resource = this.#sharedResources.pipelines.get(key);
		if (!resource) return;

		resource.refCount--;
		if (resource.refCount <= 0) {
			this.#sharedResources.pipelines.delete(key);
		}
	}

	async #getOrCreateSharedShader(key, code) {
		const existing = this.#sharedResources.shaderModules.get(key);
		if (existing) {
			existing.refCount++;
			return existing.module;
		}

		const module = this.#device.createShaderModule({ code });
		this.#sharedResources.shaderModules.set(key, {
			module,
			refCount: 1,
			createdAt: Date.now()
		});
		return module;
	}

	#releaseSharedShader(key) {
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

	setScaleRegistry(scaleRegistry) {
		this.#scaleRegistry = scaleRegistry;
	}

	registerScale(scaleId, scaleType = 'linear') {
		if (!this.#initialized) return;
		this.#handleScaleTopologyChange();
	}

	unregisterScale(scaleId) {
		this.#handleScaleTopologyChange();
	}

	scheduleTopologyUpdate() {
		if (this.#topologyUpdateScheduled) return;
		this.#topologyUpdateScheduled = true;

		queueMicrotask(() => {
			this.#topologyUpdateScheduled = false;
			this.#handleScaleTopologyChange();
		});
	}

	#handleScaleTopologyChange() {
		if (!this.#scaleRegistry) return;

		const usageMap = this.#scaleRegistry.scaleUsage;
		if (!usageMap || typeof usageMap[Symbol.iterator] !== 'function') return;

		// Clear and rebuild
		const ids = [];
		this.#scaleIdToInstance.clear();
		this.#scaleArray = [];

		for (const [scaleInstance, chartIds] of usageMap) {
			if (chartIds && typeof chartIds[Symbol.iterator] === 'function') {
				scaleInstance._affectedChartsArray = Array.from(chartIds);
			} else {
				scaleInstance._affectedChartsArray = [];
			}

			if (scaleInstance?.id) {
				ids.push(scaleInstance.id);
				this.#scaleIdToInstance.set(scaleInstance.id, scaleInstance);
			}
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

	#recreateGlobalScalesSSBOAndBindGroups() {
		console.log('Resizing Global Scale SSBO...');

		const oldSSBO = this.#globalScaleSSBO;

		const scaleParamSize = 16;
		this.#slotByteSize = this.#maxScaleSlots * scaleParamSize;
		const totalSSBOSize = this.#slotByteSize * this.#SSBO_SLOT_COUNT;

		try {
			const newSSBO = this.#device.createBuffer({
				size: totalSSBOSize,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				label: `global-scale-ssbo-ring-v${this.#frameId}`
			});

			const newBindGroups = [];
			for (let slot = 0; slot < this.#SSBO_SLOT_COUNT; slot++) {
				const offset = slot * this.#slotByteSize;
				newBindGroups[slot] = this.#device.createBindGroup({
					label: `global-scale-bind-group-slot-${slot}`,
					layout: this.#globalScaleLayout,
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
							resource: { buffer: this.#colorConfigBuffer }
						},
						{
							binding: 2,
							resource: { buffer: this.#colorRampBuffer }
						},
						{
							binding: 3,
							resource: { buffer: this.#colorPaletteBuffer }
						},
						{
							binding: 4,
							resource: { buffer: this.#sizeConfigBuffer }
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
	writeColorConfig(slot, configData) {
		if (!this.#colorConfigBuffer) {
			console.warn('[GPUCoordinator] Color config buffer not initialized');
			return;
		}

		if (slot < 0 || slot >= this.#maxColorSlots) {
			console.warn(`[GPUCoordinator] Invalid color config slot: ${slot}`);
			return;
		}

		const byteOffset = slot * 32;
		this.#device.queue.writeBuffer(this.#colorConfigBuffer, byteOffset, configData);
	}

	/**
	 * Write a 256-color gradient ramp to the ramp buffer.
	 *
	 * @param {number} slot - Ramp slot index (0-63)
	 * @param {Float32Array} rampData - 1024 floats (256 colors × RGBA)
	 */
	writeColorRamp(slot, rampData) {
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
		this.#device.queue.writeBuffer(this.#colorRampBuffer, byteOffset, rampData);
	}

	/**
	 * Write a 32-color ordinal palette to the palette buffer.
	 *
	 * @param {number} slot - Palette slot index (0-63)
	 * @param {Float32Array} paletteData - 128 floats (32 colors × RGBA)
	 */
	writeColorPalette(slot, paletteData) {
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
		this.#device.queue.writeBuffer(this.#colorPaletteBuffer, byteOffset, paletteData);
	}

	/**
	 * Write a SizeConfig struct to the size config buffer.
	 *
	 * @param {number} slot - Config slot index (0-63)
	 * @param {ArrayBuffer} configData - 16-byte config struct from SizeScaleState
	 */
	writeSizeConfig(slot, configData) {
		if (!this.#sizeConfigBuffer) {
			console.warn('[GPUCoordinator] Size config buffer not initialized');
			return;
		}

		if (slot < 0 || slot >= this.#maxSizeSlots) {
			console.warn(`[GPUCoordinator] Invalid size config slot: ${slot}`);
			return;
		}

		const byteOffset = slot * 16;
		this.#device.queue.writeBuffer(this.#sizeConfigBuffer, byteOffset, configData);
	}

	// =========================================================================
	// ANIMATED SCALE MANAGEMENT
	// =========================================================================

	addAnimatingScale(scale) {
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

		this.#animationLoop.requestStart();
	}

	removeAnimatingScale(scale) {
		if (this.#animatedScales.delete(scale)) {
			const idx = this.#animatedScalesArray.indexOf(scale);
			if (idx !== -1) {
				const lastItem = this.#animatedScalesArray.pop();
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
	setChartHovered(chartId) {
		this.#hoveredCharts.add(chartId);
		this.#animationLoop.requestStart();
	}

	/**
	 * Mark a chart as no longer hovered.
	 * @param {string} chartId
	 */
	setChartUnhovered(chartId) {
		this.#hoveredCharts.delete(chartId);
		// Loop will stop on its own via idle check if nothing else is active
	}

	/**
	 * Register a callback to be called once per animation frame.
	 * Callback receives { isAnimating: boolean } — true when scales are actively
	 * animating (pan/zoom), useful for skipping non-essential work like tooltips.
	 */
	addFrameCallback(fn) {
		this.#frameCallbacks.push(fn);
	}

	removeFrameCallback(fn) {
		const idx = this.#frameCallbacks.indexOf(fn);
		if (idx !== -1) this.#frameCallbacks.splice(idx, 1);
	}

	registerChart(chartId, canvas, config) {
		if (this.#registeredCharts.has(chartId)) {
			console.warn(`Chart ${chartId} already registered, updating config`);
		}

		const chartConfig = {
			chartId,
			canvas,
			zIndex: config.zIndex || 0,
			visible: true,
			context: canvas.getContext('webgpu'),
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

		const pendingMapping = this.#pendingScaleMappings.get(chartId);
		if (pendingMapping) {
			this.setChartScaleMapping(chartId, pendingMapping);
			this.#pendingScaleMappings.delete(chartId);
		}

		return {
			setContextReady: () => {
				const chart = this.#registeredCharts.get(chartId);
				if (chart) {
					chart.contextConfigured = true;
					this.#processPendingFrameUpdates(chartId);
				}
			},
			setVisible: (visible) => {
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

	unregisterChart(chartId) {
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

			// const msaa = this.#msaaCache.get(chartId);
			// if (msaa) {
			// 	msaa.texture.destroy();
			// 	this.#msaaCache.delete(chartId);
			// }

			this.#pendingScaleMappings.delete(chartId);
		}
	}

	invalidateChart(chartId) {
		const chart = this.#registeredCharts.get(chartId);
		if (chart && !chart._isDirty) {
			chart._isDirty = true;
			this.#dirtyChartsArray.push(chart);
			this.#animationLoop.requestStart();
		}
	}

	setChartScaleMapping(chartId, { xScaleId, yScaleId }) {
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

	#getOrCreateFrameLayout() {
		if (!this.#frameLayout) {
			this.#frameLayout = this.#device.createBindGroupLayout({
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

	#getOrCreateDataLayout(markType, dataBindingConfig) {
		const layoutKey = `${markType}-${JSON.stringify(dataBindingConfig)}`;

		if (!this.#dataLayouts.has(layoutKey)) {
			const layout = this.#device.createBindGroupLayout({
				label: `${markType}-data-layout`,
				entries: dataBindingConfig.map((config) => ({
					binding: config.binding,
					// visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					visibility:
						config.visibility !== undefined
							? config.visibility
							: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: config.type || 'read-only-storage' }
				}))
			});
			this.#dataLayouts.set(layoutKey, layout);
		}

		return this.#dataLayouts.get(layoutKey);
	}

	#createChartFrameResources(chartId) {
		const chartConfig = this.#registeredCharts.get(chartId);
		if (!chartConfig || chartConfig.frameUniformsBuffer) return;

		chartConfig.frameUniformsBuffer = this.#device.createBuffer({
			size: 64,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			label: `frame-uniforms-${chartId}`
		});

		this.#createChartFrameBindGroup(chartId);
	}

	#createChartFrameBindGroup(chartId) {
		const chartConfig = this.#registeredCharts.get(chartId);
		if (!chartConfig?.frameUniformsBuffer || chartConfig.perFrameBindGroup) return;

		const frameLayout = this.#getOrCreateFrameLayout();

		chartConfig.perFrameBindGroup = this.#device.createBindGroup({
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
	updateChartFrameUniforms(chartId, nullColor = [0.5, 0.5, 0.5, 1.0]) {
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

		const xScaleIndex = this.#scaleIndexManager.getIndex(chartConfig.xScaleId) ?? 0;
		const yScaleIndex = this.#scaleIndexManager.getIndex(chartConfig.yScaleId) ?? 1;

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
		u32[10] = 0;
		u32[11] = 0;
		// u32[10], u32[11] = padding
		f32[12] = nullColor[0]; // R
		f32[13] = nullColor[1]; // G
		f32[14] = nullColor[2]; // B
		f32[15] = nullColor[3]; // A

		this.#device.queue.writeBuffer(chartConfig.frameUniformsBuffer, 0, buf);

		// console.log(`📏 Frame uniforms for chart ${chartId}:`, {
		// 	rangeMinY: rangeMinY,
		// 	rangeMaxY: rangeMaxY,
		// 	rangeSize: rangeMaxY - rangeMinY,
		// 	yScaleIndex: yScaleIndex
		// });
	}

	#processPendingFrameUpdates(chartId) {
		if (this.#pendingFrameUpdates.has(chartId)) {
			this.updateChartFrameUniforms(chartId);
			this.#pendingFrameUpdates.delete(chartId);
		}
	}

	// =========================================================================
	// LAYER MANAGEMENT
	// =========================================================================

	registerLayer(chartId, layerConfig) {
		const chart = this.#registeredCharts.get(chartId);
		if (!chart) {
			console.error(`Attempted to register layer on non-existent chart: ${chartId}`);
			return { remove: () => {} };
		}

		const layerId = layerConfig.id || `layer-${crypto.randomUUID().slice(0, 8)}`;
		chart.layers.set(layerId, { ...layerConfig, id: layerId, zIndex: layerConfig.zIndex ?? 0 });
		chart.needsPlanRebuild = true;
		this.invalidateChart(chartId);

		return {
			remove: () => this.unregisterLayer(chartId, layerId)
		};
	}

	unregisterLayer(chartId, layerId) {
		const chart = this.#registeredCharts.get(chartId);
		if (chart?.layers.has(layerId)) {
			chart.layers.delete(layerId);
			chart.needsPlanRebuild = true;
			this.invalidateChart(chartId);
		}
	}

	#buildRenderPlanForChart(chartConfig) {
		const layers = Array.from(chartConfig.layers.values());
		if (layers.length === 0) {
			chartConfig.renderPlan = [];
			chartConfig.needsPlanRebuild = false;
			return;
		}

		const zIndexGroups = new Map();
		for (const layer of layers) {
			const zIndex = layer.zIndex;
			if (!zIndexGroups.has(zIndex)) zIndexGroups.set(zIndex, []);
			zIndexGroups.get(zIndex).push(layer);
		}

		const sortedZLevels = Array.from(zIndexGroups.keys()).sort((a, b) => a - b);
		const newPlan = [];

		for (const zLevel of sortedZLevels) {
			const layersInZLevel = zIndexGroups.get(zLevel);
			const markTypeGroups = new Map();

			for (const layer of layersInZLevel) {
				const markType = layer.markType || 'unknown';
				if (!markTypeGroups.has(markType)) markTypeGroups.set(markType, []);
				markTypeGroups.get(markType).push(layer);
			}

			for (const batchedLayers of markTypeGroups.values()) {
				newPlan.push(...batchedLayers);
			}
		}

		for (const layer of newPlan) {
			layer.cachedPipeline = layer.renderer?.pipeline;
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

	#createRenderPassDescriptor(textureView, chartConfig) {
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

				const newTexture = this.#device.createTexture({
					size: { width: canvas.width, height: canvas.height },
					sampleCount: this.#msaaSampleCount,
					format: this.#presentationFormat,
					usage: GPUTextureUsage.RENDER_ATTACHMENT
				});

				msaa = { texture: newTexture, view: newTexture.createView() };
				chartConfig.msaa = msaa;
				chartConfig.renderPassDescriptor = null;
			}

			if (chartConfig.renderPassDescriptor) {
				chartConfig.renderPassDescriptor.colorAttachments[0].resolveTarget = textureView;
				return chartConfig.renderPassDescriptor;
			}

			const desc = {
				colorAttachments: [
					{
						view: msaa.view,
						resolveTarget: textureView,
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
						loadOp: 'clear',
						// storeOp: 'store'
						storeOp: 'discard'
					}
				]
			};

			chartConfig.renderPassDescriptor = desc;
			return desc;
		} else {
			if (chartConfig.renderPassDescriptor) {
				chartConfig.renderPassDescriptor.colorAttachments[0].view = textureView;
				return chartConfig.renderPassDescriptor;
			}

			const desc = {
				colorAttachments: [
					{
						view: textureView,
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
						loadOp: 'clear',
						storeOp: 'store'
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

	get device() {
		return this.#device;
	}
	get presentationFormat() {
		return this.#presentationFormat;
	}
	get msaaSampleCount() {
		return this.#msaaSampleCount;
	}
	get isInitialized() {
		return this.#initialized;
	}

	/**
	 * Promise that resolves when WebGPU initialization completes.
	 * Use this instead of polling isInitialized.
	 * @returns {Promise<boolean>}
	 */
	get ready() {
		return this.#readyPromise;
	}

	get colorConfigBuffer() {
		return this.#colorConfigBuffer;
	}

	get colorRampBuffer() {
		return this.#colorRampBuffer;
	}

	get colorPaletteBuffer() {
		return this.#colorPaletteBuffer;
	}

	// =========================================================================
	// CLEANUP
	// =========================================================================

	#destroyColorScaleBuffers() {
		this.#colorConfigBuffer?.destroy();
		this.#colorRampBuffer?.destroy();
		this.#colorPaletteBuffer?.destroy();
		this.#sizeConfigBuffer?.destroy();

		this.#colorConfigBuffer = null;
		this.#colorRampBuffer = null;
		this.#colorPaletteBuffer = null;
		this.#sizeConfigBuffer = null;
	}

	destroy() {
		console.log('Destroying GPUCoordinator');

		// Stop animation loop
		this.#animationLoop?.destroy();
		this.#animationLoop = null;

		// Cleanup timestamp query resources (FIXED: was leaking)
		this.#resolveBuffer?.destroy();
		this.#resultBuffer?.destroy();
		this.#querySet = null; // QuerySet has no destroy(), just null reference

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

export function setGPUCoordinator(config = {}) {
	const coordinator = new GPUCoordinator(config);

	if (typeof window !== 'undefined') {
		coordinator.initialize().catch((error) => {
			console.error('Failed to initialize GPU coordinator:', error);
		});
	}

	return setContext('gpu-coordinator', coordinator);
}

export function getGPUContext() {
	const coordinator = getContext('gpu-coordinator');

	if (!coordinator) {
		console.error(
			'GPU Coordinator context missing. Make sure to call setGPUCoordinator() in a parent component.'
		);
		return null;
	}

	return coordinator;
}
