<script>
	import { getContext, onMount, onDestroy, untrack } from 'svelte';
	import { BaseGPURenderer } from './BaseGPURenderer.svelte.js';
	import { getGPUContext } from '$lib/gpu';

	const dotRendererDefinition = {
		x: { concept: 'position', channels: ['x'] },
		y: { concept: 'position', channels: ['y'] },
		placeholders: { x: '{{X_AXIS_LOGIC}}', y: '{{Y_AXIS_LOGIC}}' }
	};

	const BINDINGS = {
		X: 0,
		Y: 1,
		RADIUS: 2,
		ALPHA: 3,
		COLOR: 4,
		CONSTANTS: 5
	};

	// Uniform struct offsets (matching WGSL MarkConstants layout)
	const UNIFORM_OFFSETS = {
		COLOR_MODE: 0,
		COLOR_SCALE_INDEX: 4,
		// 8-12: padding (_pad0, _pad1)
		CONSTANT_COLOR: 16
	};

	let {
		xData, yData, colorValueData, radiusData, alphaData,
		dataVersion, zIndex = 0,
		colorMode = 0, colorScaleIndex = 0, constantColor = [0.13, 0.55, 0.13, 1.0]
	} = $props();

	const chartContext = getContext('chart');
	const webGPUContext = getContext('webgpu-canvas');
	const gpuCoordinator = getGPUContext();

	let renderer = $state(null);
	let initializationError = $state(null);
	let quadGeometryBuffer;

	const quadVertexCount = 6;

    // ... [dotsShaderCode omitted, same as before] ...
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

	const vertexBufferLayout = [{
		arrayStride: 2 * 4,
		attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }]
	}];

	const dataBindingConfig = [
		{ binding: BINDINGS.X, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.Y, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.RADIUS, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.ALPHA, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.COLOR, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.CONSTANTS, type: 'uniform', visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT }
	];

	// --- WRITING EFFECTS ---

	$effect(() => { if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.X, xData); });
	$effect(() => { if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.Y, yData); });
	$effect(() => { if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.RADIUS, radiusData); });
	$effect(() => { if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.ALPHA, alphaData); });
	$effect(() => { if (renderer?.resourcesCreated && colorValueData) renderer.writeAttribute(BINDINGS.COLOR, colorValueData); });

	// Uniforms
	$effect(() => {
		if (renderer?.resourcesCreated) {
			const buffer = new ArrayBuffer(32);
			const view = new DataView(buffer);
			const LE = true;

			view.setUint32(UNIFORM_OFFSETS.COLOR_MODE, colorMode, LE);
			view.setUint32(UNIFORM_OFFSETS.COLOR_SCALE_INDEX, colorScaleIndex, LE);
			// padding at 8-12 handled by struct alignment
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 0, constantColor[0], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 4, constantColor[1], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 8, constantColor[2], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 12, constantColor[3], LE);

			renderer.writeUniform(BINDINGS.CONSTANTS, new Uint8Array(buffer));
		}
	});

	// Instance Count
	$effect(() => {
		if (renderer?.resourcesCreated && xData) {
			renderer.updateInstanceCount(xData.length);
		}
	});

	function createQuadGeometry() {
		return new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]);
	}

	async function initializeDotsGeometry() {
		const device = webGPUContext.getDevice();
		const quadVertices = createQuadGeometry();
		quadGeometryBuffer = device.createBuffer({
			size: quadVertices.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			label: 'dots-geometry'
		});
		device.queue.writeBuffer(quadGeometryBuffer, 0, quadVertices);
	}

	function drawDots(passEncoder) {
		if (!quadGeometryBuffer || renderer.instanceCount === 0) return;
		passEncoder.setVertexBuffer(0, quadGeometryBuffer);
		passEncoder.draw(quadVertexCount, renderer.instanceCount);
	}

	async function initializeDots() {
		try {
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
			renderer.registerLayer(drawDots);
		} catch (error) {
			console.error('Dots init failed:', error);
			initializationError = error.message;
		}
	}

	async function waitForWebGPU() {
		let attempts = 0;
		while (!webGPUContext.isInitialized() && attempts < 100) {
			await new Promise(r => setTimeout(r, 50));
			attempts++;
		}
		if (webGPUContext.isInitialized()) await initializeDots();
	}

	onMount(() => waitForWebGPU());

	onDestroy(() => {
		if (quadGeometryBuffer) quadGeometryBuffer.destroy();
		if (renderer) renderer.destroy();
	});
</script>

{#if initializationError}
	<div class="dots-error">{initializationError}</div>
{/if}