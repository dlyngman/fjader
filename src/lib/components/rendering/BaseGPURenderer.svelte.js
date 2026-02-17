export class BaseGPURenderer {
	// Core properties
	#markType;
	#webGPUContext;
	#gpuCoordinator;
	#chartContext;

	// Identity & Async Control
	#rendererId;
	#initGeneration = 0;
	#isDestroyed = false;

	// Resource tracking (Exclusive resources only)
	#ownedResources = {
		buffers: new Map(), // bindingIndex -> GPUBuffer
		layerControl: null
	};

	// State management
	#resourcesCreated = $state(false);
	#initializationError = $state(null);
	#instanceCount = $state(0);

	// GPU Objects
	#device = null;
	#pipeline = null;
	#perDataBindGroup = $state(null);
	#perDataLayout = null;
	#dataBindingConfig = null; // Store config for rebuilding bind groups

	#dummyBuffer = null;
	#bindGroupUpdateScheduled = false;

	#zIndex;
	#xScaleType;
	#yScaleType;

	// Facet support: one renderer registered across multiple facet cell charts
	#facetLayerControls = []; // { chartId, control }[]
	#facetChartIds = [];

	constructor(markType, webGPUContext, gpuCoordinator, chartContext, options = {}) {
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
	get resourcesCreated() {
		return this.#resourcesCreated;
	}
	get instanceCount() {
		return this.#instanceCount;
	}
	get pipeline() {
		return this.#pipeline;
	}
	get perDataBindGroup() {
		return this.#perDataBindGroup;
	}

	async initialize(config) {
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
				this.#initializationError = error.message;
				throw error;
			}
		}
	}

	// ===== HIGH-LEVEL DATA API =====

	/**
	 * Write data to a specific shader binding.
	 * Handles buffer creation, smart resizing, and bind group invalidation.
	 *
	 * @param {number} binding - Shader binding index (use constants!)
	 * @param {ArrayBufferView} data - Float32Array, etc.
	 */
	writeAttribute(binding, data) {
		if (!this.#device || !data) return;

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
		this.#device.queue.writeBuffer(buffer, 0, data);

		// 3. Trigger Render
		if (!this.#bindGroupUpdateScheduled) {
			this.invalidateLayer();
		}
	}

	/**
	 * Write data to a uniform binding.
	 * @param {number} binding
	 * @param {ArrayBufferView} data
	 */
	writeUniform(binding, data) {
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

		this.#device.queue.writeBuffer(buffer, 0, data);

		if (!this.#bindGroupUpdateScheduled) {
			this.invalidateLayer();
		}
	}

	// ===== INTERNAL HELPERS =====

	#scheduleBindGroupUpdate() {
		if (this.#bindGroupUpdateScheduled) return;
		this.#bindGroupUpdateScheduled = true;

		queueMicrotask(() => {
			this.#rebuildBindGroup();
			this.#bindGroupUpdateScheduled = false;
			// Invalidate layer to ensure a redraw happens with new bindings
			this.invalidateLayer();
		});
	}

	#rebuildBindGroup() {
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

	get #sharedDummyBuffer() {
		if (!this.#dummyBuffer) {
			this.#dummyBuffer = this.#device.createBuffer({
				size: 16, // Minimum size
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				label: `${this.#markType}-dummy`
			});
		}
		return this.#dummyBuffer;
	}

	updateInstanceCount(count) {
		this.#instanceCount = count;
		this.invalidateLayer();
	}

	registerLayer(drawFunction) {
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
	registerFacetLayers(chartIds, drawFunction) {
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

	invalidateLayer() {
		if (!this.#gpuCoordinator) return;

		if (this.#facetChartIds.length > 0) {
			for (const chartId of this.#facetChartIds) {
				this.#gpuCoordinator.invalidateChart(chartId);
			}
		} else if (this.#chartContext?.chartId) {
			this.#gpuCoordinator.invalidateChart(this.#chartContext.chartId);
		}
	}

	destroy() {
		this.#isDestroyed = true;
		this.#initGeneration++;

		// Clean up buffers
		for (const buffer of this.#ownedResources.buffers.values()) {
			buffer.destroy();
		}
		this.#ownedResources.buffers.clear();

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

	// Legacy helper kept for compatibility if needed, but unused in new flow
	// createDataBindGroup(bindings) { /* ... */ }
	// createOrUpdateBuffer(buf, data) { /* ... */ }
}
