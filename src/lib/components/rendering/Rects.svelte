<script>
	import { getContext, onMount, onDestroy, untrack } from 'svelte';
	import { BaseGPURenderer } from './BaseGPURenderer.svelte';
	import { getGPUContext } from '$lib/gpu';

	const rectRendererDefinition = {
		x: { concept: 'extent', channels: ['x0', 'x1'] },
		y: { concept: 'extent', channels: ['y0', 'y1'] },
		placeholders: { x: '{{X_AXIS_LOGIC}}', y: '{{Y_AXIS_LOGIC}}' }
	};

	// Named Bindings for safety
	const BINDINGS = {
		X0: 0,
		X1: 1,
		Y0: 2,
		Y1: 3,
		COLOR: 4,
		ALPHA: 5,
		CONSTANTS: 6
	};

	// Facet uses vertex buffer slot 1 (not a storage binding)
	const FACET_VERTEX_SLOT = 1;

	// Uniform struct offsets (matching WGSL MarkConstants layout)
	const UNIFORM_OFFSETS = {
		COLOR_MODE: 0,
		COLOR_SCALE_INDEX: 4,
		INSET: 8,
		_PAD0: 12,
		CONSTANT_COLOR: 16,
		DX: 32,
		DY: 36
		// 40-47: padding for 16-byte alignment
	};

	let {
		x0Data,
		x1Data,
		y0Data,
		y1Data,
		colorValueData,
		alphaData,
		facetData = null,
		dataVersion,
		zIndex = 0,
		colorMode = 0,
		colorScaleIndex = 0,
		constantColor = [0.2, 0.4, 0.8, 1.0],
		inset = 0,
		dx = 0,
		dy = 0
	} = $props();

	const chartContext = getContext('chart');
	const webGPUContext = getContext('webgpu-canvas');
	const gpuCoordinator = getGPUContext();
	const faceted = !!chartContext.fx;

	// --- Facet compile-time specialization ---
	// Facet index arrives as a vertex attribute (stepMode: instance), not a storage buffer.
	const FACET_DISCARD_WGSL = `
      // Facet filtering: discard vertices not belonging to this cell
      if (u32(facetIdx) != frameUniforms.activeFacetIdx) {
        var degen: VertexOutput;
        degen.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return degen;
      }`;

	let renderer = $state(null);
	let initializationError = $state(null);
	let rectGeometryBuffer; // Static geometry managed locally

	const rectVertexCount = 6;

	const rectsShaderCode = `
    // MarkConstants uniform for per-mark configuration
    struct MarkConstants {
      colorMode: u32,           // 0 = constant, 1 = scale
      colorScaleIndex: u32,     // Index into colorConfigs
      inset: f32,               // Pixel inset on all sides
      _pad0: u32,
      constantColor: vec4<f32>, // Used when colorMode = 0
      dx: f32,                  // Horizontal pixel offset
      dy: f32,                  // Vertical pixel offset
      _pad1: f32,
      _pad2: f32,
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
      {{FACET_PARAM}}
    ) -> VertexOutput {
      {{FACET_DISCARD}}
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

      // Apply inset (shrink rect inward on all sides)
      let ix = markConstants.inset * sign(scaledX1 - scaledX0);
      let iy = markConstants.inset * sign(scaledY1 - scaledY0);

      // Interpolate rectangle corners and apply pixel offsets
      let finalX = mix(scaledX0 + ix, scaledX1 - ix, rectCorner.x) + markConstants.dx;
      let finalY = mix(scaledY0 + iy, scaledY1 - iy, rectCorner.y) + markConstants.dy;

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
  
      let finalAlpha = baseColor.a * input.alpha;
      return vec4<f32>(baseColor.rgb * finalAlpha, finalAlpha);
    }
  `
		.replace('{{FACET_PARAM}}', faceted ? '@location(1) facetIdx: f32,' : '')
		.replace('{{FACET_DISCARD}}', faceted ? FACET_DISCARD_WGSL : '');

	const vertexBufferLayout = [
		{
			arrayStride: 2 * 4,
			attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }]
		},
		// Facet index: per-instance f32 via vertex attribute (not a storage buffer)
		...(faceted
			? [
					{
						arrayStride: 4,
						stepMode: 'instance',
						attributes: [{ shaderLocation: 1, offset: 0, format: 'float32' }]
					}
				]
			: [])
	];

	const dataBindingConfig = [
		{ binding: BINDINGS.X0, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.X1, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.Y0, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.Y1, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.COLOR, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.ALPHA, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{
			binding: BINDINGS.CONSTANTS,
			type: 'uniform',
			visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
		}
	];

	const effectiveMarkType = faceted ? 'rects-faceted' : 'rects';

	// --- DATA WRITING EFFECTS (Independent & Fine-Grained) ---

	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.X0, x0Data);
	});
	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.X1, x1Data);
	});
	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.Y0, y0Data);
	});
	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.Y1, y1Data);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && colorValueData)
			renderer.writeAttribute(BINDINGS.COLOR, colorValueData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.ALPHA, alphaData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && facetData)
			renderer.writeVertexBuffer(FACET_VERTEX_SLOT, facetData);
	});

	// Uniforms
	$effect(() => {
		if (renderer?.resourcesCreated) {
			const buffer = new ArrayBuffer(48);
			const view = new DataView(buffer);
			const LE = true;

			view.setUint32(UNIFORM_OFFSETS.COLOR_MODE, colorMode, LE);
			view.setUint32(UNIFORM_OFFSETS.COLOR_SCALE_INDEX, colorScaleIndex, LE);
			view.setFloat32(UNIFORM_OFFSETS.INSET, inset, LE);
			// padding at 12
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 0, constantColor[0], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 4, constantColor[1], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 8, constantColor[2], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 12, constantColor[3], LE);
			view.setFloat32(UNIFORM_OFFSETS.DX, dx, LE);
			view.setFloat32(UNIFORM_OFFSETS.DY, dy, LE);
			// padding at 40-47

			renderer.writeUniform(BINDINGS.CONSTANTS, new Uint8Array(buffer));
		}
	});

	// Instance Count
	$effect(() => {
		if (renderer?.resourcesCreated && x0Data) {
			renderer.updateInstanceCount(x0Data.length);
		}
	});

	// Facet layer registration (reactive — fires when FacetCells resolve)
	$effect(() => {
		if (!renderer?.resourcesCreated || !faceted) return;
		const ids = chartContext.facetChartIds;
		if (!ids?.length) return;
		renderer.registerFacetLayers(ids, drawRects);
	});

	function createRectGeometry() {
		return new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);
	}

	async function initializeRectGeometry() {
		const device = webGPUContext.getDevice();
		const rectVertices = createRectGeometry();
		rectGeometryBuffer = device.createBuffer({
			size: rectVertices.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			label: 'rects-geometry'
		});
		device.queue.writeBuffer(rectGeometryBuffer, 0, rectVertices);
	}

	function drawRects(passEncoder) {
		if (!rectGeometryBuffer || renderer.instanceCount === 0) return;
		passEncoder.setVertexBuffer(0, rectGeometryBuffer);
		if (faceted) {
			const facetBuffer = renderer.getVertexBuffer(FACET_VERTEX_SLOT);
			if (facetBuffer) passEncoder.setVertexBuffer(1, facetBuffer);
		}
		passEncoder.draw(rectVertexCount, renderer.instanceCount);
	}

	async function initializeRects() {
		try {
			renderer = new BaseGPURenderer(
				effectiveMarkType,
				webGPUContext,
				gpuCoordinator,
				chartContext,
				{
					zIndex,
					xScaleType: chartContext.scaleTypes?.x || 'linear',
					yScaleType: chartContext.scaleTypes?.y || 'linear'
				}
			);

			await renderer.initialize({
				markShaderCode: rectsShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition: rectRendererDefinition
			});

			await initializeRectGeometry();

			// Non-faceted: register with the single chart canvas
			// Faceted: registration handled by reactive $effect above
			if (!faceted) {
				renderer.registerLayer(drawRects);
			}
		} catch (error) {
			console.error('Rects init failed:', error);
			initializationError = error.message;
		}
	}

	async function waitForWebGPU() {
		let attempts = 0;
		while (!webGPUContext.isInitialized() && attempts < 100) {
			await new Promise((r) => setTimeout(r, 50));
			attempts++;
		}
		if (webGPUContext.isInitialized()) await initializeRects();
	}

	onMount(() => waitForWebGPU());

	onDestroy(() => {
		if (rectGeometryBuffer) rectGeometryBuffer.destroy();
		if (renderer) renderer.destroy();
	});
</script>

{#if initializationError}
	<div class="rects-error">{initializationError}</div>
{/if}
