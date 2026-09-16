import type { GPUCoordinator, DataBindingEntry, LayerRegistrationResult } from '$lib/gpu';
import type { ChartContext, WebGPUCanvasContext } from '$lib/types';
import { MorphedChannels } from '$lib/gpu/MorphedChannels';

interface RendererOptions {
	zIndex?: number;
	xScaleType?: string;
	yScaleType?: string;
}

interface InitConfig {
	dataBindingConfig: DataBindingEntry[];
	markShaderCode: string;
	vertexBufferLayout: GPUVertexBufferLayout[];
	rendererDefinition: object;
}

/** Warned once per page, not per mark. */
let warnedMorphUnsupported = false;

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
	#xScaleType: string;
	#yScaleType: string;

	// Facet support: one renderer registered across multiple facet cell charts
	#facetLayerControls: { chartId: string; control: LayerRegistrationResult }[] = [];
	#facetChartIds: string[] = [];

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
				throw error;
			}
		}
	}

	// ===== HIGH-LEVEL DATA API =====

	/**
	 * Write data to a specific shader binding.
	 * Handles buffer creation, smart resizing, and bind group invalidation.
	 */
	writeAttribute(binding: number, data: AllowSharedBufferSource): void {
		if (!this.#device || !data) return;

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
		channels: readonly (readonly [number, AllowSharedBufferSource])[]
	): void {
		if (!this.#device) return;

		if (!MorphedChannels.supported) {
			if (!warnedMorphUnsupported) {
				warnedMorphUnsupported = true;
				console.warn(
					'[DivePlot] WGSL immediates are not available, so values will not animate between updates.'
				);
			}
			for (const [binding, data] of channels) this.writeAttribute(binding, data);
			return;
		}

		this.#morphed ??= new MorphedChannels({
			device: this.#device,
			host: this.#gpuCoordinator,
			label: this.#rendererId,
			scaleFor: (axis) =>
				(this.#chartContext as unknown as Record<string, unknown>)[`${axis}ScaleState`],
			affectedCharts: () =>
				this.#facetChartIds.length > 0 ? this.#facetChartIds : [this.#chartContext.chartId]
		});

		// A binding that was static until now gives up its buffer; the morphed
		// channel's resolved buffer takes its place in the bind group.
		let rebind = false;
		for (const [binding] of channels) {
			const stale = this.#ownedResources.buffers.get(binding);
			if (stale) {
				stale.destroy();
				this.#ownedResources.buffers.delete(binding);
				rebind = true;
			}
		}

		if (this.#morphed.write(bandAxis, bandIds, channels) || rebind) {
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
				size: 48, // Must fit the largest uniform struct (e.g. Rects MarkConstants = 48 bytes)
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				label: `${this.#markType}-dummy`
			});
		}
		return this.#dummyBuffer;
	}

	updateInstanceCount(count: number): void {
		this.#instanceCount = count;
		this.invalidateLayer();
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
			zIndex: this.#zIndex
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
				zIndex: this.#zIndex
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
