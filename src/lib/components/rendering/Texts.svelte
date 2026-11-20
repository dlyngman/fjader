<script lang="ts">
	import { isNegativeOrNanExpr } from '$lib/gpu/NanShaderLib';
	import { UNIFORM_BYTES } from './uniform-sizes';
	import { getContext, onMount, onDestroy } from 'svelte';
	import { RendererHost } from './RendererHost.svelte';
	import { getGPUContext } from '$lib/gpu';
	import { ATLAS_WGSL } from '$lib/gpu/text/atlas-bindings';
	import { DEFAULT_STROKE_COLOR } from '$lib/scales/color-utils';
	import type { ChartContext, WebGPUCanvasContext } from '$lib/types';
	import { activityReads, markActivityWGSL } from './activity-reads';

	/**
	 * Text on the GPU: one quad per row, over its string's rectangle in the
	 * chart's text atlas (gpu/text/TextAtlas.svelte.ts).
	 *
	 * A row carries its position (x, y, through the chart's scales, exactly as
	 * a dot's), its atlas slot and its colour value. Its size comes from the
	 * atlas entry, in device pixels, so anchoring happens here in the vertex
	 * stage, every frame, from wherever the scales put the row. That is what
	 * lets a label travel with its bar through a morph or a reorder: it reads
	 * the same resolved values the bar does.
	 *
	 * Unrotated quads snap to device pixels, so the atlas's whole-texel
	 * rectangles map one texel to one pixel and the text stays as the browser
	 * rasterized it.
	 */

	const textRendererDefinition = {
		x: { concept: 'position', channels: ['x'] },
		y: { concept: 'position', channels: ['y'] },
		placeholders: { x: '{{X_AXIS_LOGIC}}', y: '{{Y_AXIS_LOGIC}}' }
	};

	const BINDINGS = {
		X: 0,
		Y: 1,
		SLOT: 2,
		COLOR: 3,
		CONSTANTS: 4
	};

	const UNIFORM_OFFSETS = {
		COLOR_MODE: 0,
		COLOR_SCALE_INDEX: 4,
		GROUP_INDEX: 8,
		TEXT_ANCHOR: 12,
		CONSTANT_COLOR: 16,
		DX: 32,
		DY: 36,
		LINE_ANCHOR: 40,
		ROTATION: 44,
		OPACITY: 48
	};

	const TEXT_ANCHOR = { start: 0, middle: 1, end: 2 } as const;
	const LINE_ANCHOR = { top: 0, middle: 1, bottom: 2 } as const;

	interface Props {
		xData: Float32Array;
		yData: Float32Array;
		/** Each row's atlas slot; negative draws nothing (no text, no position, atlas full). */
		slotData: Float32Array;
		colorValueData: Float32Array | null;
		dataVersion: number;
		/** The data version whose first write lands without morphing, or 0 (see Dots). */
		landsFor?: number;
		zIndex?: number;
		colorMode?: number;
		colorScaleIndex?: number;
		groupIndex?: number;
		constantColor?: [number, number, number, number];
		opacity?: number;
		textAnchor?: 'start' | 'middle' | 'end';
		lineAnchor?: 'top' | 'middle' | 'bottom';
		/** Offsets in CSS pixels. */
		dx?: number;
		dy?: number;
		/** Degrees, clockwise, about the anchor. */
		rotate?: number;
		markId?: string;
		/** The band axis when rows are one per category, so the other axis morphs (see Dots). */
		bandAxis?: 'x' | 'y' | null;
		/** In a facet grid, each row's facet index: a cell draws its own rows (see Dots). */
		facetData?: Float32Array | null;
	}

	let {
		xData,
		yData,
		slotData,
		colorValueData,
		dataVersion,
		landsFor = 0,
		zIndex = 0,
		colorMode = 0,
		colorScaleIndex = 0,
		groupIndex = 0,
		constantColor = DEFAULT_STROKE_COLOR,
		opacity = 1,
		textAnchor = 'middle',
		lineAnchor = 'middle',
		dx = 0,
		dy = 0,
		rotate = 0,
		markId = '',
		bandAxis = null,
		facetData = null
	}: Props = $props();

	const morphX = $derived(bandAxis === 'y');
	const morphY = $derived(bandAxis === 'x');

	const chartContext = getContext<ChartContext>('chart');
	const webGPUContext = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const gpuCoordinator = getGPUContext();

	// Facet index: vertex slot 1, a per-instance attribute (not a storage
	// buffer), as Dots and Rects take it. Read once, as the facet is.
	const faceted = !!chartContext.fx;
	const FACET_VERTEX_SLOT = 1;

	const host = new RendererHost({
		markType: faceted ? 'texts-faceted' : 'texts',
		webGPUContext,
		gpuCoordinator,
		chartContext,
		zIndex,
		label: 'Texts'
	});
	const renderer = $derived(host.renderer);
	const initializationError = $derived(host.error);
	let quadGeometryBuffer: GPUBuffer;

	const ACTIVITY_READS = activityReads('text');

	const textsShaderCode = `
    ${ATLAS_WGSL}

    struct MarkConstants {
      colorMode: u32,           // 0 = constant, 1 = scale
      colorScaleIndex: u32,
      groupIndex: u32,          // Page-wide filter group index, for activity reads
      textAnchor: u32,          // 0 start, 1 middle, 2 end
      constantColor: vec4<f32>,
      dx: f32,                  // CSS pixels
      dy: f32,
      lineAnchor: u32,          // 0 top, 1 middle, 2 bottom
      rotation: f32,            // radians, clockwise
      opacity: f32,
      _pad0: u32,
      _pad1: u32,
      _pad2: u32,
    };
    @group(1) @binding(4) var<uniform> markConstants: MarkConstants;

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) uv: vec2<f32>,
      @location(1) colorValue: f32,
      @location(2) alpha: f32,
    };

    @group(1) @binding(0) var<storage, read> xValues: array<f32>;
    @group(1) @binding(1) var<storage, read> yValues: array<f32>;
    @group(1) @binding(2) var<storage, read> slotValues: array<f32>;
    @group(1) @binding(3) var<storage, read> colorValues: array<f32>;

    fn nothing() -> VertexOutput {
      var out: VertexOutput;
      out.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
      return out;
    }

    @vertex
    fn vertexMain(
      @location(0) corner: vec2<f32>,
      ${faceted ? '@location(1) facetIdx: f32,' : ''}
      @builtin(instance_index) instanceIdx: u32,
    ) -> VertexOutput {
      ${
				faceted
					? `// A cell draws its own rows. A negative or NaN facet (a NULL facet) is no cell; u32() would put it in cell 0.
      if (${isNegativeOrNanExpr('facetIdx')} || u32(facetIdx) != frameUniforms.activeFacetIdx) { return nothing(); }`
					: ''
			}
      let slot = slotValues[instanceIdx];
      if (slot < 0.0) { return nothing(); }
      let rect = textAtlasEntries.rects[u32(slot)];
      // Not rasterized yet (the atlas paints a frame after a string arrives).
      if (rect.z <= 0.0 || rect.w <= 0.0) { return nothing(); }

      let x = xValues[instanceIdx];
      let y = yValues[instanceIdx];
      let colorValue = colorValues[instanceIdx];

      {{X_AXIS_LOGIC}}
      {{Y_AXIS_LOGIC}}

      let dpr = frameUniforms.devicePixelRatio;
      let size = rect.zw;
      let anchorShift = vec2<f32>(
        -0.5 * f32(markConstants.textAnchor) * size.x,
        -0.5 * f32(markConstants.lineAnchor) * size.y
      );
      let at = vec2<f32>(scaledX, scaledY) + vec2<f32>(markConstants.dx, markConstants.dy) * dpr;

      var pos: vec2<f32>;
      if (markConstants.rotation == 0.0) {
        // Whole device pixels: one atlas texel per pixel.
        pos = round(at + anchorShift) + corner * size;
      } else {
        let local = anchorShift + corner * size;
        let c = cos(markConstants.rotation);
        let s = sin(markConstants.rotation);
        pos = at + vec2<f32>(local.x * c - local.y * s, local.x * s + local.y * c);
      }

      let atlasSize = vec2<f32>(textureDimensions(textAtlas));
      var out: VertexOutput;
      out.position = pixelsToClip(pos);
      out.uv = (rect.xy + corner * size) / atlasSize;
      out.colorValue = colorValue;
      out.alpha = markConstants.opacity * entranceAlpha(0u) * selectionDim(
        ${markActivityWGSL(ACTIVITY_READS, {
					color: 'markConstants.colorMode, markConstants.colorScaleIndex, colorValue',
					x: 'x',
					y: 'y',
					group: 'markConstants.groupIndex'
				})}
      );
      return out;
    }

    @fragment
    fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
      // Coverage: strings rasterize white, so alpha alone carries the glyphs.
      let coverage = textureSample(textAtlas, textAtlasSampler, input.uv).a;
      var color: vec4<f32>;
      if (markConstants.colorMode == 0u) {
        color = markConstants.constantColor;
      } else {
        color = getColorFromScale(markConstants.colorScaleIndex, input.colorValue, frameUniforms.nullColor);
      }
      let a = color.a * coverage * input.alpha;
      return vec4<f32>(color.rgb * a, a);
    }
  `;

	const vertexBufferLayout: GPUVertexBufferLayout[] = [
		{
			arrayStride: 2 * 4,
			attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }]
		},
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
		{ binding: BINDINGS.SLOT, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.COLOR, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{
			binding: BINDINGS.CONSTANTS,
			type: 'uniform',
			visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
		}
	];

	// --- WRITES --- (as Dots: see its comments on landing and morphing)

	let lastMorphedVersion = -1;
	function landsNow(): boolean {
		const first = dataVersion !== lastMorphedVersion;
		lastMorphedVersion = dataVersion;
		return first && landsFor !== 0 && landsFor === dataVersion;
	}

	const SCALED_Y = [BINDINGS.Y];
	const SCALED_X = [BINDINGS.X];
	$effect(() => {
		if (!renderer?.resourcesCreated || !bandAxis) return;
		const land = landsNow() ? 'all' : undefined;
		if (bandAxis === 'x') renderer.writeMorphed('x', xData, [[BINDINGS.Y, yData]], land, SCALED_Y);
		else renderer.writeMorphed('y', yData, [[BINDINGS.X, xData]], land, SCALED_X);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && !morphX) renderer.writeAttribute(BINDINGS.X, xData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && !morphY) renderer.writeAttribute(BINDINGS.Y, yData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.SLOT, slotData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && faceted && facetData)
			renderer.writeVertexBuffer(FACET_VERTEX_SLOT, facetData);
	});
	// A facet grid's cells, as they resolve: one layer per cell.
	$effect(() => {
		if (!renderer?.resourcesCreated || !faceted) return;
		const ids = chartContext.facetChartIds;
		if (!ids?.length) return;
		renderer.registerFacetLayers(ids, drawTexts);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && colorValueData)
			renderer.writeAttribute(BINDINGS.COLOR, colorValueData);
	});

	$effect(() => {
		if (!renderer?.resourcesCreated) return;
		if (colorMode === 1 && !colorValueData) return;

		const buffer = new ArrayBuffer(UNIFORM_BYTES.textsMarkConstants);
		const view = new DataView(buffer);
		const LE = true;
		view.setUint32(UNIFORM_OFFSETS.COLOR_MODE, colorMode, LE);
		view.setUint32(UNIFORM_OFFSETS.COLOR_SCALE_INDEX, colorScaleIndex, LE);
		view.setUint32(UNIFORM_OFFSETS.GROUP_INDEX, groupIndex, LE);
		view.setUint32(UNIFORM_OFFSETS.TEXT_ANCHOR, TEXT_ANCHOR[textAnchor], LE);
		view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 0, constantColor[0], LE);
		view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 4, constantColor[1], LE);
		view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 8, constantColor[2], LE);
		view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 12, constantColor[3], LE);
		view.setFloat32(UNIFORM_OFFSETS.DX, dx, LE);
		view.setFloat32(UNIFORM_OFFSETS.DY, dy, LE);
		view.setUint32(UNIFORM_OFFSETS.LINE_ANCHOR, LINE_ANCHOR[lineAnchor], LE);
		view.setFloat32(UNIFORM_OFFSETS.ROTATION, (rotate * Math.PI) / 180, LE);
		view.setFloat32(UNIFORM_OFFSETS.OPACITY, opacity, LE);
		renderer.writeUniform(BINDINGS.CONSTANTS, new Uint8Array(buffer));
	});

	$effect(() => {
		if (renderer?.resourcesCreated) renderer.updateInstanceCount(slotData?.length ?? 0);
	});

	// A quad's corners in [0, 1]², two triangles.
	const corners = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);

	function drawTexts(passEncoder: GPURenderPassEncoder) {
		if (!quadGeometryBuffer || renderer.instanceCount === 0) return;
		passEncoder.setVertexBuffer(0, quadGeometryBuffer);
		if (faceted) {
			// The faceted pipeline declares vertex slot 1: drawing without it is a
			// validation error that loses every mark in the submit (#193). Skip
			// until the facet data lands.
			const facetBuffer = renderer.getVertexBuffer(FACET_VERTEX_SLOT);
			if (!facetBuffer) return;
			passEncoder.setVertexBuffer(1, facetBuffer);
		}
		passEncoder.draw(6, renderer.instanceCount);
	}

	onMount(() =>
		host.mount({
			init: {
				markShaderCode: textsShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition: textRendererDefinition
			},
			async ready(r) {
				const device = webGPUContext.getDevice()!;
				quadGeometryBuffer = device.createBuffer({
					size: corners.byteLength,
					usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
					label: 'texts-geometry'
				});
				device.queue.writeBuffer(quadGeometryBuffer, 0, corners);
				// Faceted: each cell's layer, registered as the cells resolve (above).
				if (!faceted) r.registerLayer(drawTexts);
			}
		})
	);

	$effect(() => {
		if (renderer?.resourcesCreated && markId) gpuCoordinator?.releaseRetained(markId);
	});

	onDestroy(() => {
		const r = renderer;
		const qgb = quadGeometryBuffer;
		const retained =
			r &&
			markId &&
			gpuCoordinator?.retainRenderer(markId, {
				destroy() {
					qgb?.destroy();
					r.destroy();
				}
			});
		if (retained) return;
		qgb?.destroy();
		r?.destroy();
	});
</script>

{#if initializationError}
	<div class="texts-error">{initializationError}</div>
{/if}
