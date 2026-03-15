<script lang="ts">
	import { getContext, onMount, onDestroy, untrack } from 'svelte';
	import { BaseGPURenderer } from './BaseGPURenderer.svelte';
	import { getGPUContext } from '$lib/gpu';
	import { DEFAULT_STROKE_COLOR } from '$lib/scales/color-utils';
	import type { ChartContext, WebGPUCanvasContext } from '$lib/types';

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

	// Facet uses vertex buffer slot 1 (not a storage binding)
	const FACET_VERTEX_SLOT = 1;

	// Uniform struct offsets (matching WGSL MarkConstants layout)
	const UNIFORM_OFFSETS = {
		COLOR_MODE: 0,
		COLOR_SCALE_INDEX: 4,
		SIZE_MODE: 8,
		SIZE_SCALE_INDEX: 12,
		CONSTANT_COLOR: 16
	};

	interface Props {
		xData: Float32Array;
		yData: Float32Array;
		colorValueData: Float32Array | null;
		radiusData: Float32Array | null;
		alphaData: Float32Array | null;
		facetData?: Float32Array | null;
		dataVersion: number;
		zIndex?: number;
		colorMode?: number;
		colorScaleIndex?: number;
		constantColor?: [number, number, number, number];
		sizeMode?: number;
		sizeScaleIndex?: number;
		markId?: string;
	}

	let {
		xData,
		yData,
		colorValueData,
		radiusData,
		alphaData,
		facetData = null,
		dataVersion,
		zIndex = 0,
		colorMode = 0,
		colorScaleIndex = 0,
		constantColor = DEFAULT_STROKE_COLOR,
		sizeMode = 0,
		sizeScaleIndex = 0,
		markId = ''
	}: Props = $props();

	const chartContext = getContext<ChartContext>('chart');
	const webGPUContext = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const gpuCoordinator = getGPUContext();

	const faceted = !!chartContext.fx;

	let renderer = $state<BaseGPURenderer | null>(null);
	let initializationError = $state<string | null>(null);
	let quadGeometryBuffer: GPUBuffer;

	const quadVertexCount = 6;

	// --- Facet compile-time specialization ---
	// Facet index arrives as a vertex attribute (stepMode: instance), not a storage buffer.
	const FACET_DISCARD_WGSL = `
      // Facet filtering: discard vertices not belonging to this cell
      if (u32(facetIdx) != frameUniforms.activeFacetIdx) {
        var degen: VertexOutput;
        degen.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return degen;
      }`;

	const dotsShaderCode = `
    // MarkConstants uniform for per-mark configuration
    struct MarkConstants {
      colorMode: u32,           // 0 = constant, 1 = scale
      colorScaleIndex: u32,     // Index into colorConfigs
      sizeMode: u32,            // 0 = raw value, 1 = scale
      sizeScaleIndex: u32,      // Index into sizeConfigs
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
      {{FACET_PARAM}}
    ) -> VertexOutput {
      {{FACET_DISCARD}}
      let x = xValues[instanceIdx];
      let y = yValues[instanceIdx];
      let rawRadius = radiusValues[instanceIdx];
      let alpha = alphaValues[instanceIdx];
      let colorValue = colorValues[instanceIdx];

      // Size scale: when sizeMode == 1, map raw value through sqrt scale
      var radius: f32;
      if (markConstants.sizeMode == 1u) {
        radius = getSizeFromScale(markConstants.sizeScaleIndex, rawRadius);
      } else {
        radius = rawRadius;
      }

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

      return vec4<f32>(baseColor.rgb * finalAlpha, finalAlpha);
    }
  `
		.replace('{{FACET_PARAM}}', faceted ? '@location(1) facetIdx: f32,' : '')
		.replace('{{FACET_DISCARD}}', faceted ? FACET_DISCARD_WGSL : '');

	const vertexBufferLayout: GPUVertexBufferLayout[] = [
		{
			arrayStride: 2 * 4,
			attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }]
		},
		// Facet index: per-instance f32 via vertex attribute (not a storage buffer)
		...(faceted
			? [
					{
						arrayStride: 4,
						stepMode: 'instance' as GPUVertexStepMode,
						attributes: [{ shaderLocation: 1, offset: 0, format: 'float32' as GPUVertexFormat }]
					}
				]
			: [])
	];

	const dataBindingConfig = [
		{ binding: BINDINGS.X, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.Y, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.RADIUS, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.ALPHA, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.COLOR, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{
			binding: BINDINGS.CONSTANTS,
			type: 'uniform',
			visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
		}
	];

	const effectiveMarkType = faceted ? 'dots-faceted' : 'dots';

	// --- WRITING EFFECTS ---

	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.X, xData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.Y, yData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.RADIUS, radiusData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.ALPHA, alphaData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && colorValueData)
			renderer.writeAttribute(BINDINGS.COLOR, colorValueData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && facetData)
			renderer.writeVertexBuffer(FACET_VERTEX_SLOT, facetData);
	});

	// Uniforms
	$effect(() => {
		if (renderer?.resourcesCreated) {
			// Guard: when switching to field-based color (colorMode=1), the uniform
			// update fires before the parent's setup lifecycle effect has a chance to
			// unmount this component and retain the renderer. Without this guard the
			// retained renderer would draw one frame with colorMode=1 but a stale/dummy
			// color buffer, producing a visible flash. Reading colorValueData via
			// untrack avoids adding it as a dependency — on subsequent field→field
			// changes colorMode stays 1 (no trigger), so the old valid state is kept.
			if (colorMode === 1 && !untrack(() => colorValueData)) return;

			const buffer = new ArrayBuffer(32);
			const view = new DataView(buffer);
			const LE = true;

			view.setUint32(UNIFORM_OFFSETS.COLOR_MODE, colorMode, LE);
			view.setUint32(UNIFORM_OFFSETS.COLOR_SCALE_INDEX, colorScaleIndex, LE);
			view.setUint32(UNIFORM_OFFSETS.SIZE_MODE, sizeMode, LE);
			view.setUint32(UNIFORM_OFFSETS.SIZE_SCALE_INDEX, sizeScaleIndex, LE);
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

	// Facet layer registration (reactive — fires when FacetCells resolve)
	$effect(() => {
		if (!renderer?.resourcesCreated || !faceted) return;
		const ids = chartContext.facetChartIds;
		if (!ids?.length) return;
		renderer.registerFacetLayers(ids, drawDots);
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

	function drawDots(passEncoder: GPURenderPassEncoder) {
		if (!quadGeometryBuffer || renderer.instanceCount === 0) return;
		passEncoder.setVertexBuffer(0, quadGeometryBuffer);
		if (faceted) {
			const facetBuffer = renderer.getVertexBuffer(FACET_VERTEX_SLOT);
			if (facetBuffer) passEncoder.setVertexBuffer(1, facetBuffer);
		}
		passEncoder.draw(quadVertexCount, renderer.instanceCount);
	}

	async function initializeDots() {
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
				markShaderCode: dotsShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition: dotRendererDefinition
			});

			await initializeDotsGeometry();

			// Non-faceted: register with the single chart canvas
			// Faceted: registration handled by reactive $effect above
			if (!faceted) {
				renderer.registerLayer(drawDots);
			}
		} catch (error) {
			console.error('Dots init failed:', error);
			initializationError = (error as Error).message;
		}
	}

	async function waitForWebGPU() {
		let attempts = 0;
		while (!webGPUContext.isInitialized() && attempts < 100) {
			await new Promise((r) => setTimeout(r, 50));
			attempts++;
		}
		if (webGPUContext.isInitialized()) await initializeDots();
	}

	onMount(() => waitForWebGPU());

	// Clean up retained renderer from a previous instance once this renderer has data
	$effect(() => {
		if (renderer?.resourcesCreated && markId) {
			console.log(`[Dots:${markId}] releaseRetained (resourcesCreated)`);
			gpuCoordinator?.releaseRetained(markId);
		}
	});

	onDestroy(() => {
		const r = renderer;
		const qgb = quadGeometryBuffer;
		const retained =
			r &&
			markId &&
			gpuCoordinator?.retainRenderer(markId, {
				destroy() {
					console.log(`[Dots:${markId}] retained.destroy()`);
					qgb?.destroy();
					r.destroy();
				}
			});
		console.log(`[Dots:${markId}] onDestroy retained=${!!retained} hasRenderer=${!!r}`);
		if (retained) return;
		if (qgb) qgb.destroy();
		if (r) r.destroy();
	});
</script>

{#if initializationError}
	<div class="dots-error">{initializationError}</div>
{/if}
