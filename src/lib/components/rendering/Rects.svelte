<script>
	import { getContext, onMount, onDestroy, untrack } from 'svelte';
	import { BaseGPURenderer } from './BaseGPURenderer.svelte.js';
	import { getGPUContext } from '$lib/gpu';

	/**
	 * Declarative renderer definition for Rects.
	 * Describes available data channels and the semantic concepts they represent.
	 * The ScaleTemplateSystem uses this to generate appropriate WGSL code.
	 */
	const rectRendererDefinition = {
		x: {
			concept: 'extent',
			channels: ['x0', 'x1']
		},
		y: {
			concept: 'extent',
			channels: ['y0', 'y1']
		},
		placeholders: {
			x: '{{X_AXIS_LOGIC}}',
			y: '{{Y_AXIS_LOGIC}}'
		}
	};

	let {
		x0Data, // Float32Array - left edges
		x1Data, // Float32Array - right edges
		y0Data, // Float32Array - bottom edges
		y1Data, // Float32Array - top edges
		colorValueData, // Float32Array - raw color values (indices or continuous), null for constant mode
		alphaData, // Float32Array - alpha values
		dataVersion, // number - for triggering updates
		zIndex = 0,
		// Color configuration
		colorMode = 0, // 0 = constant, 1 = scale
		colorScaleIndex = 0, // Index into colorConfigs
		constantColor = [0.2, 0.4, 0.8, 1.0] // Default blue
	} = $props();

	const chartContext = getContext('chart');
	const webGPUContext = getContext('webgpu-canvas');
	const gpuCoordinator = getGPUContext();

	// Renderer and buffer state
	let renderer = $state(null);
	let initializationError = $state(null);

	// GPU buffers (tracked in renderer.#ownedResources)
	let x0Buffer, x1Buffer, y0Buffer, y1Buffer, colorValueBuffer, alphaBuffer;
	let markConstantsBuffer;

	// Geometry buffer (locally owned - NOT tracked by renderer)
	let rectGeometryBuffer;

	const rectVertexCount = 6;

	const rectsShaderCode = `
  // MarkConstants uniform for per-mark configuration
  struct MarkConstants {
    colorMode: u32,           // 0 = constant, 1 = scale
    colorScaleIndex: u32,     // Index into colorConfigs
    _pad0: u32,
    _pad1: u32,
    constantColor: vec4<f32>, // Used when colorMode = 0
  };
  @group(1) @binding(6) var<uniform> markConstants: MarkConstants;

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) colorValue: f32,   // Raw value for scale lookup
    @location(1) alpha: f32,
  };

  @group(1) @binding(0) var<storage, read> x0Values: array<f32>;
  @group(1) @binding(1) var<storage, read> x1Values: array<f32>;
  @group(1) @binding(2) var<storage, read> y0Values: array<f32>;
  @group(1) @binding(3) var<storage, read> y1Values: array<f32>;
  @group(1) @binding(4) var<storage, read> colorValues: array<f32>;
  @group(1) @binding(5) var<storage, read> alphaValues: array<f32>;

  @vertex
  fn vertexMain(
    @location(0) rectCorner: vec2<f32>,
    @builtin(instance_index) instanceIdx: u32,
  ) -> VertexOutput {
    let x0 = x0Values[instanceIdx];
    let x1 = x1Values[instanceIdx];
    let y0 = y0Values[instanceIdx];
    let y1 = y1Values[instanceIdx];
    let alpha = alphaValues[instanceIdx];
    let colorValue = colorValues[instanceIdx];

    // X axis scaling (generated based on scale type)
    {{X_AXIS_LOGIC}}

    // Y axis scaling (generated based on scale type)
    {{Y_AXIS_LOGIC}}

    // Interpolate rectangle corners using the computed scaled values
    let finalX = mix(scaledX0, scaledX1, rectCorner.x);
    let finalY = mix(scaledY0, scaledY1, rectCorner.y);

    // Convert to normalized device coordinates
    let worldPos = vec2<f32>(finalX, finalY);
    let normalizedPos = (worldPos / frameUniforms.resolution) * 2.0 - 1.0;

    var output: VertexOutput;
    output.position = vec4<f32>(normalizedPos.x, -normalizedPos.y, 0.0, 1.0);
    output.colorValue = colorValue;
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

    return vec4<f32>(baseColor.rgb, baseColor.a * input.alpha);
  }
`;

	// 	const rectsShaderCode = `
	//   struct VertexOutput {
	//     @builtin(position) position: vec4<f32>,
	//     @location(0) color: vec4<f32>,
	//   };

	//   @group(1) @binding(0) var<storage, read> x0Values: array<f32>;
	//   @group(1) @binding(1) var<storage, read> x1Values: array<f32>;
	//   @group(1) @binding(2) var<storage, read> y0Values: array<f32>;
	//   @group(1) @binding(3) var<storage, read> y1Values: array<f32>;
	//   @group(1) @binding(4) var<storage, read> colors: array<vec4<f32>>;
	//   @group(1) @binding(5) var<storage, read> alphaValues: array<f32>;

	//   @vertex
	//   fn vertexMain(
	//     @location(0) rectCorner: vec2<f32>,
	//     @builtin(instance_index) instanceIdx: u32,
	//   ) -> VertexOutput {
	//     let x0 = x0Values[instanceIdx];
	//     let x1 = x1Values[instanceIdx];
	//     let y0 = y0Values[instanceIdx];
	//     let y1 = y1Values[instanceIdx];
	//     let alpha = alphaValues[instanceIdx];
	//     let color = colors[instanceIdx];

	//     // X scaling (always straightforward)
	//     let scaledX0 = scaleX(x0);
	//     let scaledX1 = scaleX(x1);

	//     // Y scaling logic will be injected here based on scale type
	//     {{Y_SCALE_LOGIC}}

	//     // Interpolate rectangle corners using the computed scaled values
	//     let finalX = mix(scaledX0, scaledX1, rectCorner.x);
	//     let finalY = mix(scaledY0, scaledY1, rectCorner.y);

	//     // Convert to normalized device coordinates
	//     let worldPos = vec2<f32>(finalX, finalY);
	//     let normalizedPos = (worldPos / frameUniforms.resolution) * 2.0 - 1.0;

	//     var output: VertexOutput;
	//     output.position = vec4<f32>(normalizedPos.x, -normalizedPos.y, 0.0, 1.0);
	//     output.color = vec4<f32>(color.rgb, color.a * alpha);
	//     return output;
	//   }

	//   @fragment
	//   fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
	//     return input.color;
	//   }
	// `;

	// const rectsShaderCode = `
	//   struct VertexOutput {
	//     @builtin(position) position: vec4<f32>,
	//     @location(0) color: vec4<f32>,
	//   };

	//   @group(1) @binding(0) var<storage, read> x0Values: array<f32>;
	//   @group(1) @binding(1) var<storage, read> x1Values: array<f32>;
	//   @group(1) @binding(2) var<storage, read> y0Values: array<f32>;
	//   @group(1) @binding(3) var<storage, read> y1Values: array<f32>;
	//   @group(1) @binding(4) var<storage, read> colors: array<vec4<f32>>;
	//   @group(1) @binding(5) var<storage, read> alphaValues: array<f32>;

	//   @vertex
	//   fn vertexMain(
	//     @location(0) rectCorner: vec2<f32>,
	//     @builtin(instance_index) instanceIdx: u32,
	//   ) -> VertexOutput {
	//     let x0 = x0Values[instanceIdx];
	//     let x1 = x1Values[instanceIdx];
	//     let y0 = y0Values[instanceIdx];
	//     let y1 = y1Values[instanceIdx];
	//     let alpha = alphaValues[instanceIdx];
	//     let color = colors[instanceIdx];

	//     // Use centralized scale functions
	//     let scaledX0 = scaleX(x0);
	//     let scaledX1 = scaleX(x1);
	//     let scaledY0 = scaleY(y0);
	//     let scaledY1 = scaleY(y1);

	//     // Interpolate rectangle corners
	//     let finalX = mix(scaledX0, scaledX1, rectCorner.x);
	//     let finalY = mix(scaledY0, scaledY1, rectCorner.y);

	//     // Convert to normalized coordinates
	//     let worldPos = vec2<f32>(finalX, finalY);
	//     let normalizedPos = (worldPos / frameUniforms.resolution) * 2.0 - 1.0;

	//     var output: VertexOutput;
	//     output.position = vec4<f32>(normalizedPos.x, -normalizedPos.y, 0.0, 1.0);
	//     output.color = vec4<f32>(color.rgb, color.a * alpha);
	//     return output;
	//   }

	//   @fragment
	//   fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
	//     return input.color;
	//   }
	// `;

	const vertexBufferLayout = [
		{
			arrayStride: 2 * 4, // 2 floats * 4 bytes
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
		{ binding: 0, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX }, // x0Values
		{ binding: 1, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX }, // x1Values
		{ binding: 2, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX }, // y0Values
		{ binding: 3, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX }, // y1Values
		{ binding: 4, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX }, // colorValues
		{ binding: 5, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX }, // alphaValues
		{ binding: 6, type: 'uniform', visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT } // markConstants
	];

	// Buffer update effects
	$effect(() => {
		if (x0Data && renderer?.resourcesCreated) {
			x0Buffer = renderer.createOrUpdateBuffer(x0Buffer, x0Data);
		}
	});

	$effect(() => {
		if (x1Data && renderer?.resourcesCreated) {
			x1Buffer = renderer.createOrUpdateBuffer(x1Buffer, x1Data);
		}
	});

	$effect(() => {
		if (y0Data && renderer?.resourcesCreated) {
			y0Buffer = renderer.createOrUpdateBuffer(y0Buffer, y0Data);
		}
	});

	$effect(() => {
		if (y1Data && renderer?.resourcesCreated) {
			y1Buffer = renderer.createOrUpdateBuffer(y1Buffer, y1Data);
		}
	});

	$effect(() => {
		// Only create/update buffer if we have color data (field mode)
		// In constant mode, colorValueData is null and we skip this entirely
		// BaseGPURenderer will auto-fill the binding with a dummy buffer
		if (colorValueData && renderer?.resourcesCreated) {
			colorValueBuffer = renderer.createOrUpdateBuffer(colorValueBuffer, colorValueData);
		}
	});

	$effect(() => {
		if (alphaData && renderer?.resourcesCreated) {
			alphaBuffer = renderer.createOrUpdateBuffer(alphaBuffer, alphaData);
		}
	});

	// MarkConstants buffer management
	$effect(() => {
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
				label: 'rects-mark-constants'
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

	// Check for per-data bind group readiness
	let dataBindGroupReady = $derived(!!renderer?.perDataBindGroup);

	$effect(() => {
		void renderer?.resourcesCreated;
		void dataBindGroupReady;

		// For color, check based on mode:
		// - Constant mode (colorMode === 0): always ready (no buffer needed)
		// - Field mode (colorMode === 1): need colorValueBuffer
		const isColorReady = colorMode === 0 || !!colorValueBuffer;

		if (
			x0Buffer &&
			x1Buffer &&
			y0Buffer &&
			y1Buffer &&
			isColorReady &&
			alphaBuffer &&
			markConstantsBuffer &&
			renderer?.resourcesCreated &&
			!dataBindGroupReady
		) {
			untrack(() => {
				createRectsDataBindGroup();
			});
		}
	});

	// Data writing effects
	$effect(() => {
		void dataBindGroupReady;
		if (x0Data && x0Buffer && dataBindGroupReady) {
			untrack(() => {
				const device = webGPUContext.getDevice();
				device?.queue.writeBuffer(x0Buffer, 0, x0Data);
			});
		}
	});

	$effect(() => {
		void dataBindGroupReady;
		if (x1Data && x1Buffer && dataBindGroupReady) {
			const device = webGPUContext.getDevice();
			device?.queue.writeBuffer(x1Buffer, 0, x1Data);
		}
	});

	$effect(() => {
		void dataBindGroupReady;
		if (y0Data && y0Buffer && dataBindGroupReady) {
			const device = webGPUContext.getDevice();
			device?.queue.writeBuffer(y0Buffer, 0, y0Data);
		}
	});

	$effect(() => {
		void dataBindGroupReady;

		console.log(`📐 Rects received Y data:`, {
			y0First5: Array.from(y0Data.slice(0, 5)),
			y1First5: Array.from(y1Data.slice(0, 5)),
			instanceCount: y0Data.length,
			x0First5: Array.from(x0Data.slice(0, 5)),
			x1First5: Array.from(x1Data.slice(0, 5)),
			colorValueFirst5: colorValueData ? Array.from(colorValueData.slice(0, 5)) : 'null (constant mode)',
			alphaFirst3: alphaData ? Array.from(alphaData.slice(0, 3)) : 'null',
			colorMode: colorMode === 0 ? 'constant' : 'scale'
		});

		if (y1Data && y1Buffer && dataBindGroupReady) {
			const device = webGPUContext.getDevice();
			device?.queue.writeBuffer(y1Buffer, 0, y1Data);
		}
	});

	$effect(() => {
		void dataBindGroupReady;
		if (colorValueData && colorValueBuffer && dataBindGroupReady) {
			const device = webGPUContext.getDevice();
			device?.queue.writeBuffer(colorValueBuffer, 0, colorValueData);
		}
	});

	$effect(() => {
		void dataBindGroupReady;
		if (alphaData && alphaBuffer && dataBindGroupReady) {
			const device = webGPUContext.getDevice();
			device?.queue.writeBuffer(alphaBuffer, 0, alphaData);
		}
	});

	$effect(() => {
		void dataBindGroupReady;
		if (
			x0Data &&
			x1Data &&
			y0Data &&
			y1Data &&
			alphaData &&
			x0Buffer &&
			x1Buffer &&
			y0Buffer &&
			y1Buffer &&
			alphaBuffer &&
			dataBindGroupReady
		) {
			renderer.updateInstanceCount(x0Data.length);
			gpuCoordinator.invalidateChart(chartContext.chartId);
		}
	});

	// Create unit square geometry for rectangle rendering
	function createRectGeometry() {
		return new Float32Array([
			0,
			0, // bottom-left  (x0, y0)
			1,
			0, // bottom-right (x1, y0)
			0,
			1, // top-left     (x0, y1)
			1,
			0, // bottom-right (x1, y0)
			1,
			1, // top-right    (x1, y1)
			0,
			1 // top-left     (x0, y1)
		]);
	}

	async function initializeRectGeometry() {
		try {
			const device = webGPUContext.getDevice();
			if (!device) {
				throw new Error('No WebGPU device available');
			}

			// Create unit square geometry buffer
			const rectVertices = createRectGeometry();
			console.log('📐 Rect vertices:', rectVertices);

			rectGeometryBuffer = device.createBuffer({
				size: rectVertices.byteLength,
				usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
				label: 'rects-unit-square-geometry'
			});
			device.queue.writeBuffer(rectGeometryBuffer, 0, rectVertices);

			console.log('✅ Rect geometry created successfully');
		} catch (error) {
			console.error('❌ Failed to create rect geometry:', error);
			throw error;
		}
	}

	function createRectsDataBindGroup() {
		if (!x0Buffer || !x1Buffer || !y0Buffer || !y1Buffer || !alphaBuffer || !markConstantsBuffer) {
			console.warn('Cannot create rects data bind group - missing required buffers');
			return;
		}

		// Pass only the bindings we have.
		// BaseGPURenderer will auto-fill missing bindings (like colorValues in constant mode)
		const dataBindings = [
			{ binding: 0, resource: { buffer: x0Buffer } },
			{ binding: 1, resource: { buffer: x1Buffer } },
			{ binding: 2, resource: { buffer: y0Buffer } },
			{ binding: 3, resource: { buffer: y1Buffer } },
			// Only include colorValueBuffer if it exists (field mode)
			...(colorValueBuffer ? [{ binding: 4, resource: { buffer: colorValueBuffer } }] : []),
			{ binding: 5, resource: { buffer: alphaBuffer } },
			{ binding: 6, resource: { buffer: markConstantsBuffer } }
		];

		renderer.createDataBindGroup(dataBindings);
	}

	function drawRects(passEncoder) {
		try {
			if (!rectGeometryBuffer || renderer.instanceCount === 0) {
				return;
			}

			passEncoder.setVertexBuffer(0, rectGeometryBuffer);
			passEncoder.draw(rectVertexCount, renderer.instanceCount);
		} catch (error) {
			console.error('❌ Rects draw operation failed:', error);
			throw error;
		}
	}

	// Wait for WebGPU context
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

		await initializeRects();
	}

	// // Initialize rectangles renderer
	// async function initializeRects() {
	// 	try {
	// 		if (!gpuCoordinator) {
	// 			throw new Error('GPU Coordinator context missing. Make sure setCoordinators() was called.');
	// 		}

	// 		// Create base renderer with scale type information
	// 		renderer = new BaseGPURenderer('rects', webGPUContext, gpuCoordinator, chartContext, {
	// 			zIndex,
	// 			xScaleType: chartContext.scaleTypes?.x || 'linear',
	// 			yScaleType: chartContext.scaleTypes?.y || 'linear'
	// 		});

	// 		await renderer.initialize({
	// 			markShaderCode: rectsShaderCode,
	// 			vertexBufferLayout,
	// 			dataBindingConfig
	// 		});

	// 		// Initialize rectangle-specific geometry
	// 		await initializeRectGeometry();

	// 		// Register layer with base renderer
	// 		renderer.registerLayer(drawRects);

	// 		console.log('✅ Rects component initialized');
	// 	} catch (error) {
	// 		console.error('❌ Rects component initialization failed:', error);
	// 		initializationError = error.message;
	// 		throw error;
	// 	}
	// }

	// Initialize rectangles renderer
	async function initializeRects() {
		try {
			if (!gpuCoordinator) {
				throw new Error('GPU Coordinator context missing. Make sure setCoordinators() was called.');
			}

			// Create base renderer with scale type information
			renderer = new BaseGPURenderer('rects', webGPUContext, gpuCoordinator, chartContext, {
				zIndex,
				xScaleType: chartContext.scaleTypes?.x || 'linear',
				yScaleType: chartContext.scaleTypes?.y || 'linear'
			});

			await renderer.initialize({
				markShaderCode: rectsShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition: rectRendererDefinition // Pass the definition
			});

			// Initialize rectangle-specific geometry
			await initializeRectGeometry();

			// Initialize markConstants buffer
			updateMarkConstants();

			// Register layer with base renderer
			renderer.registerLayer(drawRects);

			console.log('✅ Rects component initialized');
		} catch (error) {
			console.error('❌ Rects component initialization failed:', error);
			initializationError = error.message;
			throw error;
		}
	}

	onMount(async () => {
		try {
			await waitForWebGPU();
		} catch (error) {
			console.error('❌ Rects component mount failed:', error);
			initializationError = error.message;
		}
	});

	onDestroy(() => {
		try {
			// Clean up LOCALLY OWNED geometry buffer
			// This buffer is created directly in initializeRectGeometry(),
			// NOT via renderer.createOrUpdateBuffer(), so we must destroy it manually.
			if (rectGeometryBuffer) {
				rectGeometryBuffer.destroy();
				rectGeometryBuffer = null;
			}

			// Clean up markConstantsBuffer (created directly, not via renderer)
			if (markConstantsBuffer) {
				markConstantsBuffer.destroy();
				markConstantsBuffer = null;
			}

			// Data buffers (x0Buffer, x1Buffer, y0Buffer, y1Buffer, colorValueBuffer, alphaBuffer)
			// are created via renderer.createOrUpdateBuffer() and tracked in
			// renderer.#ownedResources.buffers - they are automatically destroyed
			// by renderer.destroy(). DO NOT destroy them here (would double-destroy).

			// Base renderer handles:
			// - Data buffer cleanup (tracked in #ownedResources)
			// - Shared resource cleanup (via coordinator.releaseRenderer)
			// - Layer unregistration
			if (renderer) {
				renderer.destroy();
				renderer = null;
			}
		} catch (error) {
			console.error('❌ Error during Rects component cleanup:', error);
		}
	});
</script>

{#if initializationError}
	<div class="rects-error">
		<p>Rects component failed to initialize:</p>
		<p class="error-message">{initializationError}</p>
	</div>
{/if}

<style>
	.rects-error {
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
