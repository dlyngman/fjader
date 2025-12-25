// BaseGPURenderer.svelte.js - Simplified for Pipeline Factory Pattern
// Scale management completely removed - coordinator handles all scale concerns

export class BaseGPURenderer {
	// Core properties
	#markType;
	#webGPUContext;
	#gpuCoordinator;
	#chartContext;

	// Resource tracking
	#ownedResources = {
		buffers: [],
		layerControl: null
	};

	// State management
	#resourcesCreated = $state(false);
	#initializationError = $state(null);
	#instanceCount = $state(0);

	#device = null;
	#pipeline = $state(null); // Provided by coordinator factory

	#pipelineRequestKey = null;
	#isDestroyed = false;

	#perDataBindGroup = $state(null); // @group(1): mark data buffers
	#perDataLayout = null;
	#dataBindingConfig = null;

	#zIndex;
	#xScaleType;
	#yScaleType;

	constructor(markType, webGPUContext, gpuCoordinator, chartContext, options = {}) {
		this.#markType = markType;
		this.#webGPUContext = webGPUContext;
		this.#gpuCoordinator = gpuCoordinator;
		this.#chartContext = chartContext;
		this.#zIndex = options.zIndex || 0;

		// Store scale types for coordinator pipeline factory
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

    // Release existing pipeline if re-initializing
		if (this.#resourcesCreated) {
			this.#releasePipelineResources();
			this.#resourcesCreated = false;
		}

		try {
			const { dataBindingConfig, markShaderCode, vertexBufferLayout } = config;

			if (!dataBindingConfig) {
				throw new Error(`${this.#markType} renderer requires dataBindingConfig`);
			}

			console.log(`Initializing ${this.#markType} renderer with pipeline factory pattern`);

			this.#device = this.#webGPUContext.getDevice();
			if (!this.#device) {
				throw new Error('No WebGPU device available from context');
			}

			this.#dataBindingConfig = dataBindingConfig;

			this.#pipelineRequestKey = this.#markType;

			// Get pipeline from coordinator factory (coordinator handles shader generation)
			await this.#getPipelineFromCoordinator(markShaderCode, vertexBufferLayout);

			if (this.#isDestroyed) {
				console.warn(`${this.#markType}: Initialized after destroy. Releasing immediately.`);
				this.#releasePipelineResources();
				return; // Stop. Do not set #resourcesCreated to true.
			}

			this.#resourcesCreated = true;
			console.log(`${this.#markType} renderer initialized.`);
		} catch (error) {
			if (!this.#isDestroyed) {
				console.error(`${this.#markType} initialization failed:`, error);
				this.#initializationError = error.message;
				throw error;
			}
		}
	}

	// ===== PIPELINE FACTORY INTEGRATION =====

	async #getPipelineFromCoordinator(markShaderCode, vertexBufferLayout) {
		const scaleTypes = {
			x: this.#chartContext.scaleTypes?.x || this.#xScaleType,
			y: this.#chartContext.scaleTypes?.y || this.#yScaleType
		};

		// Use coordinator's pipeline factory
		// Get both pipeline and layouts from coordinator
		const result = await this.#gpuCoordinator.createPipelineForMarkType(
			this.#pipelineRequestKey, // this.#markType,
			scaleTypes,
			markShaderCode,
			vertexBufferLayout,
			this.#dataBindingConfig // Pass this so coordinator can create stable layouts
		);

		console.log('Pipeline factory result:', {
			hasPipeline: !!result.pipeline,
			hasFrameLayout: !!result.frameLayout,
			hasDataLayout: !!result.dataLayout
		});

		this.#pipeline = result.pipeline;
		this.#perDataLayout = result.dataLayout; // From coordinator

		if (!this.#pipeline) {
			throw new Error(`Coordinator failed to provide pipeline for ${this.#markType}`);
		}

		console.log(`Pipeline received from coordinator for ${this.#markType}`);
	}

	createDataBindGroup(dataBindings) {
		if (!this.#device || !this.#perDataLayout) {
			console.warn(
				`Cannot create per-data bind group for ${this.#markType} - missing device or layout`
			);
			return;
		}

		if (!Array.isArray(dataBindings) || dataBindings.length === 0) {
			console.warn(
				`Cannot create per-data bind group for ${this.#markType} - invalid dataBindings`
			);
			return;
		}

		try {
			// Validate that all required bindings are provided
			const expectedBindings = this.#dataBindingConfig.map((config) => config.binding);
			const providedBindings = dataBindings.map((binding) => binding.binding);

			for (const expectedBinding of expectedBindings) {
				if (!providedBindings.includes(expectedBinding)) {
					throw new Error(`Missing data binding ${expectedBinding} for ${this.#markType}`);
				}
			}

			this.#perDataBindGroup = this.#device.createBindGroup({
				label: `${this.#markType}-per-data-bind-group`,
				layout: this.#perDataLayout,
				entries: dataBindings
			});

			console.debug(
				`Per-data bind group (@group(1)) created for ${this.#markType} with ${dataBindings.length} bindings`
			);
		} catch (error) {
			console.error(`Failed to create per-data bind group for ${this.#markType}:`, error);
			this.#initializationError = error.message;
			throw error;
		}
	}

	// ===== BUFFER MANAGEMENT =====

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
			// const len = data.length;
			// const result = new Float32Array(len);
			// for (let i = 0; i < len; i++) {
			// 	const d = data[i];
			// 	result[i] = d ?? 0;
			// }
			// return result;

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
	#releasePipelineResources() {
		// Only release if we actually have a key (meaning we successfully requested one)
		if (this.#pipelineRequestKey && this.#gpuCoordinator) {
			// Release the Pipeline (refCount--)
			this.#gpuCoordinator.releaseSharedPipeline(this.#pipelineRequestKey);

			// Release the Shader (refCount--)
			// Note: createPipelineForMarkType in coordinator implicitly creates a shader
			// using the same markType key. We must release it too.
			this.#gpuCoordinator.releaseSharedShader(this.#pipelineRequestKey);

			// Clear state
			this.#pipelineRequestKey = null;
			this.#pipeline = null;
		}
	}

	destroy() {
		this.#isDestroyed = true;
		console.log(`Cleaning up ${this.#markType} renderer resources`);

		try {
			// Clean up owned buffers
			this.#ownedResources.buffers.forEach((buffer) => {
				if (buffer && !buffer.destroyed) {
					buffer.destroy();
				}
			});
			this.#ownedResources.buffers = [];

			// Clean up layer registration
			if (this.#ownedResources.layerControl) {
				this.#ownedResources.layerControl.remove();
			}

			//
			this.#releasePipelineResources();

			console.log(`${this.#markType} renderer cleanup complete`);
		} catch (error) {
			console.error(`Error during ${this.#markType} renderer cleanup:`, error);
		}
	}
}
