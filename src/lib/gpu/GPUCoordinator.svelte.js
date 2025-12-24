// =============================================================================
// GPUCoordinator.svelte.js - Refactored with AnimationLoop
// =============================================================================

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
 * - Shared pipeline and resource caching
 * - Animation loop with fixed-timestep physics
 * - Scale SSBO management for GPU-based domain transforms
 * - Multi-chart render coordination
 *
 * Animation Architecture:
 * - Uses AnimationLoop for fixed-timestep physics (360Hz)
 * - Scales call step() at fixed rate, updateRenderState() with extrapolation
 * - Render extrapolation provides smooth visuals regardless of frame rate
 */
export class GPUCoordinator {
	// =========================================================================
	// CORE WEBGPU RESOURCES
	// =========================================================================
	#device = $state(null);
	#presentationFormat = $state(null);
	#initialized = $state(false);

	// Timestamp query resources (optional, for GPU timing)
	#canTimestamp = false;
	#querySet = null;
	#resolveBuffer = null;
	#resultBuffer = null;

	// =========================================================================
	// SHARED RESOURCES (Reference Counted)
	// =========================================================================
	#sharedResources = {
		pipelines: new Map(), // markType -> { pipeline, refCount }
		uniformBuffers: new Map(), // name -> { buffer, refCount }
		shaderModules: new Map(), // markType -> { module, refCount }
		bindGroupLayouts: new Map() // markType -> { layout, refCount }
	};

	// =========================================================================
	// CHART MANAGEMENT
	// =========================================================================
	#registeredCharts = new Map(); // chartId -> chartConfig
	#msaaCache = new Map(); // chartId -> { texture, view }
	#dirtyChartIDs = new Set(); // Charts needing re-render
	#msaaSampleCount = 1;
	// #msaaSampleCount = 4;

	// =========================================================================
	// ANIMATION SYSTEM (NEW)
	// =========================================================================
	#animationLoop = null;
	#animatedScales = new Set(); // Set for O(1) membership check
	#animatedScalesArray = []; // Array for O(1) iteration (no allocation)
	#scaleRegistry = null;

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
	// LAYOUT CACHES
	// =========================================================================
	#templateSystem = scaleTemplateSystem;
	#frameLayout = null;
	#dataLayouts = new Map(); // markType-config -> GPUBindGroupLayout

	// =========================================================================
	// TEXTURE CACHING (Zero-Allocation)
	// =========================================================================
	#textureCache = new Map(); // chartId -> { texture, view, lastFrameId }
	// Reusable array for texture acquisition (avoid allocation in hot path)
	#acquiredTextures = [];

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
	#encoderDescriptor = { label: 'frame-encoder' };
	#submitArray = [null]; // Reused array for queue.submit()

	// =========================================================================
	// PERFORMANCE TRACKING
	// =========================================================================
	#fpsAverage = new NonNegativeRollingAverage(30);
	#cpuAverage = new NonNegativeRollingAverage(30);
	#gpuAverage = new NonNegativeRollingAverage(30);
	timings = $state({ cpu: '0', fps: '0', gpu: '0' });

	// Race condition protection
	#creatingPipelines = new Set();

	// =========================================================================
	// CONSTRUCTOR
	// =========================================================================

	constructor(config = {}) {
		this.#msaaSampleCount = config.msaaSampleCount ?? 4;
		this.#scaleIndexManager = new ScaleIndexManager();

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
			await this.#createSharedResources();
			await this.#initializeScaleBindGroupLayouts();

			this.#initialized = true;
			this.#handleScaleTopologyChange();

			console.log('GPUCoordinator initialized with AnimationLoop architecture');
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
	}

	async #createSharedResources() {
		const dprBuffer = this.#device.createBuffer({
			size: 4,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});

		this.#sharedResources.uniformBuffers.set('devicePixelRatio', {
			buffer: dprBuffer,
			refCount: 0,
			createdAt: Date.now()
		});

		this.#updateSharedUniforms();
	}

	#updateSharedUniforms() {
		if (!this.#device) return;

		const dpr = window.devicePixelRatio || 1;
		const dprResource = this.#sharedResources.uniformBuffers.get('devicePixelRatio');

		if (dprResource?.buffer) {
			this.#device.queue.writeBuffer(dprResource.buffer, 0, new Float32Array([dpr]));
		}
	}

	// =========================================================================
	// SCALE SSBO SYSTEM
	// =========================================================================

	async #initializeScaleBindGroupLayouts() {
		this.#globalScaleLayout = this.#device.createBindGroupLayout({
			label: 'global-scale-ssbo-layout',
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: 'read-only-storage' }
				}
			]
		});

		this.#createGlobalScaleSSBO();

		// Pre-create bind groups for each slot
		for (let slot = 0; slot < this.#SSBO_SLOT_COUNT; slot++) {
			const slotOffset = slot * this.#slotByteSize;
			this.#globalScaleBindGroups[slot] = this.#device.createBindGroup({
				label: `global-scale-bind-group-slot-${slot}`,
				layout: this.#globalScaleLayout,
				entries: [
					{
						binding: 0,
						resource: {
							buffer: this.#globalScaleSSBO,
							offset: slotOffset,
							size: this.#slotByteSize
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

	/**
	 * Fill CPU buffer with current scale GPU state.
	 * Zero-allocation hot path.
	 */
	#fillAllScales(view) {
		const len = this.#scaleArray.length;
		for (let i = 0; i < len; i++) {
			const item = this.#scaleArray[i];
			const s = item.instance.gpuState;

			const off = item.index << 2; // * 4 via bitshift
			view[off] = s.domainMin;
			view[off + 1] = s.domainMax;
			view[off + 2] = s.domainScale;
			view[off + 3] = 0; // padding
		}
	}

	// =========================================================================
	// ANIMATION LOOP CALLBACKS (NEW)
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

		// Add charts affected by animated scales (while all scales still in array)
		for (let i = 0; i < this.#animatedScalesArray.length; i++) {
			const scale = this.#animatedScalesArray[i];
			const affected = scale._affectedChartsArray;

			if (affected && Array.isArray(affected)) {
				for (let j = 0; j < affected.length; j++) {
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
		for (const chartId of this.#dirtyChartIDs) {
			const chart = this.#registeredCharts.get(chartId);
			if (chart && chart._lastRenderFrame !== currentRenderId) {
				if (chart.visible && chart.contextConfigured) {
					chart._lastRenderFrame = currentRenderId;
					chartArray.push(chart);
				}
			}
		}
		this.#dirtyChartIDs.clear();

		// 4. NOW remove scales that are at rest (backwards for safe removal)
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
	};

	/**
	 * Idle check - return true if animation should stop.
	 */
	#idleCheck = () => {
		return this.#animatedScales.size === 0 && this.#dirtyChartIDs.size === 0;
	};

	// =========================================================================
	// RENDER PIPELINE
	// =========================================================================

	#coordinatedRender(chartsNeedingRender) {
		const slot = this.#frameId % this.#SSBO_SLOT_COUNT;

		// ========================================================================
		// PHASE 1: EARLY TEXTURE ACQUISITION (CRITICAL FOR PROMOTION)
		// ========================================================================
		// Acquire ALL textures BEFORE any CPU work or buffer uploads.
		// This may help with compositor synchronization on VRR displays.

		// Clear reusable array (doesn't deallocate backing storage)
		this.#acquiredTextures.length = 0;

		const numCharts = chartsNeedingRender.length;
		for (let i = 0; i < numCharts; i++) {
			const chartConfig = chartsNeedingRender[i];
			const chartId = chartConfig.chartId;

			// Get texture from context (this is the critical early call)
			const texture = chartConfig.context.getCurrentTexture();

			// IMPORTANT: Don't cache texture object itself - it changes each frame
			// But we CAN reuse the view creation pattern
			const view = texture.createView();

			// Store in reusable array
			this.#acquiredTextures.push({
				chartConfig,
				texture,
				view
			});
		}

		// ========================================================================
		// PHASE 2: CPU WORK (Scale buffer updates, etc.)
		// ========================================================================
		// Now that textures are acquired, do CPU-side work
		this.#fillAllScales(this.#cpuScaleBuffer);

		const dstOffset = slot * this.#slotByteSize;
		this.#device.queue.writeBuffer(
			this.#globalScaleSSBO,
			dstOffset,
			this.#cpuScaleBuffer,
			0,
			this.#cpuScaleBuffer.length
		);

		// ========================================================================
		// PHASE 3: GPU COMMAND ENCODING
		// ========================================================================
		const commandEncoder = this.#device.createCommandEncoder(this.#encoderDescriptor);
		const currentScaleBindGroup = this.#globalScaleBindGroups[slot];

		// Iterate using cached textures/views
		for (let i = 0; i < this.#acquiredTextures.length; i++) {
			const { chartConfig, texture, view } = this.#acquiredTextures[i];

			if (chartConfig.needsPlanRebuild) {
				this.#buildRenderPlanForChart(chartConfig);
			}

			// Use the pre-acquired texture and view
			const passEncoder = commandEncoder.beginRenderPass(
				this.#createRenderPassDescriptor(view, chartConfig.canvas, chartConfig.chartId)
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

		// ========================================================================
		// PHASE 4: SUBMIT
		// ========================================================================
		this.#submitArray[0] = commandEncoder.finish();
		this.#device.queue.submit(this.#submitArray);
		this.#frameId++;
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

	// #recreateGlobalScalesSSBOAndBindGroups() {
	// 	this.#globalScaleSSBO?.destroy?.();

	// 	this.#createGlobalScaleSSBO();

	// 	this.#globalScaleBindGroups.length = 0;
	// 	for (let slot = 0; slot < this.#SSBO_SLOT_COUNT; slot++) {
	// 		const offset = slot * this.#slotByteSize;
	// 		this.#globalScaleBindGroups[slot] = this.#device.createBindGroup({
	// 			layout: this.#globalScaleLayout,
	// 			entries: [
	// 				{
	// 					binding: 0,
	// 					resource: { buffer: this.#globalScaleSSBO, offset, size: this.#slotByteSize }
	// 				}
	// 			]
	// 		});
	// 	}
	// }
	#recreateGlobalScalesSSBOAndBindGroups() {
		console.log('Resizing Global Scale SSBO...');

		// 1. Keep reference to the OLD buffer so we can destroy it later
		const oldSSBO = this.#globalScaleSSBO;

		// 2. Calculate new sizes
		const scaleParamSize = 16; // 4 floats * 4 bytes
		this.#slotByteSize = this.#maxScaleSlots * scaleParamSize;
		const totalSSBOSize = this.#slotByteSize * this.#SSBO_SLOT_COUNT;

		try {
			// 3. Create NEW resources (Allocating memory)
			// If this fails (OOM), we throw here, and the OLD buffer is still alive/valid.
			const newSSBO = this.#device.createBuffer({
				size: totalSSBOSize,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				label: `global-scale-ssbo-ring-v${this.#frameId}`
			});

			// 4. Create NEW Bind Groups
			const newBindGroups = [];
			for (let slot = 0; slot < this.#SSBO_SLOT_COUNT; slot++) {
				const offset = slot * this.#slotByteSize;
				newBindGroups[slot] = this.#device.createBindGroup({
					label: `global-scale-bind-group-slot-${slot}`, // Optional: add version info
					layout: this.#globalScaleLayout,
					entries: [
						{
							binding: 0,
							resource: {
								buffer: newSSBO,
								offset,
								size: this.#slotByteSize
							}
						}
					]
				});
			}

			// 5. ATOMIC SWAP: Update state only after successful creation
			this.#globalScaleSSBO = newSSBO;
			this.#globalScaleBindGroups = newBindGroups;

			// Recreate CPU staging buffer to match new size
			this.#cpuScaleBuffer = new Float32Array(this.#slotByteSize / 4);

			// 6. SAFE DESTROY: Now it is safe to kill the old buffer
			// WebGPU keeps it alive until pending commands using it are complete.
			if (oldSSBO) {
				oldSSBO.destroy();
			}
		} catch (error) {
			console.error('Failed to resize Scale SSBO. Keeping old buffer.', error);
			// We don't destroy oldSSBO here, so the app continues working with the smaller buffer
			// (Charts might clip, but the app won't crash).
		}
	}

	// =========================================================================
	// ANIMATED SCALE MANAGEMENT
	// =========================================================================

	/**
	 * Add a scale to the animation loop.
	 * Called by LinearScaleState when it needs to animate.
	 */
	addAnimatingScale(scale) {
		let idx = this.#scaleIndexManager.getIndex(scale.id);

		if (idx === undefined) {
			this.registerScale(scale.id, 'linear');
			idx = this.#scaleIndexManager.getIndex(scale.id);
			if (idx === undefined) {
				console.error(`Scale ${scale.id} still not registered after auto-register`);
				return;
			}
		}

		if (!this.#animatedScales.has(scale)) {
			this.#animatedScales.add(scale);
			this.#animatedScalesArray.push(scale);
		}

		// Start animation loop if not running
		this.#animationLoop.requestStart();
	}

	/**
	 * Remove a scale from animation (called when scale reaches rest).
	 * Note: Usually handled automatically in #renderFrame via isAtRest() check.
	 */
	removeAnimatingScale(scale) {
		if (this.#animatedScales.delete(scale)) {
			// Swap and pop removal
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
			_lastRenderFrame: -1
		};

		this.#registeredCharts.set(chartId, chartConfig);

		// Process pending scale mappings
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
			if (chartConfig.frameUniformsBuffer && !chartConfig.frameUniformsBuffer.destroyed) {
				chartConfig.frameUniformsBuffer.destroy();
			}

			this.#registeredCharts.delete(chartId);

			const msaa = this.#msaaCache.get(chartId);
			if (msaa) {
				msaa.texture.destroy();
				this.#msaaCache.delete(chartId);
			}

			this.#pendingScaleMappings.delete(chartId);
		}
	}

	invalidateChart(chartId) {
		if (this.#registeredCharts.has(chartId)) {
			this.#dirtyChartIDs.add(chartId);
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

	#createChartFrameResources(chartId) {
		const chartConfig = this.#registeredCharts.get(chartId);
		if (!chartConfig || chartConfig.frameUniformsBuffer) return;

		chartConfig.frameUniformsBuffer = this.#device.createBuffer({
			size: 48,
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

	updateChartFrameUniforms(chartId) {
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
		const rangeMinY = canvas.clientHeight * dpr;
		const rangeMaxX = canvas.clientWidth * dpr;
		const rangeMaxY = 0;

		const xScaleIndex = this.#scaleIndexManager.getIndex(chartConfig.xScaleId) ?? 0;
		const yScaleIndex = this.#scaleIndexManager.getIndex(chartConfig.yScaleId) ?? 1;

		const buf = new ArrayBuffer(48);
		const f32 = new Float32Array(buf);
		const u32 = new Uint32Array(buf);

		f32[0] = resX;
		f32[1] = resY;
		f32[2] = rangeMinX;
		f32[3] = rangeMinY;
		f32[4] = rangeMaxX;
		f32[5] = rangeMaxY;
		f32[6] = dpr;
		f32[7] = 0.0;

		u32[8] = xScaleIndex >>> 0;
		u32[9] = yScaleIndex >>> 0;
		u32[10] = 0;
		u32[11] = 0;

		this.#device.queue.writeBuffer(chartConfig.frameUniformsBuffer, 0, buf);
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

		// Group by zIndex, then by markType
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

		// Cache pipeline references
		for (const layer of newPlan) {
			layer.cachedPipeline = layer.renderer?.pipeline;
		}

		chartConfig.renderPlan = newPlan;
		chartConfig.needsPlanRebuild = false;
	}

	// =========================================================================
	// RENDER PASS DESCRIPTOR
	// =========================================================================

	#createRenderPassDescriptor(textureView, canvas, chartId) {
		const chart = this.#registeredCharts.get(chartId);

		if (this.#msaaSampleCount > 1) {
			let msaa = this.#msaaCache.get(chartId);

			if (!msaa || msaa.texture.width !== canvas.width || msaa.texture.height !== canvas.height) {
				msaa?.texture.destroy();

				const newTexture = this.#device.createTexture({
					size: { width: canvas.width, height: canvas.height },
					sampleCount: this.#msaaSampleCount,
					format: this.#presentationFormat,
					usage: GPUTextureUsage.RENDER_ATTACHMENT
				});

				msaa = { texture: newTexture, view: newTexture.createView() };
				this.#msaaCache.set(chartId, msaa);

				if (chart) chart.renderPassDescriptor = null;
			}

			if (chart?.renderPassDescriptor) {
				chart.renderPassDescriptor.colorAttachments[0].resolveTarget = textureView;
				return chart.renderPassDescriptor;
			}

			const desc = {
				colorAttachments: [
					{
						view: msaa.view,
						resolveTarget: textureView,
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			};

			if (chart) chart.renderPassDescriptor = desc;
			return desc;
		} else {
			if (chart?.renderPassDescriptor) {
				chart.renderPassDescriptor.colorAttachments[0].view = textureView;
				return chart.renderPassDescriptor;
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

			if (chart) chart.renderPassDescriptor = desc;
			return desc;
		}
	}

	// =========================================================================
	// PIPELINE FACTORY
	// =========================================================================

	#getOrCreateDataLayout(markType, dataBindingConfig) {
		const layoutKey = `${markType}-${JSON.stringify(dataBindingConfig)}`;

		if (!this.#dataLayouts.has(layoutKey)) {
			const layout = this.#device.createBindGroupLayout({
				label: `${markType}-data-layout`,
				entries: dataBindingConfig.map((config) => ({
					binding: config.binding,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: config.type || 'read-only-storage' }
				}))
			});
			this.#dataLayouts.set(layoutKey, layout);
		}

		return this.#dataLayouts.get(layoutKey);
	}

	async createPipelineForMarkType(
		markType,
		scaleTypes,
		markShaderCode,
		vertexBufferLayout,
		dataBindingConfig
	) {
		const templateResult = scaleTemplateSystem.generateShader(scaleTypes, markShaderCode);

		const frameLayout = this.#getOrCreateFrameLayout();
		const dataLayout = this.#getOrCreateDataLayout(markType, dataBindingConfig);
		const globalScaleLayout = this.#globalScaleLayout;

		if (!globalScaleLayout) {
			throw new Error('Global scale SSBO layout not found');
		}

		const pipelineLayout = this.#device.createPipelineLayout({
			label: `${markType}-pipeline-layout`,
			bindGroupLayouts: [frameLayout, dataLayout, globalScaleLayout]
		});

		const shaderModule = await this.getOrCreateSharedShader(markType, templateResult.shaderCode);

		const pipeline = await this.getOrCreateSharedPipeline(
			`${markType}-${scaleTypes.x}-${scaleTypes.y}`,
			async () => {
				return this.#device.createRenderPipeline({
					label: `${markType}-${scaleTypes.x}-${scaleTypes.y}-pipeline`,
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
			}
		);

		return { pipeline, frameLayout, dataLayout };
	}

	// =========================================================================
	// SHARED RESOURCE MANAGEMENT
	// =========================================================================

	async getOrCreateSharedPipeline(markType, createFn) {
		const existing = this.#sharedResources.pipelines.get(markType);
		if (existing) {
			existing.refCount++;
			return existing.pipeline;
		}

		if (this.#creatingPipelines.has(markType)) {
			while (this.#creatingPipelines.has(markType)) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const newExisting = this.#sharedResources.pipelines.get(markType);
			if (newExisting) {
				newExisting.refCount++;
				return newExisting.pipeline;
			}
		}

		this.#creatingPipelines.add(markType);

		try {
			const pipeline = await createFn();
			this.#sharedResources.pipelines.set(markType, {
				pipeline,
				refCount: 1,
				createdAt: Date.now()
			});
			return pipeline;
		} finally {
			this.#creatingPipelines.delete(markType);
		}
	}

	async getOrCreateSharedShader(markType, shaderCode) {
		const existing = this.#sharedResources.shaderModules.get(markType);
		if (existing) {
			existing.refCount++;
			return existing.module;
		}

		const module = this.#device.createShaderModule({ code: shaderCode });
		this.#sharedResources.shaderModules.set(markType, {
			module,
			refCount: 1,
			createdAt: Date.now()
		});

		return module;
	}

	releaseSharedPipeline(markType) {
		const resource = this.#sharedResources.pipelines.get(markType);
		if (!resource) return;

		resource.refCount--;
		if (resource.refCount <= 0) {
			this.#sharedResources.pipelines.delete(markType);
		}
	}

	releaseSharedShader(markType) {
		const resource = this.#sharedResources.shaderModules.get(markType);
		if (!resource) return;

		resource.refCount--;
		if (resource.refCount <= 0) {
			this.#sharedResources.shaderModules.delete(markType);
			console.debug(`Shader module for ${markType} released.`);
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

	// =========================================================================
	// CLEANUP
	// =========================================================================

	destroy() {
		console.log('Destroying GPUCoordinator');

		// Stop animation loop
		this.#animationLoop?.destroy();
		this.#animationLoop = null;

		this.#animatedScales.clear();
		this.#animatedScalesArray.length = 0;

		// Cleanup MSAA textures
		for (const msaa of this.#msaaCache.values()) {
			msaa.texture?.destroy?.();
		}
		this.#msaaCache.clear();

		// Cleanup shared resources
		for (const [, resource] of this.#sharedResources.uniformBuffers) {
			resource.buffer?.destroy?.();
		}
		this.#sharedResources.uniformBuffers.clear();
		this.#sharedResources.pipelines.clear();
		this.#sharedResources.shaderModules.clear();
		this.#sharedResources.bindGroupLayouts.clear();

		// Cleanup SSBO
		this.#globalScaleSSBO?.destroy?.();
		this.#globalScaleLayout = null;

		// Cleanup charts
		this.#registeredCharts.clear();
		this.#dirtyChartIDs.clear();

		// Cleanup layouts
		this.#dataLayouts.clear();
		this.#frameLayout = null;
		this.#pendingScaleMappings.clear();

		// Destroy device
		this.#device?.destroy?.();
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
