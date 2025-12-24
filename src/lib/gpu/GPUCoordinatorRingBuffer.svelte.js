import { setContext, getContext } from 'svelte';
import { scaleTemplateSystem } from './ScaleTemplateSystem.js';

const TIMESTEP = 1000 / 480; // 60Hz physics clock

// Note: We disallow negative values as this is used for timestamp queries
// where it's possible for a query to return a beginning time greater than the
// end time. See: https://gpuweb.github.io/gpuweb/#timestamp
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
		return this.#total / this.#samples.length;
	}
}

// Add this class inside GPUCoordinator.svelte.js before the GPUCoordinator class
class ScaleIndexManager {
	#scaleIds = [];
	#scaleIdToIndex = new Map();

	rebuild(allCurrentScaleIds) {
		console.log('Rebuilding scale indices:', allCurrentScaleIds);
		this.#scaleIds = [...allCurrentScaleIds];
		this.#scaleIdToIndex.clear();

		this.#scaleIds.forEach((scaleId, index) => {
			this.#scaleIdToIndex.set(scaleId, index);
		});

		console.log('Scale index mapping:', Object.fromEntries(this.#scaleIdToIndex));
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

/**
 * Enhanced GPUCoordinator with scale instance buffer pools
 * Eliminates CPU-GPU sync stalls during panning/zooming
 */
export class GPUCoordinator {
	// Core WebGPU resources
	#device = $state(null);
	#canTimestamp = false;
	#querySet = null;
	#resolveBuffer = null;
	#resultBuffer = null;
	#presentationFormat = $state(null);
	#initialized = $state(false);

	// Enhanced shared resources with reference counting
	#sharedResources = $state({
		pipelines: new Map(), // markType -> { pipeline, refCount, createdAt }
		uniformBuffers: new Map(), // name -> { buffer, refCount, createdAt }
		shaderModules: new Map(), // markType -> { module, refCount, createdAt }
		bindGroupLayouts: new Map() // markType -> { layout, refCount, createdAt }
	});

	// Chart registration and management
	#registeredCharts = $state(new Map());
	#msaaCache = new Map();
	#dirtyChartIDs = new Set();
	#renderScheduled = false;

	// Animation system properties
	#animatedScales = new Set();
	#animationActive = false;
	#animationRafId = null;
	#scaleRegistry = null;
	#accumulator = 0;
	// #TIMESTEP = 1000 / 120;
	#TIMESTEP = 1000 / 60;
	#lastFrameTime = 0;
	#chartsToRenderSet = new Set();
	#chartsToRenderArray = [];
	// #msaaSampleCount = 4;
	#msaaSampleCount = 1;
	#globalInputDelay = 0;
	// #renderCount = 0;

	// Performance tracking
	#smoothedDeltaTime = 8.3; // Initialize to ideal 60fps
	#smoothingFactor = 0.05; // Adjust this value (0.05 to 0.2 is a good range)
	#frameHistory = [];
	#frameTimings = [];

	// Race condition protection
	#creatingPipelines = new Set();

	// Scale instance buffer pool system
	// #scaleBindGroupLayouts = new Map(); // scaleType -> GPUBindGroupLayout
	#globalScaleLayout = null;

	#templateSystem = scaleTemplateSystem;
	#frameLayout = null;
	#dataLayouts = new Map(); // markType-config -> GPUBindGroupLayout
	#pendingScaleMappings = new Map(); // chartId -> { xScaleId, yScaleId }
	#pendingFrameUpdates = new Map(); // chartId -> update params

	// #nextFrameId = 0;

	#scaleIndexManager = null;
	#maxScaleSlots = 256;

	#SSBO_SLOT_COUNT = 10;
	// #SSBO_SLOT_COUNT = 16;
	// #MAX_FRAMES_IN_FLIGHT = 3;
	#frameId = 0;
	// #inflightPromises = [];
	#stagingPool = [];
	#globalScaleSSBO = null; // Single buffer with 3 slots
	#slotByteSize = null;
	#globalScaleBindGroups = [];

	#scaleIdToInstance = new Map();
	#ssboNeedsUpload = false;

	#previousFrameComplete = null;

	#stagingResultCache = { staging: null, dstOffset: 0, slot: 0 };

	#fpsAverage = new NonNegativeRollingAverage(30);
	#cpuAverage = new NonNegativeRollingAverage(30);
	#gpuAverage = new NonNegativeRollingAverage(30);
	timings = $state({});

	#frameTimestamps = [];
	#lastLogTime = 0;

	#chartTexturesCache = new Map();

	// #slotInUse = new Array(this.#SSBO_SLOT_COUNT).fill(null); // Track promises per slo

	#slotInUse;

	#slotFences = null; // Initialize in constructor
	#stagingPoolAvailable = null; // Initialize in constructor
	#slotCompletionHandlers = null; // Initialize in constructor

	// Ring buffer tracking
	#stagingPoolHead = 0;
	#stagingPoolCount = 0;

	// Reusable staging result
	#stagingResult = {
		staging: null,
		dstOffset: 0,
		slot: 0
	};

	// #cpuScaleBuffer = null;

	// constructor(config = {}) {
	// 	this.#msaaSampleCount = config.msaaSampleCount ?? 4;

	// 	this.#scaleIndexManager = new ScaleIndexManager();

	// 	this.perf = new MinimalPerfLogger(10000);
	// 	if (typeof window !== 'undefined') {
	// 		window.exportPerf = () => this.perf.downloadJSON();
	// 		window.resetPerf = () => this.perf.reset();
	// 		window.perfStatus = () =>
	// 			console.log(`${this.perf.index}/${this.perf.maxSamples} samples collected`);
	// 	}

	// 	// Pre-create promise handlers for each slot
	// 	for (let slotIndex = 0; slotIndex < this.#SSBO_SLOT_COUNT; slotIndex++) {
	// 		this.#slotCompletionHandlers[slotIndex] = {
	// 			onComplete: () => {
	// 				this.#slotFences[slotIndex] = null;
	// 			},
	// 			onError: (err) => {
	// 				console.error(`Fence error for slot ${slotIndex}:`, err);
	// 				this.#slotFences[slotIndex] = null;
	// 			}
	// 		};
	// 	}

	// 	// Initialize staging pool availability
	// 	this.#stagingPoolAvailable.fill(1); // All available initially
	// }
	constructor(config = {}) {
		this.#msaaSampleCount = config.msaaSampleCount ?? 4;
		this.#scaleIndexManager = new ScaleIndexManager();

		// ✅ Initialize arrays that depend on constants
		this.#slotFences = new Array(this.#SSBO_SLOT_COUNT).fill(null);
		this.#stagingPoolAvailable = new Uint8Array(32); // 32 staging buffers
		this.#stagingPoolAvailable.fill(1); // All available initially
		this.#stagingPoolCount = 32;

		// ✅ Pre-create promise handlers for each slot
		this.#slotCompletionHandlers = [];
		for (let slotIndex = 0; slotIndex < this.#SSBO_SLOT_COUNT; slotIndex++) {
			this.#slotCompletionHandlers[slotIndex] = {
				onComplete: () => {
					this.#slotFences[slotIndex] = null;
				},
				onError: (err) => {
					console.error(`Fence error for slot ${slotIndex}:`, err);
					this.#slotFences[slotIndex] = null;
				}
			};
		}

		this.perf = new MinimalPerfLogger(10000);
		if (typeof window !== 'undefined') {
			window.exportPerf = () => this.perf.downloadJSON();
			window.resetPerf = () => this.perf.reset();
			window.perfStatus = () =>
				console.log(`${this.perf.index}/${this.perf.maxSamples} samples collected`);
		}
	}

	async initialize() {
		if (this.#initialized) return;
		try {
			await this.#initWebGPU();
			await this.#createSharedResources();
			await this.#initializeScaleBindGroupLayouts();
			this.#initialized = true;
			this.#handleScaleTopologyChange();
			console.log('GPUCoordinator initialized with scale instance buffer pool architecture');
		} catch (error) {
			console.error('GPUCoordinator initialization failed:', error);
			throw error;
		}
	}

	async #initializeScaleBindGroupLayouts() {
		// Create global SSBO layout (one layout for all scale types)
		const globalScaleLayout = this.#device.createBindGroupLayout({
			label: 'global-scale-ssbo-layout',
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: {
						type: 'read-only-storage' // Changed from 'uniform' to 'read-only-storage'
					}
				}
			]
		});

		this.#globalScaleLayout = globalScaleLayout;
		this.#createGlobalScaleSSBO();

		for (let slot = 0; slot < this.#SSBO_SLOT_COUNT; slot++) {
			const layout = this.#globalScaleLayout;
			const slotOffset = slot * this.#slotByteSize;
			const bg = this.#device.createBindGroup({
				label: `global-scale-bind-group-slot-${slot}`,
				layout,
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
			this.#globalScaleBindGroups[slot] = bg;
		}

		console.log('Initialized global SSBO layout, buffers, and bind group');
	}

	/**
	 * Get or create the shared frame layout for all charts
	 * @private
	 */
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
			console.log('Created shared frame layout for per-chart uniforms');
		}
		return this.#frameLayout;
	}

	#createGlobalScaleSSBO() {
		const scaleParamSize = 16; // 4 floats * 4 bytes
		this.#slotByteSize = this.#maxScaleSlots * scaleParamSize;
		const totalSSBOSize = this.#slotByteSize * this.#SSBO_SLOT_COUNT;

		// Single SSBO with 3 slots
		this.#globalScaleSSBO = this.#device.createBuffer({
			size: totalSSBOSize,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			label: 'global-scale-ssbo-triple-buffered'
		});

		// Create staging buffer pool (pre-mapped)
		for (let i = 0; i < 32; i++) {
			// 4 staging buffers for safety
			const staging = this.#device.createBuffer({
				size: this.#slotByteSize,
				usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
				mappedAtCreation: true,
				label: `scale-staging-pool-${i}`
			});

			// Pre-create the Float32Array view once
			staging._f32View = new Float32Array(staging.getMappedRange());
			this.#stagingPool.push(staging);
		}
	}

	#updateScaleSSBOWithStaging() {
		if (this.#animatedScales.size === 0) return;

		// Debug: count buffer states
		// const mappedCount = this.#stagingPool.filter((b) => b.mapState === 'mapped').length;
		// const pendingCount = this.#stagingPool.filter((b) => b.mapState === 'pending').length;
		// const unmappedCount = this.#stagingPool.filter((b) => b.mapState === 'unmapped').length;
		// console.log(
		// 	`Pool: ${this.#stagingPool.length} total, ${mappedCount} mapped, ${pendingCount} pending, ${unmappedCount} unmapped`
		// );

		// Get pre-mapped staging buffer from pool
		// const staging = this.#stagingPool.pop();
		// const staging = this.#stagingPool.shift();
		let staging = null;
		let bufferIndex = -1;

		for (let i = 0; i < this.#stagingPool.length; i++) {
			if (this.#stagingPool[i].mapState === 'mapped') {
				staging = this.#stagingPool[i];
				bufferIndex = i;
				break;
			}
		}
		// console.log(`Staging pool size: ${this.#stagingPool.length}/16`);

		if (!staging) {
			console.warn('No staging buffer available in pool');
			const previousSlot = (this.#frameId - 1 + this.#SSBO_SLOT_COUNT) % this.#SSBO_SLOT_COUNT;
			return {
				staging: null,
				dstOffset: previousSlot * this.#slotByteSize,
				slot: previousSlot
			};
		}

		// if (staging.mapState !== 'mapped') {
		// 	console.warn(`Buffer not mapped (state: ${staging.mapState})`);
		// 	const previousSlot = (this.#frameId - 1 + this.#SSBO_SLOT_COUNT) % this.#SSBO_SLOT_COUNT;
		// 	return {
		// 		staging: null,
		// 		dstOffset: previousSlot * this.#slotByteSize,
		// 		slot: previousSlot
		// 	};
		// }

		this.#stagingPool.splice(bufferIndex, 1);

		// Calculate destination slot
		const slot = this.#frameId % this.#SSBO_SLOT_COUNT;
		const dstOffset = slot * this.#slotByteSize;

		// Write all scales synchronously to mapped staging
		// const view = new Float32Array(staging.getMappedRange());
		// this.#fillAllScales(view);
		// this.#fillAllScales(new Float32Array(staging.getMappedRange()));
		this.#fillAllScales(staging._f32View);
		// console.log(view[0], view[1], view[2])

		// Reuse the cached object instead of creating new one
		this.#stagingResultCache.staging = staging;
		this.#stagingResultCache.dstOffset = dstOffset;
		this.#stagingResultCache.slot = slot;

		return this.#stagingResultCache;

		// return { staging, dstOffset, slot };
	}

	#fillAllScales(view) {
		// view.fill(0);

		// NEW: Iterate the Map directly - zero allocations
		for (const [id, scale] of this.#scaleIdToInstance) {
			if (!scale) continue;

			const idx = this.#scaleIndexManager.getIndex(id);
			if (idx === undefined) continue;

			const s = scale.gpuState;
			if (!s) continue;

			const off = idx * 4;
			view[off + 0] = s.domainMin;
			view[off + 1] = s.domainMax;
			view[off + 2] = s.domainScale || 1.0 / (s.domainMax - s.domainMin);
			view[off + 3] = 0;
			// console.log(s.domainMin, s.domainMax, s.domainScale);
		}
	}

	registerScale(scaleId, scaleType = 'linear') {
		if (!this.#initialized) {
			return;
		}

		this.#handleScaleTopologyChange();
	}

	unregisterScale(scaleId) {
		this.#handleScaleTopologyChange();
	}

	#handleScaleTopologyChange() {
		// Build list of scale ids and a map id -> instance
		const ids = [];
		this.#scaleIdToInstance.clear();

		if (this.#scaleRegistry?.scaleUsage) {
			for (const scale of this.#scaleRegistry.scaleUsage.keys()) {
				if (scale?.id) {
					ids.push(scale.id);
					this.#scaleIdToInstance.set(scale.id, scale);
				}
			}
		}

		const count = this.#scaleIndexManager.rebuild(ids);

		// Grow SSBO if needed
		if (count > this.#maxScaleSlots) {
			let newSlots = this.#maxScaleSlots;
			while (newSlots < count) newSlots *= 2;
			this.#maxScaleSlots = newSlots;
			this.#recreateGlobalScalesSSBOAndBindGroups();
		}

		// Indices chnaged -> per-chart uniforms must be rewritten
		for (const [chartid] of this.#registeredCharts) {
			this.updateChartFrameUniforms(chartid);
		}

		// Force one full upload so SSBO has initial values
		this.#ssboNeedsUpload = true;
	}

	#recreateGlobalScalesSSBOAndBindGroups() {
		try {
			this.#globalScaleSSBO?.destroy?.();
		} catch {}
		// Drop old staging
		for (const s of this.#stagingPool) {
			try {
				s.unmap();
			} catch {}
			try {
				s.destroy?.();
			} catch {}
		}
		this.#stagingPool.length = 0;

		// Recreate SSBO & staging and the 3 bind groups
		this.#createGlobalScaleSSBO();
		this.#globalScaleBindGroups.length = 0;
		for (let slot = 0; slot < this.#SSBO_SLOT_COUNT; slot++) {
			const layout = this.#globalScaleLayout;

			const offset = slot * this.#slotByteSize;
			this.#globalScaleBindGroups[slot] = this.#device.createBindGroup({
				layout,
				entries: [
					{
						binding: 0,
						resource: { buffer: this.#globalScaleSSBO, offset, size: this.#slotByteSize }
					}
				]
			});
		}
	}

	/**
	 * Create frame uniform buffer and bind group for a specific chart
	 * @private
	 */
	#createChartFrameResources(chartId) {
		const chartConfig = this.#registeredCharts.get(chartId);
		if (!chartConfig || chartConfig.frameUniformsBuffer) {
			return; // Chart doesn't exist or resources already created
		}

		try {
			chartConfig.frameUniformsBuffer = this.#device.createBuffer({
				size: 48, // 10 x f32 = 40 bytes
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				label: `frame-uniforms-${chartId}`
			});

			// Create the bind group
			this.#createChartFrameBindGroup(chartId);

			console.log(`Created frame resources for chart ${chartId}`);
		} catch (error) {
			console.error(`Failed to create frame resources for chart ${chartId}:`, error);
		}
	}

	/**
	 * Create frame bind group for a specific chart
	 * @private
	 */
	#createChartFrameBindGroup(chartId) {
		const chartConfig = this.#registeredCharts.get(chartId);
		if (!chartConfig?.frameUniformsBuffer || chartConfig.perFrameBindGroup) {
			return; // Buffer not ready or bind group already exists
		}

		try {
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

			console.log(`Created frame bind group for chart ${chartId}`);
		} catch (error) {
			console.error(`Failed to create frame bind group for chart ${chartId}:`, error);
		}
	}

	/**
	 * Update frame uniforms for a specific chart
	 * Called when canvas dimensions or DPR changes
	 */
	updateChartFrameUniforms(chartId) {
		const chartConfig = this.#registeredCharts.get(chartId);
		if (!chartConfig?.contextConfigured) {
			console.debug(`Queueing frame uniforms update for unregistered chart ${chartId}`);
			this.#pendingFrameUpdates.set(chartId, { timestamp: Date.now() });
			return;
		}

		try {
			// Create resources if they don't exist yet
			if (!chartConfig.frameUniformsBuffer) {
				this.#createChartFrameResources(chartId);
			}

			const dpr = window.devicePixelRatio || 1;
			const canvas = chartConfig.canvas;

			// Compute in logical CSS px, then convert ranges to physical px
			const resX = canvas.width;
			const resY = canvas.height;

			const rangeMinX = 0 * dpr;
			const rangeMinY = canvas.clientHeight * dpr;
			const rangeMaxX = canvas.clientWidth * dpr;
			const rangeMaxY = 0 * dpr;

			const xScaleIndex = this.#scaleIndexManager.getIndex(chartConfig.xScaleId) ?? 0;
			const yScaleIndex = this.#scaleIndexManager.getIndex(chartConfig.yScaleId) ?? 1;

			// Build 48-byte uniform payload
			const buf = new ArrayBuffer(48);
			const f32 = new Float32Array(buf);
			const u32 = new Uint32Array(buf);

			// Floats: resolution(2), rangeMin(2), rangeMax(2), devicePixelRation, _pad0
			f32[0] = resX;
			f32[1] = resY;
			f32[2] = rangeMinX;
			f32[3] = rangeMinY;
			f32[4] = rangeMaxX;
			f32[5] = rangeMaxY;
			f32[6] = dpr;
			f32[7] = 0.0;

			// U32s: xScaleIndex, yScaleIndex, _pad1 (2x)
			u32[8] = xScaleIndex >>> 0;
			u32[9] = yScaleIndex >>> 0;
			u32[10] = 0;
			u32[11] = 0;

			this.#device.queue.writeBuffer(chartConfig.frameUniformsBuffer, 0, buf);
		} catch (error) {
			console.error(`Failed to update frame uniforms for chart ${chartId}:`, error);
		}
	}

	// Process pending updates when chart becomes ready
	#processPendingFrameUpdates(chartId) {
		const pendingUpdate = this.#pendingFrameUpdates.get(chartId);
		if (pendingUpdate) {
			console.debug(`Processing queued frame uniforms update for chart ${chartId}`);
			this.updateChartFrameUniforms(chartId);
			this.#pendingFrameUpdates.delete(chartId);
		}
	}

	#animationLoop = async (currentTime) => {
		const loopStart = performance.now();
		const now = currentTime;
		// const now = loopStart;

		// Calculate delta time
		if (this.#lastFrameTime === 0) this.#lastFrameTime = now;
		let deltaTime = now - this.#lastFrameTime;
		this.#lastFrameTime = now;

		// Clamp to prevent issues on tab resume or frame drops (cap at ~30fps minimum)
		deltaTime = Math.min(deltaTime, 33.33);

		// Determine if we should continue animating BEFORE processing
		const shouldContinueAnimating = this.#animatedScales.size > 0;

		// Process input and update physics (only if animating)
		if (shouldContinueAnimating) {
			for (const scale of this.#animatedScales) {
				scale._applyInput?.(deltaTime);
			}

			for (const scale of this.#animatedScales) {
				scale._updatePhysics(deltaTime);
			}
		}

		// Determine which charts need rendering
		const chartsToRender = this.#chartsToRenderSet;
		chartsToRender.clear();

		// Add charts affected by animated scales
		for (const scale of this.#animatedScales) {
			scale._setRenderState();
			const affectedCharts = this.#getChartsUsingScale(scale);
			affectedCharts.forEach((chartId) => chartsToRender.add(chartId));
		}

		// Add any charts dirtied by non-animation events (resize, data updates, etc.)
		this.#dirtyChartIDs.forEach((id) => chartsToRender.add(id));
		this.#dirtyChartIDs.clear();

		// Render if needed
		if (chartsToRender.size > 0) {
			const chartArray = this.#chartsToRenderArray;
			chartArray.length = 0;

			for (const chartId of chartsToRender) {
				const chart = this.#registeredCharts.get(chartId);
				if (chart?.visible && chart.contextConfigured) {
					chartArray.push(chart);
				}
			}

			if (chartArray.length > 0) {
				// await this.#coordinatedRender(chartArray);
				this.#coordinatedRender(chartArray);
			}
		}

		const loopEnd = performance.now();

		const frameDuration = loopEnd - loopStart;

		// ✅ Log when frame takes too long
		// if (frameDuration > 5	) {
		// const heapSize = performance.memory?.usedJSHeapSize;
		// console.warn(
		// `⚠️ Slow frame: ${frameDuration.toFixed(2)}ms, heap: ${(heapSize / 1_000_000).toFixed(2)}MB`
		// );
		// }

		// Update performance metrics
		this.#cpuAverage.addSample(loopEnd - loopStart);
		this.#fpsAverage.addSample(1000 / deltaTime);
		this.timings.cpu = this.#cpuAverage.get().toFixed(2);
		this.timings.fps = this.#fpsAverage.get().toFixed(2);

		// Schedule next frame immediately for best frame pacing (only if animating)
		if (shouldContinueAnimating) {
			this.#animationRafId = requestAnimationFrame(this.#animationLoop);
		} else {
			this.#animationActive = false;
			this.#animationRafId = null;
		}
	};

	// async #coordinatedRender(chartsNeedingRender) {
	// 	// Yield to let compositor sync up - critical for smooth 120Hz presentation
	// 	if ('scheduler' in window && 'yield' in scheduler) {
	// 		await scheduler.yield({ priority: 'user-blocking' });
	// 	} else {
	// 		await new Promise((resolve) => setTimeout(resolve, 0));
	// 	}

	// 	const desiredSlot = this.#frameId % this.#SSBO_SLOT_COUNT;

	// 	// Check if we're about to cause a hazard
	// 	if (this.#slotInUse[desiredSlot]) {
	// 		const waitStart = performance.now();
	// 		await this.#slotInUse[desiredSlot];
	// 		const waitTime = performance.now() - waitStart;

	// 		if (waitTime > 1) {
	// 			console.warn(
	// 				`Had to wait ${waitTime.toFixed(2)}ms for slot ${desiredSlot} - GPU backpressure`
	// 			);
	// 		}
	// 	}

	// 	// Acquire textures - signals frame intent to compositor (reuse Map to avoid GC)
	// 	const chartTextures = this.#chartTexturesCache;
	// 	chartTextures.clear();
	// 	for (const chartConfig of chartsNeedingRender) {
	// 		chartTextures.set(chartConfig.chartId, chartConfig.context.getCurrentTexture());
	// 	}

	// 	// Prepare SSBO updates
	// 	let stagingResult = null;
	// 	if (this.#ssboNeedsUpload || this.#animatedScales.size > 0) {
	// 		stagingResult = this.#updateScaleSSBOWithStaging();
	// 		this.#ssboNeedsUpload = false;
	// 	}

	// 	// Early exit if no staging buffer (shouldn't happen in normal operation)
	// 	if (!stagingResult || !stagingResult.staging) {
	// 		console.error('No staging result - skipping frame');
	// 		return;
	// 	}

	// 	// Encode GPU commands
	// 	const commandEncoder = this.#device.createCommandEncoder({ label: 'frame-encoder' });

	// 	// Copy staging to SSBO
	// 	commandEncoder.copyBufferToBuffer(
	// 		stagingResult.staging,
	// 		0,
	// 		this.#globalScaleSSBO,
	// 		stagingResult.dstOffset,
	// 		this.#slotByteSize
	// 	);

	// 	const currentScaleBindGroup = this.#globalScaleBindGroups[stagingResult.slot];

	// 	// Encode render passes
	// 	for (const chartConfig of chartsNeedingRender) {
	// 		if (chartConfig.needsPlanRebuild) {
	// 			this.#buildRenderPlanForChart(chartConfig);
	// 		}

	// 		const texture = chartTextures.get(chartConfig.chartId);
	// 		const passEncoder = commandEncoder.beginRenderPass(
	// 			this.#createRenderPassDescriptor(
	// 				texture.createView(),
	// 				chartConfig.canvas,
	// 				chartConfig.chartId
	// 			)
	// 		);

	// 		const chartPerFrameBindGroup = chartConfig.perFrameBindGroup;
	// 		if (!chartPerFrameBindGroup) {
	// 			passEncoder.end();
	// 			continue;
	// 		}

	// 		passEncoder.setBindGroup(0, chartPerFrameBindGroup);
	// 		passEncoder.setBindGroup(2, currentScaleBindGroup);

	// 		let currentPipeline = null;
	// 		let currentPerDataBindGroup = null;

	// 		for (const layer of chartConfig.renderPlan) {
	// 			const renderer = layer.renderer;
	// 			if (!renderer || !renderer.perDataBindGroup) continue;

	// 			const pipelineToUse = layer.cachedPipeline;
	// 			const perDataBindGroupToUse = renderer.perDataBindGroup;

	// 			if (pipelineToUse !== currentPipeline) {
	// 				passEncoder.setPipeline(pipelineToUse);
	// 				currentPipeline = pipelineToUse;
	// 			}

	// 			if (perDataBindGroupToUse !== currentPerDataBindGroup) {
	// 				passEncoder.setBindGroup(1, perDataBindGroupToUse);
	// 				currentPerDataBindGroup = perDataBindGroupToUse;
	// 			}

	// 			layer.draw(passEncoder);
	// 		}
	// 		passEncoder.end();
	// 	}

	// 	// Timestamp queries if enabled
	// 	if (this.#canTimestamp) {
	// 		commandEncoder.resolveQuerySet(
	// 			this.#querySet,
	// 			0,
	// 			this.#querySet.count,
	// 			this.#resolveBuffer,
	// 			0
	// 		);
	// 		if (this.#resultBuffer.mapState === 'unmapped') {
	// 			commandEncoder.copyBufferToBuffer(
	// 				this.#resolveBuffer,
	// 				0,
	// 				this.#resultBuffer,
	// 				0,
	// 				this.#resultBuffer.size
	// 			);
	// 		}
	// 	}

	// 	// Unmap and submit
	// 	stagingResult.staging.unmap();
	// 	this.#device.queue.submit([commandEncoder.finish()]);

	// 	// Track GPU completion for this slot
	// 	const completionPromise = this.#device.queue.onSubmittedWorkDone();
	// 	this.#slotInUse[desiredSlot] = completionPromise;

	// 	// Clear the slot marker when done (don't block future frames unnecessarily)
	// 	completionPromise.then(() => {
	// 		this.#slotInUse[desiredSlot] = null;
	// 		console.log('cleared slot', desiredSlot);
	// 	});

	// 	// Track frame completion (for debugging/monitoring)
	// 	this.#previousFrameComplete = this.#device.queue.onSubmittedWorkDone();

	// 	// Async: Remap staging buffer for reuse (fire and forget)
	// 	stagingResult.staging
	// 		.mapAsync(GPUMapMode.WRITE)
	// 		.then(() => {
	// 			this.#stagingPool.push(stagingResult.staging);
	// 		})
	// 		.catch((err) => {
	// 			console.error('Failed to remap staging buffer:', err);
	// 		});

	// 	// Async: Read timestamp data (fire and forget)
	// 	if (this.#canTimestamp && this.#resultBuffer.mapState === 'unmapped') {
	// 		this.#resultBuffer
	// 			.mapAsync(GPUMapMode.READ)
	// 			.then(() => {
	// 				const times = new BigInt64Array(this.#resultBuffer.getMappedRange());
	// 				const gpuTime = Number(times[1] - times[0]);
	// 				this.#gpuAverage.addSample(gpuTime / 1000);
	// 				this.timings.gpu = this.#gpuAverage.get().toFixed(2);
	// 				this.#resultBuffer.unmap();
	// 			})
	// 			.catch((err) => {
	// 				console.error('Timestamp read failed:', err);
	// 			});
	// 	}

	// 	this.#frameId++;
	// }

	// async #acquireNextSlot() {
	// 	const desiredSlot = this.#frameId % this.#SSBO_SLOT_COUNT;

	// 	if (this.#slotFences[desiredSlot]) {
	// 		const waitStart = performance.now();
	// 		await this.#slotFences[desiredSlot];
	// 		const waitTime = performance.now() - waitStart;

	// 		if (waitTime > 1) {
	// 			console.warn(`GPU backpressure: ${waitTime.toFixed(2)}ms for slot ${desiredSlot}`);
	// 		}
	// 	}

	// 	return desiredSlot;
	// }

	async #acquireNextSlot() {
		const desiredSlot = this.#frameId % this.#SSBO_SLOT_COUNT;

		// Don't wait - skip to next slot if current is busy
		if (this.#slotFences[desiredSlot]) {
			console.warn(`Slot ${desiredSlot} busy - skipping to next`);
			this.#frameId++; // Skip this slot
			return this.#frameId % this.#SSBO_SLOT_COUNT;
		}

		return desiredSlot;
	}

	// ===== ZERO-ALLOCATION SSBO UPDATE =====

	/**
	 * Get staging buffer from ring buffer pool (zero allocation)
	 * @returns {object|null} { buffer, index } or null
	 */
	#getStagingBuffer() {
		const poolSize = this.#stagingPool.length;

		for (let attempt = 0; attempt < poolSize; attempt++) {
			const idx = (this.#stagingPoolHead + attempt) % poolSize;

			if (this.#stagingPoolAvailable[idx] && this.#stagingPool[idx].mapState === 'mapped') {
				// Mark as in-use
				this.#stagingPoolAvailable[idx] = 0;
				this.#stagingPoolHead = (idx + 1) % poolSize;
				this.#stagingPoolCount--;

				return { buffer: this.#stagingPool[idx], index: idx };
			}
		}

		console.warn(`⚠️ No staging buffers available! (${this.#stagingPoolCount}/${poolSize} free)`);
		return null;
	}

	/**
	 * Return staging buffer to pool (zero allocation)
	 */
	#returnStagingBuffer(index) {
		this.#stagingPoolAvailable[index] = 1;
		this.#stagingPoolCount++;
	}

	/**
	 * Update SSBO for specific slot - REUSES staging result object
	 * @param {number} slot
	 * @returns {object} The reused #stagingResult object (or sets staging=null)
	 */
	#updateScaleSSBOForSlot(slot) {
		// Reset reusable object
		this.#stagingResult.staging = null;
		this.#stagingResult.dstOffset = 0;
		this.#stagingResult.slot = slot;

		if (this.#animatedScales.size === 0 && !this.#ssboNeedsUpload) {
			return this.#stagingResult;
		}

		// Get staging buffer from ring buffer pool
		const stagingInfo = this.#getStagingBuffer();

		if (!stagingInfo) {
			console.warn('No staging buffer available');
			return this.#stagingResult;
		}

		const staging = stagingInfo.buffer;
		const stagingIndex = stagingInfo.index;

		// Store index so we can return to pool later
		staging._poolIndex = stagingIndex;

		// Calculate destination offset
		const dstOffset = slot * this.#slotByteSize;

		// Fill staging buffer (reuses mapped memory)
		// this.#fillAllScales(new Float32Array(staging.getMappedRange()));
		this.#fillAllScales(staging._f32View);

		// Update reusable result object
		this.#stagingResult.staging = staging;
		this.#stagingResult.dstOffset = dstOffset;
		this.#stagingResult.slot = slot;

		return this.#stagingResult;
	}

	// ===== ZERO-ALLOCATION SLOT TRACKING =====

	/**
	 * Track slot completion using pre-allocated handlers
	 * @param {number} slot
	 */
	#trackSlotCompletion(slot) {
		const fence = this.#device.queue.onSubmittedWorkDone();
		this.#slotFences[slot] = fence;

		// Use pre-allocated handlers (no closure creation)
		const handlers = this.#slotCompletionHandlers[slot];
		fence.then(handlers.onComplete).catch(handlers.onError);
	}

	// ===== ZERO-ALLOCATION RENDER =====

	// async #coordinatedRender(chartsNeedingRender) {
	#coordinatedRender(chartsNeedingRender) {
		// await this.#device.onSubmittedWorkDone()
		// Yield to compositor
		// if ('scheduler' in window && 'yield' in scheduler) {
		// 	await scheduler.yield({ priority: 'user-blocking' });
		// } else {
		// 	await new Promise((resolve) => setTimeout(resolve, 0));
		// }

		// Acquire slot
		// const slot = await this.#acquireNextSlot();
		const slot = this.#frameId % this.#SSBO_SLOT_COUNT;

		// let slot = -1;
		// for (let i = 0; i < this.#SSBO_SLOT_COUNT; i++) {
		// 	// We cycle through slots based on frameId to distribute load,
		// 	// but we don't strictly require that specific slot.
		// 	// This logic checks: preferred slot -> next -> next -> etc.
		// 	const checkIndex = (this.#frameId + i) % this.#SSBO_SLOT_COUNT;

		// 	if (!this.#slotFences[checkIndex]) {
		// 		slot = checkIndex;
		// 		break;
		// 	}
		// }

		// // 2. If ALL slots are busy, we are truly backed up. Drop frame.
		// if (slot === -1) {
		// 	// Ideally log this once per second to know if you need more slots
		// 	// console.warn('GPU Saturated: All slots busy');
		// 	return;
		// }

		// // Acquire textures (reuses Map - no allocation)
		// const chartTextures = this.#chartTexturesCache;
		// chartTextures.clear();
		// for (const chartConfig of chartsNeedingRender) {
		// 	chartTextures.set(chartConfig.chartId, chartConfig.context.getCurrentTexture());
		// }

		// Update SSBO (reuses object - no allocation)
		const stagingResult = this.#updateScaleSSBOForSlot(slot);
		if (!stagingResult.staging) {
			// No staging memory available (CPU is running too fast?)
			// Drop frame.
			return;
		}
		this.#ssboNeedsUpload = false;

		// if (!stagingResult.staging) {
		// 	console.log('no staging result staging');
		// 	this.#frameId++;
		// 	return;
		// }

		// Encode commands
		const commandEncoder = this.#device.createCommandEncoder({ label: 'frame-encoder' });

		commandEncoder.copyBufferToBuffer(
			stagingResult.staging,
			0,
			this.#globalScaleSSBO,
			stagingResult.dstOffset,
			this.#slotByteSize
		);

		const currentScaleBindGroup = this.#globalScaleBindGroups[slot];

		// Encode render passes
		for (const chartConfig of chartsNeedingRender) {
			if (chartConfig.needsPlanRebuild) {
				this.#buildRenderPlanForChart(chartConfig);
			}

			// chartTextures.set(chartConfig.chartId, chartConfig.context.getCurrentTexture());

			const texture = chartConfig.context.getCurrentTexture();
			const view = texture.createView();

			// const texture = chartTextures.get(chartConfig.chartId);
			const passEncoder = commandEncoder.beginRenderPass(
				this.#createRenderPassDescriptor(view, chartConfig.canvas, chartConfig.chartId)
			);

			const chartPerFrameBindGroup = chartConfig.perFrameBindGroup;
			if (!chartPerFrameBindGroup) {
				passEncoder.end();
				continue;
			}

			passEncoder.setBindGroup(0, chartPerFrameBindGroup);
			passEncoder.setBindGroup(2, currentScaleBindGroup);

			let currentPipeline = null;
			let currentPerDataBindGroup = null;

			for (const layer of chartConfig.renderPlan) {
				const renderer = layer.renderer;
				if (!renderer || !renderer.perDataBindGroup) continue;

				const pipelineToUse = layer.cachedPipeline;
				const perDataBindGroupToUse = renderer.perDataBindGroup;

				if (pipelineToUse !== currentPipeline) {
					passEncoder.setPipeline(pipelineToUse);
					currentPipeline = pipelineToUse;
				}

				if (perDataBindGroupToUse !== currentPerDataBindGroup) {
					passEncoder.setBindGroup(1, perDataBindGroupToUse);
					currentPerDataBindGroup = perDataBindGroupToUse;
				}

				layer.draw(passEncoder);
			}
			passEncoder.end();
		}

		// Timestamp queries
		if (this.#canTimestamp) {
			commandEncoder.resolveQuerySet(
				this.#querySet,
				0,
				this.#querySet.count,
				this.#resolveBuffer,
				0
			);
			if (this.#resultBuffer.mapState === 'unmapped') {
				commandEncoder.copyBufferToBuffer(
					this.#resolveBuffer,
					0,
					this.#resultBuffer,
					0,
					this.#resultBuffer.size
				);
			}
		}

		// Submit
		const staging = stagingResult.staging;
		const stagingPoolIndex = staging._poolIndex;

		staging.unmap();
		this.#device.queue.submit([commandEncoder.finish()]);

		// const fence = this.#device.queue.onSubmittedWorkDone();
		// this.#slotFences[slot] = fence;

		// fence
		// 	.then(this.#slotCompletionHandlers[slot].onComplete)
		// 	.catch(this.#slotCompletionHandlers[slot].onError);

		this.#frameId++;

		// Async: Remap staging buffer (no allocation in promise chain)
		staging
			.mapAsync(GPUMapMode.WRITE)
			.then(() => {
				staging._f32View = new Float32Array(staging.getMappedRange());
				this.#returnStagingBuffer(stagingPoolIndex);
			})
			.catch((err) => {
				console.error('Failed to remap staging buffer:', err);
			});

		// Timestamp reading (existing code - acceptable allocation since it's async)
		if (this.#canTimestamp && this.#resultBuffer.mapState === 'unmapped') {
			this.#resultBuffer
				.mapAsync(GPUMapMode.READ)
				.then(() => {
					const times = new BigInt64Array(this.#resultBuffer.getMappedRange());
					const gpuTime = Number(times[1] - times[0]);
					this.#gpuAverage.addSample(gpuTime / 1000);
					this.timings.gpu = this.#gpuAverage.get().toFixed(2);
					this.#resultBuffer.unmap();
				})
				.catch((err) => {
					console.error('Timestamp read failed:', err);
				});
		}
	}

	/**
	 * Fallback rendering when coordinated render fails
	 * @private
	 */
	#fallbackRender(chartsNeedingRender) {
		console.warn('Using fallback render path');
		for (const chartConfig of chartsNeedingRender) {
			try {
				const commandEncoder = this.#device.createCommandEncoder();
				const passEncoder = commandEncoder.beginRenderPass(
					this.#createRenderPassDescriptor(
						chartConfig.context.getCurrentTexture().createView(),
						chartConfig.canvas,
						chartConfig.chartId
					)
				);

				const chartPerFrameBindGroup = chartConfig.perFrameBindGroup;
				if (!chartPerFrameBindGroup) {
					passEncoder.end();
					continue;
				}

				for (const layer of chartConfig.layers.values()) {
					const renderer = layer.renderer;
					if (renderer?.pipeline && renderer?.perDataBindGroup) {
						const currentSlot = this.#frameId % this.#SSBO_SLOT_COUNT;
						const currentScaleBG = this.#globalScaleBindGroups[currentSlot];
						passEncoder.setPipeline(renderer.pipeline);
						passEncoder.setBindGroup(0, chartPerFrameBindGroup);
						passEncoder.setBindGroup(1, renderer.perDataBindGroup);
						passEncoder.setBindGroup(2, currentScaleBG);
						layer.draw(passEncoder);
					}
				}
				passEncoder.end();
				this.#device.queue.submit([commandEncoder.finish()]);

				this.#frameId++;
			} catch (error) {
				console.error(`Failed to render chart ${chartConfig.chartId}:`, error);
			}
		}
	}

	/**
	 * Get chart context for a layer (helper method)
	 * @private
	 */
	#getChartContextForLayer(layer) {
		// Access chart context through the renderer
		return layer.renderer?.chartContext || null;
	}

	// ===== CHART MANAGEMENT =====

	setScaleRegistry(scaleRegistry) {
		this.#scaleRegistry = scaleRegistry;
	}

	#getChartsUsingScale(scale) {
		if (!this.#scaleRegistry?.scaleUsage) return new Set();
		return this.#scaleRegistry.scaleUsage.get(scale) || new Set();
	}

	/**
	 * Update the scale ID mapping for a specific chart
	 * Called by ChartScales when scale instances are resolved or change
	 */
	setChartScaleMapping(chartId, { xScaleId, yScaleId }) {
		const chartConfig = this.#registeredCharts.get(chartId);
		if (!chartConfig) {
			// Queue the mapping for when chart is registered
			console.debug(`Queueing scale mapping for unregistered chart ${chartId}`);
			this.#pendingScaleMappings.set(chartId, { xScaleId, yScaleId });
			return;
		}

		const changed = chartConfig.xScaleId !== xScaleId || chartConfig.yScaleId !== yScaleId;

		chartConfig.xScaleId = xScaleId;
		chartConfig.yScaleId = yScaleId;

		if (changed) {
			console.debug(`Updated scale mapping for chart ${chartId}:`, { xScaleId, yScaleId });

			// Trigger rebuild of render plan since scale bindings may have changed
			chartConfig.needsPlanRebuild = true;
			this.invalidateChart(chartId);
		}
	}

	invalidateChart(chartId) {
		if (this.#registeredCharts.has(chartId)) {
			this.#dirtyChartIDs.add(chartId);
			this.#ensureLoopIsActive();
		}
	}

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

		this.#animatedScales.add(scale);
		this.#ensureLoopIsActive();
	}

	removeAnimatingScale(scale) {
		this.#animatedScales.delete(scale);
	}

	#ensureLoopIsActive() {
		if (this.#animationRafId) {
			// console.log('⚠️ Prevented duplicate RAF scheduling', this.#animationActive);
			return;
		}

		// if (this.#animatedScales.size > 0 && !this.#animationActive) {
		// 	this.#animationActive = true;
		// 	this.#accumulator = 0;
		// 	this.#lastFrameTime = 0;
		// }

		// Check if there's ANY reason to run the loop
		const hasAnimatedScales = this.#animatedScales.size > 0;
		const hasDirtyCharts = this.#dirtyChartIDs.size > 0;

		if (!hasAnimatedScales && !hasDirtyCharts) {
			console.log('⚠️ No work to do, not scheduling RAF');
			return;
		}

		if (hasAnimatedScales && !this.#animationActive) {
			this.#animationActive = true;
			this.#accumulator = 0;
			this.#lastFrameTime = 0;
		}

		console.log('✅ Scheduling new RAF callback');
		this.#animationRafId = requestAnimationFrame(this.#animationLoop);
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
			perFrameBindGroup: null
		};

		this.#registeredCharts.set(chartId, chartConfig);

		// Process any pending scale mappings for this chart
		const pendingMapping = this.#pendingScaleMappings.get(chartId);
		if (pendingMapping) {
			console.debug(`Applying queued scale mapping for chart ${chartId}:`, pendingMapping);
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
				const config = this.#registeredCharts.get(chartId);
				if (config && config.visible !== visible) {
					config.visible = visible;
					this.invalidateChart(chartId);
				}
			},
			invalidate: () => {
				this.invalidateChart(chartId);
			},
			remove: () => {
				this.unregisterChart(chartId);
			}
		};
	}

	unregisterChart(chartId) {
		const chartConfig = this.#registeredCharts.get(chartId);
		if (chartConfig) {
			// NEW: Clean up per-chart frame resources
			if (chartConfig.frameUniformsBuffer && !chartConfig.frameUniformsBuffer.destroyed) {
				chartConfig.frameUniformsBuffer.destroy();
			}
			// Note: perFrameBindGroup doesn't need explicit cleanup

			this.#registeredCharts.delete(chartId);

			// Existing MSAA cleanup
			const msaa = this.#msaaCache.get(chartId);
			if (msaa) {
				msaa.texture.destroy();
				this.#msaaCache.delete(chartId);
				console.debug(`Destroyed cached MSAA resources for chart: ${chartId}`);
			}

			// Existing pending mappings cleanup
			this.#pendingScaleMappings.delete(chartId);

			console.log(`Unregistered chart: ${chartId}`);
		}
	}

	registerLayer(chartId, layerConfig) {
		const chart = this.#registeredCharts.get(chartId);
		if (!chart) {
			console.error(`Attempted to register layer on non-existent chart: ${chartId}`);
			return { remove: () => {} };
		}

		const layerId = layerConfig.id || `layer-${crypto.randomUUID().slice(0, 8)}`;
		chart.layers.set(layerId, { ...layerConfig, id: layerId, zIndex: layerConfig.zIndex ?? 0 });

		chart.needsPlanRebuild = true;
		console.log(
			`📋 Layer registered: chart ${chartId} now has ${chart.layers.size} layers, needsPlanRebuild=${chart.needsPlanRebuild}`
		);
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
		// console.log(`🏗️ Building render plan for chart ${chartConfig.chartId}: ${chartConfig.layers.size} layers available`);

		const layers = Array.from(chartConfig.layers.values());
		if (layers.length === 0) {
			console.log(`⚠️ No layers to render for chart ${chartConfig.chartId}`);
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

		// Enrich the plan with cached references
		for (const layer of newPlan) {
			layer.cachedPipeline = layer.renderer?.pipeline;
			layer.cachedPerFrameBindGroup = layer.renderer?.perFrameBindGroup;
			layer.cachedPerDataBindGroup = layer.renderer?.perDataBindGroup;
			layer.isDualBindGroupReady = !!(
				layer.cachedPerFrameBindGroup && layer.cachedPerDataBindGroup
			);
		}

		chartConfig.renderPlan = newPlan;
		chartConfig.needsPlanRebuild = false;
		// console.log(`✅ Render plan built for chart ${chartConfig.chartId}: ${newPlan.length} layers in plan`);
	}

	#createRenderPassDescriptor(textureView, canvas, chartId) {
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

				msaa = {
					texture: newTexture,
					view: newTexture.createView()
				};

				this.#msaaCache.set(chartId, msaa);
			}

			return {
				colorAttachments: [
					{
						view: msaa.view,
						resolveTarget: textureView,
						clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
						// loadOp: 'load',
						loadOp: 'clear',
						storeOp: 'store'
					}
				],
				...(this.#canTimestamp && {
					timestampWrites: {
						querySet: this.#querySet,
						beginningOfPassWriteIndex: 0,
						endOfPassWriteIndex: 1
					}
				})
			};
		} else {
			return {
				colorAttachments: [
					{
						view: textureView,
						clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				],
				...(this.#canTimestamp && {
					timestampWrites: {
						querySet: this.#querySet,
						beginningOfPassWriteIndex: 0,
						endOfPassWriteIndex: 1
					}
				})
			};
		}
	}

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
		console.log(`Creating pipeline for ${markType} with scales: ${scaleTypes.x}-${scaleTypes.y}`);

		// Generate shader using template system
		const templateResult = scaleTemplateSystem.generateShader(scaleTypes, markShaderCode);

		// Get or create stable layouts
		const frameLayout = this.#getOrCreateFrameLayout();
		const dataLayout = this.#getOrCreateDataLayout(markType, dataBindingConfig);
		const globalScaleLayout = this.#globalScaleLayout;

		if (!globalScaleLayout) {
			throw new Error('Global scale SSBO layout not found - ensure SSBO system is initialized');
		}

		// Create pipeline layout
		const pipelineLayout = this.#device.createPipelineLayout({
			label: `${markType}-pipeline-layout`,
			bindGroupLayouts: [frameLayout, dataLayout, globalScaleLayout]
		});

		// Create or get shared shader
		console.log('🏭 Creating shader module...');
		const shaderModule = await this.getOrCreateSharedShader(markType, templateResult.shaderCode);
		console.log('🏭 Shader module created successfully');

		// Create pipeline
		console.log('🏭 Creating render pipeline...');
		const pipeline = await this.getOrCreateSharedPipeline(
			`${markType}-${scaleTypes.x}-${scaleTypes.y}`, // Include scale types in cache key
			async () => {
				const msaaSampleCount = this.#msaaSampleCount;

				console.log('🏭 Pipeline config:', {
					msaa: msaaSampleCount,
					format: this.#presentationFormat,
					vertexBuffers: vertexBufferLayout?.length || 0
				});

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
					multisample: { count: msaaSampleCount > 1 ? msaaSampleCount : 1 }
				});
			}
		);

		console.log('🏭 Pipeline created successfully');

		return {
			pipeline,
			frameLayout,
			dataLayout
		};
	}

	// ===== SHARED RESOURCE METHODS WITH REFERENCE COUNTING =====

	async getOrCreateSharedPipeline(markType, createFn) {
		console.log(
			`Pipeline request for ${markType}, existing:`,
			!!this.#sharedResources.pipelines.get(markType)
		);

		const existing = this.#sharedResources.pipelines.get(markType);

		if (existing) {
			existing.refCount++;
			return existing.pipeline;
		}

		// Check if already creating to prevent race conditions
		if (this.#creatingPipelines.has(markType)) {
			// Wait for the other creation to complete
			while (this.#creatingPipelines.has(markType)) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			// Now get the created pipeline
			const newExisting = this.#sharedResources.pipelines.get(markType);
			if (newExisting) {
				newExisting.refCount++;
				console.log(
					`Pipeline request for ${markType}, was reused after creation:`,
					!!this.#sharedResources.pipelines.get(markType)
				);
				return newExisting.pipeline;
			}
		}

		// Mark as creating
		this.#creatingPipelines.add(markType);

		try {
			console.log(`Creating new pipeline for ${markType}`);
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

	releaseSharedPipeline(markType) {
		const resource = this.#sharedResources.pipelines.get(markType);
		if (!resource) return;

		resource.refCount--;

		if (resource.refCount <= 0) {
			this.#sharedResources.pipelines.delete(markType);
			console.log(`Released shared pipeline: ${markType}`);
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

	releaseSharedShader(markType) {
		const resource = this.#sharedResources.shaderModules.get(markType);
		if (!resource) return;

		resource.refCount--;

		if (resource.refCount <= 0) {
			this.#sharedResources.shaderModules.delete(markType);
			console.log(`Released shared shader: ${markType}`);
		}
	}

	getSharedUniformBuffer(name) {
		const resource = this.#sharedResources.uniformBuffers.get(name);
		if (resource) {
			resource.refCount++;
			return resource.buffer;
		}
		return null;
	}

	releaseSharedUniformBuffer(name) {
		const resource = this.#sharedResources.uniformBuffers.get(name);
		if (resource) {
			resource.refCount--;

			if (resource.refCount <= 0) {
				if (resource.buffer && !resource.buffer._isDestroyed) {
					resource.buffer.destroy();
				}
				this.#sharedResources.uniformBuffers.delete(name);
				console.log(`Released shared uniform buffer: ${name}`);
			}
		}
	}

	// Legacy getters for backward compatibility
	getSharedPipeline(markType) {
		return this.#sharedResources.pipelines.get(markType)?.pipeline;
	}

	getSharedShaderModule(markType) {
		return this.#sharedResources.shaderModules.get(markType)?.module;
	}

	// Getters
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

	// ===== INITIALIZATION METHODS =====

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

		// this.#canTimestamp = adapter.features.has('timestamp-query');
		this.#canTimestamp = false;

		this.#device = await adapter.requestDevice({
			requiredFeatures: [...(this.#canTimestamp ? ['timestamp-query'] : [])]
		});

		this.#presentationFormat = navigator.gpu.getPreferredCanvasFormat();

		// Timestamp querying resources
		if (!this.#canTimestamp) {
			console.warn('Timestamp queries not supported');
			return;
		}

		this.#querySet = this.device.createQuerySet({
			type: 'timestamp',
			count: 2
		});

		this.#resolveBuffer = this.device.createBuffer({
			size: this.#querySet.count * 8,
			usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
		});

		this.#resultBuffer = this.device.createBuffer({
			size: this.#resolveBuffer.size,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
	}

	async #createSharedResources() {
		const device = this.#device;

		const dprBuffer = device.createBuffer({
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

		const devicePixelRatio = window.devicePixelRatio || 1;
		const dprResource = this.#sharedResources.uniformBuffers.get('devicePixelRatio');

		if (dprResource?.buffer) {
			this.#device.queue.writeBuffer(dprResource.buffer, 0, new Float32Array([devicePixelRatio]));
		}
	}

	// ===== COMPREHENSIVE CLEANUP =====

	destroy() {
		console.log('Destroying GPUCoordinator with comprehensive cleanup');

		// Stop animation loop
		if (this.#animationRafId !== null) {
			cancelAnimationFrame(this.#animationRafId);
			this.#animationRafId = null;
		}

		this.#animationActive = false;
		this.#animatedScales.clear();

		// Cleanup MSAA textures
		for (const msaa of this.#msaaCache.values()) {
			if (msaa.texture && !msaa.texture.destroyed) {
				msaa.texture.destroy();
			}
		}
		this.#msaaCache.clear();

		// Cleanup shared resources with reference counting
		for (const [name, resource] of this.#sharedResources.uniformBuffers) {
			if (resource.buffer && !resource.buffer._isDestroyed) {
				resource.buffer.destroy();
			}
		}
		this.#sharedResources.uniformBuffers.clear();
		this.#sharedResources.pipelines.clear();
		this.#sharedResources.shaderModules.clear();
		this.#sharedResources.bindGroupLayouts.clear();

		// Cleanup bind group layouts
		// this.#scaleBindGroupLayouts.clear();
		this.#globalScaleLayout = null;

		// Cleanup charts and layers
		this.#registeredCharts.clear();
		this.#dirtyChartIDs.clear();

		// Cleanup performance tracking
		this.#frameHistory = [];
		this.#frameTimings = [];

		// Cleanup race condition protection
		this.#creatingPipelines.clear();

		// Clean up layouts
		this.#dataLayouts.clear();
		this.#frameLayout = null;

		this.#pendingScaleMappings.clear();

		// Destroy device last
		if (this.#device) {
			this.#device.destroy();
			this.#device = null;
		}

		this.#initialized = false;
		console.log('GPUCoordinator destruction complete');
	}
}

// Context functions remain unchanged...
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

// MinimalPerfLogger class remains unchanged...
class MinimalPerfLogger {
	constructor(maxSamples = 10000) {
		this.timestamps = new Float64Array(maxSamples);
		this.frameDeltas = new Float32Array(maxSamples);
		this.cpuTimes = new Float32Array(maxSamples);
		this.scaleAnimationTimes = new Float32Array(maxSamples);
		this.renderTimes = new Float32Array(maxSamples);
		this.schedulingLags = new Float32Array(maxSamples);
		this.renderDomains = new Float32Array(maxSamples);

		this.index = 0;
		this.maxSamples = maxSamples;
		this.startTime = performance.now();
		this.lastFrameTime = 0;
		this.bufferFullWarned = false;
	}

	log(
		loopStart,
		loopEnd,
		scaleAnimationTime = 0,
		renderTime = 0,
		schedulingLag = 0,
		renderDomain = []
	) {
		if (this.index >= this.maxSamples) {
			if (!this.bufferFullWarned) {
				console.warn(
					`PerformanceLogger: Buffer full (${this.maxSamples} samples). Data collection stopped.`
				);
				this.bufferFullWarned = true;
			}
			return;
		}

		const i = this.index++;
		this.timestamps[i] = loopStart - this.startTime;
		this.cpuTimes[i] = loopEnd - loopStart;
		this.scaleAnimationTimes[i] = scaleAnimationTime;
		this.renderTimes[i] = renderTime;
		this.schedulingLags[i] = schedulingLag;
		this.renderDomains[i] = renderDomain;

		if (this.lastFrameTime > 0) {
			this.frameDeltas[i] = loopStart - this.lastFrameTime;
		}

		this.lastFrameTime = loopStart;
	}

	export() {
		const activeLength = Math.min(this.index, this.maxSamples);

		const rows = [];
		for (let i = 0; i < activeLength; i++) {
			rows.push({
				timestamp: this.timestamps[i],
				frameDelta: this.frameDeltas[i],
				cpuTime: this.cpuTimes[i],
				scaleAnimationTime: this.scaleAnimationTimes[i],
				renderTime: this.renderTimes[i],
				schedulingLag: this.schedulingLags[i],
				renderDomain: this.renderDomains[i]
			});
		}

		return rows;
	}

	downloadJSON() {
		const blob = new Blob([JSON.stringify(this.export())], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `perf-${Date.now()}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	reset() {
		this.index = 0;
		this.startTime = performance.now();
		this.lastFrameTime = 0;
	}
}
