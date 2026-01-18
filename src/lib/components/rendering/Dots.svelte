<script>
	import { getContext, onMount, onDestroy, untrack } from 'svelte';
	import { BaseGPURenderer } from './BaseGPURenderer.svelte.js';
	import { getGPUContext } from '$lib/gpu';

	/**
	 * Declarative renderer definition for Dots.
	 */
	const dotRendererDefinition = {
		x: {
			concept: 'position',
			channels: ['x']
		},
		y: {
			concept: 'position',
			channels: ['y']
		},
		placeholders: {
			x: '{{X_AXIS_LOGIC}}',
			y: '{{Y_AXIS_LOGIC}}'
		}
	};

	let {
		xData, // Float32Array - processed X positions
		yData, // Float32Array - processed Y positions
		colorValueData, // Float32Array - raw color values (indices or continuous)
		radiusData, // Float32Array - radius values
		alphaData, // Float32Array - alpha values
		dataVersion, // number - for triggering updates
		zIndex = 0,
		// NEW: Color configuration
		colorMode = 0, // 0 = constant, 1 = scale
		colorScaleIndex = 0, // Index into colorConfigs
		constantColor = [0.13, 0.55, 0.13, 1.0] // Default green
	} = $props();

	const chartContext = getContext('chart');
	const webGPUContext = getContext('webgpu-canvas');
	const gpuCoordinator = getGPUContext();

	// Renderer and buffer state
	let renderer = $state(null);
	let initializationError = $state(null);

	// GPU buffers
	let xBuffer, yBuffer, radiusBuffer, alphaBuffer, colorValueBuffer;
	let markConstantsBuffer;

	// Geometry buffer (locally owned)
	let quadGeometryBuffer;
	// let dummyColorBuffer;

	const quadVertexCount = 6;

	const dotsShaderCode = `
  // MarkConstants uniform for per-mark configuration
  struct MarkConstants {
    colorMode: u32,           // 0 = constant, 1 = scale
    colorScaleIndex: u32,     // Index into colorConfigs
    _pad0: u32,
    _pad1: u32,
    constantColor: vec4<f32>, // Used when colorMode = 0
  };
  @group(1) @binding(5) var<uniform> markConstants: MarkConstants;

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) colorValue: f32,   // Raw value for scale lookup
    @location(1) uv: vec2<f32>,
    @location(2) radius: f32,
    @location(3) alpha: f32,
  };

  // Data storage buffers in @group(1)
  @group(1) @binding(0) var<storage, read> xValues: array<f32>;
  @group(1) @binding(1) var<storage, read> yValues: array<f32>;
  @group(1) @binding(2) var<storage, read> radiusValues: array<f32>;
  @group(1) @binding(3) var<storage, read> alphaValues: array<f32>;
  @group(1) @binding(4) var<storage, read> colorValues: array<f32>;
  
  @vertex
  fn vertexMain(
    @location(0) quadPosition: vec2<f32>,
    @builtin(instance_index) instanceIdx: u32,
  ) -> VertexOutput {
    let x = xValues[instanceIdx];
    let y = yValues[instanceIdx];
    let radius = radiusValues[instanceIdx];
    let alpha = alphaValues[instanceIdx];
    let colorValue = colorValues[instanceIdx];

    // X axis scaling
    {{X_AXIS_LOGIC}}
    
    // Y axis scaling
    {{Y_AXIS_LOGIC}}
    
    let displayRadius = radius * frameUniforms.devicePixelRatio;
    let radiusWithPadding = displayRadius * 1.2;
    let worldPos = vec2<f32>(scaledX, scaledY) + quadPosition * radiusWithPadding;
    let normalizedPos = (worldPos / frameUniforms.resolution) * 2.0 - 1.0;
    
    var output: VertexOutput;
    output.position = vec4<f32>(normalizedPos.x, -normalizedPos.y, 0.0, 1.0);
    output.colorValue = colorValue;
    output.uv = quadPosition;
    output.radius = displayRadius;
    output.alpha = alpha;
    return output;
  }

  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // Get color based on mode
    var baseColor: vec4<f32>;
    if (markConstants.colorMode == 0u) {
      // Constant color
      baseColor = markConstants.constantColor;
    } else {
      // Scale-based color lookup
      baseColor = getColorFromScale(
        markConstants.colorScaleIndex,
        input.colorValue,
        frameUniforms.nullColor
      );
    }

    // SDF circle with anti-aliasing
    let dist = length(input.uv);
    let sdf = dist - 1.0;
    let pixelSize = frameUniforms.devicePixelRatio / (input.radius * 2.0);
    let alpha = 1.0 - smoothstep(-pixelSize, pixelSize, sdf);
    let finalAlpha = baseColor.a * alpha * input.alpha;
    
    return vec4<f32>(baseColor.rgb, finalAlpha);
  }
`;

	// Vertex buffer layout
	const vertexBufferLayout = [
		{
			arrayStride: 2 * 4,
			attributes: [
				{
					shaderLocation: 0,
					offset: 0,
					format: 'float32x2'
				}
			]
		}
	];

	const dataBindingConfig = [
		{ binding: 0, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX }, // xValues
		{ binding: 1, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX }, // yValues
		{ binding: 2, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX }, // radiusValues
		{ binding: 3, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX }, // alphaValues
		{ binding: 4, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX }, // colorValues
		{ binding: 5, type: 'uniform', visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT } // markConstants
	];

	// Buffer update effects
	$effect.pre(() => {
		if (xData && renderer?.resourcesCreated) {
			xBuffer = renderer.createOrUpdateBuffer(xBuffer, xData);
		}
	});

	$effect.pre(() => {
		if (yData && renderer?.resourcesCreated) {
			yBuffer = renderer.createOrUpdateBuffer(yBuffer, yData);
		}
	});

	$effect.pre(() => {
		// Only create/update buffer if we have color data (field mode)
		// In constant mode, colorValueData is null and we skip this entirely
		// BaseGPURenderer will auto-fill the binding with a dummy buffer
		if (colorValueData && renderer?.resourcesCreated) {
			colorValueBuffer = renderer.createOrUpdateBuffer(colorValueBuffer, colorValueData);
		}
	});

	$effect.pre(() => {
		if (radiusData && renderer?.resourcesCreated) {
			radiusBuffer = renderer.createOrUpdateBuffer(radiusBuffer, radiusData);
		}
	});

	$effect.pre(() => {
		if (alphaData && renderer?.resourcesCreated) {
			alphaBuffer = renderer.createOrUpdateBuffer(alphaBuffer, alphaData);
		}
	});

	// MarkConstants buffer management
	$effect.pre(() => {
		if (renderer?.resourcesCreated) {
			updateMarkConstants();
		}
	});

	function updateMarkConstants() {
		const device = webGPUContext.getDevice();
		if (!device) return;

		// Create buffer if needed (32 bytes: 4 u32 + vec4 f32)
		if (!markConstantsBuffer) {
			markConstantsBuffer = device.createBuffer({
				size: 32,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				label: 'dots-mark-constants'
			});
		}

		// Write data using DataView for mixed types
		const buffer = new ArrayBuffer(32);
		const view = new DataView(buffer);
		const LE = true;

		view.setUint32(0, colorMode, LE);
		view.setUint32(4, colorScaleIndex, LE);
		view.setUint32(8, 0, LE); // _pad0
		view.setUint32(12, 0, LE); // _pad1
		view.setFloat32(16, constantColor[0], LE);
		view.setFloat32(20, constantColor[1], LE);
		view.setFloat32(24, constantColor[2], LE);
		view.setFloat32(28, constantColor[3], LE);

		device.queue.writeBuffer(markConstantsBuffer, 0, buffer);
	}

	let dataBindGroupReady = $derived(!!renderer?.perDataBindGroup);

	$effect.pre(() => {
		void renderer?.resourcesCreated;
		void dataBindGroupReady;

		// For color, check based on mode:
		// - Constant mode (colorMode === 0): always ready (no buffer needed)
		// - Field mode (colorMode === 1): need colorValueBuffer
		const isColorReady = colorMode === 0 || !!colorValueBuffer;

		if (
			xBuffer &&
			yBuffer &&
			radiusBuffer &&
			alphaBuffer &&
			isColorReady &&
			markConstantsBuffer &&
			renderer?.resourcesCreated &&
			!dataBindGroupReady
		) {
			untrack(() => {
				createDotsDataBindGroup();
			});
		}
	});

	// Data writing effects
	$effect.pre(() => {
		void dataBindGroupReady;
		if (xData && xBuffer && dataBindGroupReady) {
			untrack(() => {
				const device = webGPUContext.getDevice();
				device?.queue.writeBuffer(xBuffer, 0, xData);
			});
		}
	});

	$effect.pre(() => {
		void dataBindGroupReady;
		if (yData && yBuffer && dataBindGroupReady) {
			const device = webGPUContext.getDevice();
			device?.queue.writeBuffer(yBuffer, 0, yData);
		}
	});

	$effect.pre(() => {
		void dataBindGroupReady;
		if (radiusData && radiusBuffer && dataBindGroupReady) {
			const device = webGPUContext.getDevice();
			device?.queue.writeBuffer(radiusBuffer, 0, radiusData);
		}
	});

	$effect.pre(() => {
		console.log('writing color value buffer')
		void dataBindGroupReady;
		if (colorValueData && colorValueBuffer && dataBindGroupReady) {
			const device = webGPUContext.getDevice();
			device?.queue.writeBuffer(colorValueBuffer, 0, colorValueData);
		}
	});

	$effect.pre(() => {
		void dataBindGroupReady;
		if (alphaData && alphaBuffer && dataBindGroupReady) {
			const device = webGPUContext.getDevice();
			device?.queue.writeBuffer(alphaBuffer, 0, alphaData);
		}
	});

	$effect.pre(() => {
		void dataBindGroupReady;
		if (
			xData &&
			yData &&
			// colorValueData &&
			radiusData &&
			alphaData &&
			xBuffer &&
			yBuffer &&
			radiusBuffer &&
			alphaBuffer &&
			// colorValueBuffer &&
			dataBindGroupReady
		) {
			renderer.updateInstanceCount(xData.length);
			gpuCoordinator.invalidateChart(chartContext.chartId);
		}
	});

	function createQuadGeometry() {
		return new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]);
	}

	async function initializeDotsGeometry() {
		try {
			const device = webGPUContext.getDevice();
			if (!device) {
				throw new Error('No WebGPU device available for quad geometry');
			}

			const quadVertices = createQuadGeometry();

			quadGeometryBuffer = device.createBuffer({
				size: quadVertices.byteLength,
				usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
				label: 'dots-quad-geometry'
			});

			device.queue.writeBuffer(quadGeometryBuffer, 0, quadVertices);
		} catch (error) {
			console.error('❌ Failed to create quad geometry:', error);
			throw error;
		}
	}

	function createDotsDataBindGroup() {
		if (!xBuffer || !yBuffer || !radiusBuffer || !alphaBuffer || !markConstantsBuffer) {
			console.warn('Cannot create dots data bind group - missing required buffers');
			return;
		}

		// Pass only the bindings we have.
		// BaseGPURenderer will auto-fill missing bindings (like colorValues in constant mode)
		const dataBindings = [
			{ binding: 0, resource: { buffer: xBuffer } },
			{ binding: 1, resource: { buffer: yBuffer } },
			{ binding: 2, resource: { buffer: radiusBuffer } },
			{ binding: 3, resource: { buffer: alphaBuffer } },
			// Only include colorValueBuffer if it exists (field mode)
			...(colorValueBuffer ? [{ binding: 4, resource: { buffer: colorValueBuffer } }] : []),
			{ binding: 5, resource: { buffer: markConstantsBuffer } }
		];

		renderer.createDataBindGroup(dataBindings);
	}

	function drawDots(passEncoder) {
		try {
			if (!quadGeometryBuffer || renderer.instanceCount === 0) {
				return;
			}

			passEncoder.setVertexBuffer(0, quadGeometryBuffer);
			passEncoder.draw(quadVertexCount, renderer.instanceCount);
		} catch (error) {
			console.error('❌ Dots draw operation failed:', error);
			throw error;
		}
	}

	async function waitForWebGPU() {
		let attempts = 0;
		const maxAttempts = 100;

		while (!webGPUContext.isInitialized() && attempts < maxAttempts) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			attempts++;
		}

		if (!webGPUContext.isInitialized()) {
			throw new Error(`WebGPU context failed to initialize within ${maxAttempts * 50}ms`);
		}

		await initializeDots();
	}

	async function initializeDots() {
		try {
			if (!gpuCoordinator) {
				throw new Error('GPU Coordinator context missing.');
			}

			renderer = new BaseGPURenderer('dots', webGPUContext, gpuCoordinator, chartContext, {
				zIndex,
				xScaleType: chartContext.scaleTypes?.x || 'linear',
				yScaleType: chartContext.scaleTypes?.y || 'linear'
			});

			await renderer.initialize({
				markShaderCode: dotsShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition: dotRendererDefinition
			});

			await initializeDotsGeometry();

			// Initialize markConstants buffer
			updateMarkConstants();

			renderer.registerLayer(drawDots);

			console.log('✅ Dots component initialized');
		} catch (error) {
			console.error('❌ Dots component initialization failed:', error);
			initializationError = error.message;
			throw error;
		}
	}

	onMount(async () => {
		try {
			await waitForWebGPU();
		} catch (error) {
			console.error('❌ Dots component mount failed:', error);
			initializationError = error.message;
		}
	});

	onDestroy(() => {
		try {
			if (quadGeometryBuffer) {
				quadGeometryBuffer.destroy();
				quadGeometryBuffer = null;
			}

			if (markConstantsBuffer) {
				markConstantsBuffer.destroy();
				markConstantsBuffer = null;
			}


			if (renderer) {
				renderer.destroy();
				renderer = null;
			}
		} catch (error) {
			console.error('❌ Error during Dots component cleanup:', error);
		}
	});
</script>

{#if initializationError}
	<div class="dots-error">
		<p>Dots component failed to initialize:</p>
		<p class="error-message">{initializationError}</p>
	</div>
{/if}

<style>
	.dots-error {
		position: absolute;
		top: 10px;
		left: 10px;
		background-color: rgba(255, 240, 240, 0.9);
		border: 1px solid #ffcccb;
		border-radius: 4px;
		padding: 8px 12px;
		font-size: 12px;
		color: #d32f2f;
		z-index: 1000;
		max-width: 300px;
	}

	.error-message {
		font-family: monospace;
		background-color: rgba(255, 255, 255, 0.8);
		padding: 4px 6px;
		border-radius: 2px;
		margin-top: 4px;
		font-size: 11px;
	}
</style>
