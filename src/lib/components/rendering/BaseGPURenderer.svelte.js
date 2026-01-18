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
		buffers: [],
		layerControl: null
	};

	// State management (Reactive - drives UI)
	#resourcesCreated = $state(false);
	#initializationError = $state(null);
	#instanceCount = $state(0);

	// GPU Objects
	#device = null;
	#pipeline = null;
	#perDataBindGroup = $state(null);
	#perDataLayout = null;

	#dummyBuffer = null;

	#dataBindingConfig = null;
	#zIndex;
	#xScaleType;
	#yScaleType;

	constructor(markType, webGPUContext, gpuCoordinator, chartContext, options = {}) {
		this.#markType = markType;
		this.#webGPUContext = webGPUContext;
		this.#gpuCoordinator = gpuCoordinator;
		this.#chartContext = chartContext;

		// Unique ID for the Resource Registry
		this.#rendererId = `${markType}-${crypto.randomUUID()}`;

		this.#zIndex = options.zIndex || 0;
		this.#xScaleType = options.xScaleType || 'linear';
		this.#yScaleType = options.yScaleType || 'linear';
	}

	// ===== PUBLIC GETTERS =====

	get resourcesCreated() {
		return this.#resourcesCreated;
	}
	get initializationError() {
		return this.#initializationError;
	}
	get instanceCount() {
		return this.#instanceCount;
	}
	get pipeline() {
		return this.#pipeline;
	}
	get markType() {
		return this.#markType;
	}
	get perDataBindGroup() {
		return this.#perDataBindGroup;
	}

	// ===== INITIALIZATION =====

	async initialize(config) {
		if (this.#isDestroyed) return;

		// Async Race Protection: Increment generation
		// Any previous pending initialization will see mismatching generation and abort
		const currentGen = ++this.#initGeneration;

		// If re-initializing, clean up previous shared resources via Registry
		if (this.#resourcesCreated) {
			this.#gpuCoordinator.releaseRenderer(this.#rendererId);
			this.#resourcesCreated = false;
		}

		try {
			const { dataBindingConfig, markShaderCode, vertexBufferLayout, rendererDefinition } = config;

			if (!dataBindingConfig) {
				throw new Error(`${this.#markType} renderer requires dataBindingConfig`);
			}

			this.#device = this.#webGPUContext.getDevice();
			if (!this.#device) {
				throw new Error('No WebGPU device available from context');
			}

			this.#dataBindingConfig = dataBindingConfig;

			// ACQUIRE VIA REGISTRY
			// Coordinator handles keying, caching, and ref-counting
			// We just identify ourselves with rendererId
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
				rendererDefinition // Pass through to coordinator
			);

			// POST-AWAIT SAFETY CHECK
			// If destroyed or a newer init call happened while we were awaiting, abort and cleanup
			if (this.#isDestroyed || this.#initGeneration !== currentGen) {
				console.warn(`${this.#markType}: Stale initialization detected, discarding.`);
				this.#gpuCoordinator.releaseRenderer(this.#rendererId);
				return;
			}

			this.#pipeline = result.pipeline;
			this.#perDataLayout = result.dataLayout;
			this.#resourcesCreated = true;

			console.log(`${this.#markType} renderer initialized (${this.#rendererId})`);
		} catch (error) {
			if (!this.#isDestroyed && this.#initGeneration === currentGen) {
				console.error(`${this.#markType} initialization failed:`, error);
				this.#initializationError = error.message;
				throw error;
			}
		}
	}
	// ===== BIND GROUP CREATION =====

	
	/**
	 * Create the per-data bind group.
	 * Automatically fills missing bindings with a dummy buffer.
	 * This allows optional buffers (like colorValues in constant mode) to be omitted.
	 *
	 * @param {Array<{binding: number, resource: {buffer: GPUBuffer}}>} providedBindings
	 */
	createDataBindGroup(providedBindings) {
		if (!this.#device || !this.#perDataLayout || !this.#dataBindingConfig) {
			console.warn(
				`Cannot create per-data bind group for ${this.#markType} - missing device, layout, or config`
			);
			return;
		}

		try {
			// Create a map for quick lookup of provided bindings
			const bindingMap = new Map(providedBindings.map((entry) => [entry.binding, entry.resource]));

			// Build final entries based on config, auto-filling missing bindings
			const finalEntries = this.#dataBindingConfig.map((config) => {
				const suppliedResource = bindingMap.get(config.binding);

				if (suppliedResource) {
					// Component provided this binding → use it
					return { binding: config.binding, resource: suppliedResource };
				}

				// Component didn't provide this binding → use dummy buffer
				// This is safe when the shader conditionally skips reading (e.g., colorMode == 0)
				console.debug(
					`[${this.#markType}] Binding ${config.binding} not provided, using dummy buffer`
				);

				return {
					binding: config.binding,
					resource: { buffer: this.#sharedDummyBuffer }
				};
			});

			this.#perDataBindGroup = this.#device.createBindGroup({
				label: `${this.#markType}-per-data-bind-group`,
				layout: this.#perDataLayout,
				entries: finalEntries
			});

			console.debug(
				`Per-data bind group (@group(1)) created for ${this.#markType} with ${finalEntries.length} bindings`
			);
		} catch (error) {
			console.error(`Failed to create per-data bind group for ${this.#markType}:`, error);
			this.#initializationError = error.message;
			throw error;
		}
	}

	/**
	 * Lazy-loaded dummy buffer for satisfying empty bindings.
	 * Used when a binding is optional (e.g., colorValues in constant color mode).
	 * @private
	 */
	get #sharedDummyBuffer() {
		if (!this.#dummyBuffer) {
			this.#dummyBuffer = this.#device.createBuffer({
				size: 4, // Minimum size, 4-byte aligned
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				label: `${this.#markType}-dummy-fallback`
			});
		}
		return this.#dummyBuffer;
	}

	// ===== BUFFER MANAGEMENT (Exclusive Resources) =====

	createOrUpdateBuffer(
		existingBuffer,
		data,
		usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
	) {
		if (!this.#device) {
			throw new Error('No WebGPU device available');
		}

		const requiredSize = data.byteLength;

		// Smart buffer resizing to prevent thrashing
		if (!existingBuffer || existingBuffer.size < requiredSize) {
			if (existingBuffer) {
				const index = this.#ownedResources.buffers.indexOf(existingBuffer);
				if (index !== -1) {
					this.#ownedResources.buffers.splice(index, 1);
				}
				existingBuffer.destroy();
			}

			// Smart sizing with headroom
			const MEMORY_BLOCK_SIZE = 256;
			const desiredSize = Math.ceil(requiredSize * 1.5);
			const roundedUpSize = Math.ceil(desiredSize / MEMORY_BLOCK_SIZE) * MEMORY_BLOCK_SIZE;
			let bufferSize = Math.max(requiredSize, roundedUpSize);
			bufferSize = (bufferSize + 3) & ~3; // 4-byte alignment

			const newBuffer = this.#device.createBuffer({
				size: bufferSize,
				usage,
				label: `${this.#markType}-data-buffer-${this.#ownedResources.buffers.length}`
			});

			this.#ownedResources.buffers.push(newBuffer);
			console.debug(
				`Created ${this.#markType} buffer of size ${bufferSize} bytes (required: ${requiredSize})`
			);
			return newBuffer;
		}

		return existingBuffer;
	}

	updateInstanceCount(count) {
		this.#instanceCount = count;
		this.invalidateLayer();
	}

	registerLayer(drawFunction) {
		try {
			const chartId = this.#chartContext.chartId;

			const layerConfig = {
				draw: drawFunction,
				markType: this.#markType,
				renderer: this,
				componentId: `${this.#markType}-${crypto.randomUUID().slice(0, 6)}`
			};

			this.#ownedResources.layerControl = this.#gpuCoordinator.registerLayer(chartId, layerConfig);

			console.log(`${this.#markType} layer registered with coordinator for chart ${chartId}`);
			return this.#ownedResources.layerControl;
		} catch (error) {
			console.error(`${this.#markType} layer registration failed:`, error);
			this.#initializationError = error.message;
			throw error;
		}
	}

	invalidateLayer() {
		if (this.#gpuCoordinator && this.#chartContext?.chartId) {
			this.#gpuCoordinator.invalidateChart(this.#chartContext.chartId);
		}
	}

	// ===== DATA PROCESSING HELPERS =====

	processDataForAxis(data, axis) {
		const scaleType = axis === 'x' ? this.#xScaleType : this.#yScaleType;
		const scaleState =
			axis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;

		switch (scaleType) {
			case 'linear':
			case 'identity':
				return new Float32Array(data.map((d) => d ?? 0));

			case 'band':
			case 'point':
				return scaleState.processDataForGPU(data, this.#markType);

			case 'log':
				return new Float32Array(data.map((d) => Math.log(Math.max(d || 1, 1))));

			case 'time':
				return new Float32Array(data.map((d) => (d instanceof Date ? d.getTime() : d || 0)));

			default:
				console.warn(`Unknown scale type: ${scaleType}, treating as linear`);
				return new Float32Array(data.map((d) => d ?? 0));
		}
	}

	// ===== UTILITY METHODS =====

	parseColor(color) {
		try {
			if (typeof color === 'string' && color.startsWith('#')) {
				const r = parseInt(color.slice(1, 3), 16) / 255;
				const g = parseInt(color.slice(3, 5), 16) / 255;
				const b = parseInt(color.slice(5, 7), 16) / 255;
				return [r, g, b, 1.0];
			}
			console.warn(`Unrecognized color format: ${color}, using default blue`);
			return [0.0, 0.0, 1.0, 1.0];
		} catch (error) {
			console.error(`Color parsing failed for ${this.#markType}:`, error);
			return [0.0, 0.0, 1.0, 1.0];
		}
	}

	// ===== CLEANUP =====

	destroy() {
		this.#isDestroyed = true;
		// Bump generation so any pending init aborts
		this.#initGeneration++;

		console.log(`Cleaning up ${this.#markType} renderer (${this.#rendererId})`);

		try {
			// 1. Clean up EXCLUSIVE resources (buffers owned only by this renderer)
			this.#ownedResources.buffers.forEach((buffer) => {
				if (buffer) buffer.destroy();
			});
			this.#ownedResources.buffers = [];

			// 2. Clean up dummy buffer
			if (this.#dummyBuffer) {
				this.#dummyBuffer.destroy();
				this.#dummyBuffer = null;
			}

			// 3. Clean up layer registration
			if (this.#ownedResources.layerControl) {
				this.#ownedResources.layerControl.remove();
				this.#ownedResources.layerControl = null;
			}

			// 4. Clean up SHARED resources via Registry
			if (this.#gpuCoordinator) {
				this.#gpuCoordinator.releaseRenderer(this.#rendererId);
			}

			// Clear references
			this.#pipeline = null;
			this.#perDataBindGroup = null;
			this.#perDataLayout = null;
			this.#device = null;

			console.log(`${this.#markType} renderer cleanup complete`);
		} catch (error) {
			console.error(`Error during ${this.#markType} renderer cleanup:`, error);
		}
	}
}
