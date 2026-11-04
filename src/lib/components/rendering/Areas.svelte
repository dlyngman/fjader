<script lang="ts">
	import { getContext, onMount, onDestroy } from 'svelte';
	import { RendererHost } from './RendererHost.svelte';
	import { getGPUContext } from '$lib/gpu';
	import { getCurveWGSL, getCurveResolution } from '$lib/gpu/CurveShaderLib';
	import { NAN_WGSL } from '$lib/gpu/NanShaderLib';
	import { DEFAULT_FILL_COLOR } from '$lib/scales/color-utils';
	import type { ChartContext, WebGPUCanvasContext, CurveType } from '$lib/types';

	// Areas uses projectToPixels() directly (like Lines, not like Rects).
	// We define x/y so scaleX/scaleY functions are generated.
	const areaRendererDefinition = {
		x: { concept: 'position', channels: ['x'] },
		y: { concept: 'position', channels: ['y'] }
		// No placeholders - Areas calls projectToPixels() via makePoint() internally
	};

	const BINDINGS = {
		DIM: 0, // Primary dimension (x for vertical, y for horizontal)
		TOP: 1, // Top/right boundary (y2 for vertical, x2 for horizontal)
		BOTTOM: 2, // Bottom/left boundary (y1 for vertical, x1 for horizontal)
		SERIES: 3,
		COLOR: 4,
		CONSTANTS: 5,
		FACET: 6
	};

	// Uniform struct offsets (matching WGSL MarkConstants layout, 48 bytes)
	const UNIFORM_OFFSETS = {
		POINT_COUNT: 0, // u32
		COLOR_MODE: 4, // u32
		COLOR_SCALE_INDEX: 8, // u32
		ORIENTATION: 12, // u32 (0=vertical, 1=horizontal)
		CONSTANT_COLOR: 16, // vec4<f32>
		FILL_OPACITY: 32, // f32
		DOT_RADIUS: 36, // f32
		SHOW_BOTTOM_DOTS: 40, // u32 (0 or 1)
		FULL_DOMAIN_SPAN: 44 // f32
	};

	interface Props {
		dimData: Float32Array;
		topData: Float32Array;
		bottomData: Float32Array;
		seriesData?: Float32Array | null;
		colorValueData?: Float32Array | null;
		facetData?: Float32Array | null;
		dataVersion?: number;
		zIndex?: number;
		curve?: CurveType;
		fillOpacity?: number;
		dotRadius?: number;
		fullDomainSpan?: number;
		showBottomDots?: boolean;
		orientation?: 'vertical' | 'horizontal';
		colorMode?: number;
		colorScaleIndex?: number;
		constantColor?: [number, number, number, number];
		markId?: string;
	}

	let {
		dimData,
		topData,
		bottomData,
		seriesData = null,
		colorValueData = null,
		facetData = null,
		dataVersion = 0,
		zIndex = 0,
		curve = 'linear',
		fillOpacity = 0.5,
		dotRadius = 0,
		fullDomainSpan = 0,
		showBottomDots = false,
		orientation = 'vertical',
		colorMode = 0,
		colorScaleIndex = 0,
		constantColor = DEFAULT_FILL_COLOR,
		markId = ''
	}: Props = $props();

	const chartContext = getContext<ChartContext>('chart');
	const webGPUContext = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const gpuCoordinator = getGPUContext();
	const faceted = !!chartContext.fx;
	const baseMarkType = curve === 'linear' ? 'areas' : `areas-${curve}`;
	const effectiveMarkType = faceted ? `${baseMarkType}-faceted` : baseMarkType;

	// --- Facet compile-time specialization ---
	// Areas uses a storage buffer (not a vertex attribute) for facet indices because
	// the boundary check needs random access: facetIndices[nextIdx] to detect when
	// consecutive points span different facet cells. Vertex attributes only provide
	// the current instance's value. (Dots/Rects use vertex attributes since they
	// only need their own instance's facet index.)
	const FACET_BINDING_WGSL = `\n  @group(1) @binding(${BINDINGS.FACET}) var<storage, read> facetIndices: array<f32>;`;
	const FACET_DISCARD_WGSL = `
    // Facet filtering: discard vertices not belonging to this cell
    if (u32(facetIndices[instanceIdx]) != frameUniforms.activeFacetIdx) {
      var degen: VertexOutput;
      degen.position = DISCARD_POS;
      return degen;
    }`;
	const FACET_BOUNDARY_WGSL = `
    // Facet boundary: discard segment if next point is in a different facet
    if (u32(facetIndices[nextIdx]) != frameUniforms.activeFacetIdx) {
      var output: VertexOutput;
      output.position = DISCARD_POS;
      return output;
    }`;

	const host = new RendererHost({
		markType: effectiveMarkType,
		webGPUContext,
		gpuCoordinator,
		chartContext,
		zIndex,
		label: 'Areas'
	});
	const renderer = $derived(host.renderer);
	const initializationError = $derived(host.error);
	let areaGeometryBuffer: GPUBuffer;

	// Resolution and vertex count derived from curve type
	const resolution = getCurveResolution(curve);
	const areaVertexCount = 6 * resolution + 12; // 6N area + 6 top dot + 6 bottom dot
	// Pipeline variant key includes curve type for separate shader compilation
	// Area shader: filled quads between top and bottom boundaries along a dimension.
	// evaluateCurve() and CURVE_RESOLUTION are prepended from CurveShaderLib.
	// Orientation handled via uniform flag — all vertices take the same branch (zero divergence).
	function buildShaderCode() {
		return `
  ${getCurveWGSL(curve)}

  struct MarkConstants {
    pointCount: u32,
    colorMode: u32,
    colorScaleIndex: u32,
    orientation: u32,
    constantColor: vec4<f32>,
    fillOpacity: f32,
    dotRadius: f32,
    showBottomDots: u32,
    fullDomainSpan: f32
  };
  @group(1) @binding(5) var<uniform> markConstants: MarkConstants;

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) colorValue: f32,
    @location(1) alpha: f32,
    @location(2) circleUV: vec2<f32>,
    @location(3) circleRadius: f32
  };

  @group(1) @binding(0) var<storage, read> dimValues: array<f32>;
  @group(1) @binding(1) var<storage, read> topValues: array<f32>;
  @group(1) @binding(2) var<storage, read> bottomValues: array<f32>;
  @group(1) @binding(3) var<storage, read> seriesValues: array<f32>;
  @group(1) @binding(4) var<storage, read> colorValues: array<f32>;
  {{FACET_BINDING}}

  ${NAN_WGSL}

  // Map (dimension, boundary) to (x, y) based on orientation
  fn makePoint(dimVal: f32, boundaryVal: f32) -> vec2<f32> {
    if (markConstants.orientation == 0u) {
      // Vertical: dim is X, boundary is Y
      return vec2<f32>(dimVal, boundaryVal);
    } else {
      // Horizontal: dim is Y, boundary is X
      return vec2<f32>(boundaryVal, dimVal);
    }
  }

  const DISCARD_POS = vec4<f32>(2.0, 2.0, 2.0, 1.0);

  @vertex
  fn vertexMain(
    @location(0) quadCorner: vec2<f32>,
    @builtin(instance_index) instanceIdx: u32,
    @builtin(vertex_index) vertexIdx: u32
  ) -> VertexOutput {
    {{FACET_DISCARD}}
    let pointCount = markConstants.pointCount;
    let circleStart = CURVE_RESOLUTION * 6u;
    let isTopCircle = vertexIdx >= circleStart && vertexIdx < circleStart + 6u;
    let isBottomCircle = vertexIdx >= circleStart + 6u;
    let isCircle = isTopCircle || isBottomCircle;

    // === DOT CIRCLES (vertices 6N..6N+5 top, 6N+6..6N+11 bottom) ===
    if (isCircle) {
      if (markConstants.dotRadius == 0.0 || instanceIdx >= pointCount) {
        var output: VertexOutput;
        output.position = DISCARD_POS;
        return output;
      }
      if (isBottomCircle && markConstants.showBottomDots == 0u) {
        var output: VertexOutput;
        output.position = DISCARD_POS;
        return output;
      }
      let dim = dimValues[instanceIdx];
      let boundary = select(topValues[instanceIdx], bottomValues[instanceIdx], isBottomCircle);
      if (isNaN(dim) || isNaN(boundary)) {
        var output: VertexOutput;
        output.position = DISCARD_POS;
        return output;
      }
      let center = projectToPixels(makePoint(dim, boundary));

      var circleR: f32;
      if (markConstants.dotRadius < 0.0) {
        // Auto-dots: heuristic density fade (no M4 for Areas)
        let baseR = abs(markConstants.dotRadius) * frameUniforms.devicePixelRatio;
        // Select primary axis based on orientation
        var viewSpan: f32;
        var pixelSpan: f32;
        if (markConstants.orientation == 0u) {
          let scale = chartScaleX();
          viewSpan = scale.p2 - scale.p1;
          pixelSpan = (frameUniforms.rangeMax.x - frameUniforms.rangeMin.x)
            * frameUniforms.devicePixelRatio;
        } else {
          let scale = chartScaleY();
          viewSpan = scale.p2 - scale.p1;
          pixelSpan = (frameUniforms.rangeMax.y - frameUniforms.rangeMin.y)
            * frameUniforms.devicePixelRatio;
        }
        let frac = select(1.0, viewSpan / markConstants.fullDomainSpan,
          markConstants.fullDomainSpan > 0.0);
        let pointsInView = f32(markConstants.pointCount) * frac;
        let avgSpacing = pixelSpan / max(pointsInView, 1.0);
        let t = smoothstep(8.0, 30.0, avgSpacing);
        circleR = baseR * t;
      } else {
        circleR = markConstants.dotRadius * frameUniforms.devicePixelRatio;
      }
      let pos = center + quadCorner * circleR * 1.2;

      var output: VertexOutput;
      output.position = pixelsToClip(pos);
      output.colorValue = colorValues[instanceIdx];
      output.alpha = 1.0;
      output.circleUV = quadCorner;
      output.circleRadius = circleR;
      return output;
    }

    // === AREA FILL SUB-QUADS (vertices 0 .. 6N-1) ===
    let currIdx = instanceIdx;
    let nextIdx = instanceIdx + 1u;

    // Last point in data has no next segment
    if (nextIdx >= pointCount) {
      var output: VertexOutput;
      output.position = DISCARD_POS;
      return output;
    }
    {{FACET_BOUNDARY}}

    // Series boundary check
    let seriesCurr = seriesValues[currIdx];
    let seriesNext = seriesValues[nextIdx];
    if (seriesCurr != seriesNext) {
      var output: VertexOutput;
      output.position = DISCARD_POS;
      return output;
    }

    // Read current and next data
    let dimCurr = dimValues[currIdx];
    let dimNext = dimValues[nextIdx];
    let topCurr = topValues[currIdx];
    let topNext = topValues[nextIdx];
    let botCurr = bottomValues[currIdx];
    let botNext = bottomValues[nextIdx];

    // NaN check
    if (isNaN(dimCurr) || isNaN(dimNext) ||
        isNaN(topCurr) || isNaN(topNext) ||
        isNaN(botCurr) || isNaN(botNext)) {
      var output: VertexOutput;
      output.position = DISCARD_POS;
      return output;
    }

    // Project segment endpoints for adaptive resolution
    let topPxCurr = projectToPixels(makePoint(dimCurr, topCurr));
    let topPxNext = projectToPixels(makePoint(dimNext, topNext));
    let botPxCurr = projectToPixels(makePoint(dimCurr, botCurr));
    let botPxNext = projectToPixels(makePoint(dimNext, botNext));

    // Adaptive sub-segment resolution: more segments for longer pixel spans.
    // Use the longer of top/bottom chord for resolution calculation.
    let subSegIdx = vertexIdx / 6u;
    var effectiveRes: u32;
    if (CURVE_RESOLUTION > 3u) {
      let chordPixelLen = max(length(topPxNext - topPxCurr), length(botPxNext - botPxCurr));
      effectiveRes = clamp(u32(ceil(chordPixelLen / 4.0)), 1u, CURVE_RESOLUTION);
    } else {
      effectiveRes = CURVE_RESOLUTION;
    }

    if (subSegIdx >= effectiveRes) {
      var output: VertexOutput;
      output.position = DISCARD_POS;
      return output;
    }

    // Compute neighbor indices with series-aware boundary clamping
    let prevIdx = select(currIdx - 1u, currIdx,
      currIdx == 0u || seriesValues[currIdx - 1u] != seriesCurr);
    let afterIdx = select(nextIdx + 1u, nextIdx,
      nextIdx + 1u >= pointCount || seriesValues[nextIdx + 1u] != seriesNext);

    // Read neighbor dimension values and project control points
    let dimPrev = dimValues[prevIdx];
    let dimAfter = dimValues[afterIdx];

    let topPxPrev = projectToPixels(makePoint(dimPrev, topValues[prevIdx]));
    let topPxAfter = projectToPixels(makePoint(dimAfter, topValues[afterIdx]));
    let botPxPrev = projectToPixels(makePoint(dimPrev, bottomValues[prevIdx]));
    let botPxAfter = projectToPixels(makePoint(dimAfter, bottomValues[afterIdx]));

    // Compute t for this vertex from effective resolution (not geometry buffer)
    let subSegSize = 1.0 / f32(effectiveRes);
    let tLeft = f32(subSegIdx) * subSegSize;
    let tRight = tLeft + subSegSize;
    let localVert = vertexIdx % 6u;
    let isRight = localVert == 1u || localVert == 3u || localVert == 4u;
    let t = select(tLeft, tRight, isRight);

    // Evaluate both boundary curves at t
    let topPos = evaluateCurve(topPxPrev, topPxCurr, topPxNext, topPxAfter, t);
    let botPos = evaluateCurve(botPxPrev, botPxCurr, botPxNext, botPxAfter, t);

    // Interpolate between bottom and top: quadCorner.y = 0 (bottom) or 1 (top)
    let finalPos = mix(botPos, topPos, quadCorner.y);

    var output: VertexOutput;
    output.position = pixelsToClip(finalPos);
    output.colorValue = colorValues[currIdx];
    output.alpha = markConstants.fillOpacity;
    output.circleUV = vec2<f32>(-2.0, -2.0);
    output.circleRadius = 0.0;
    return output;
  }

  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    var baseColor: vec4<f32>;
    if (markConstants.colorMode == 0u) {
      baseColor = markConstants.constantColor;
    } else {
      baseColor = getColorFromScale(
        markConstants.colorScaleIndex,
        input.colorValue,
        frameUniforms.nullColor
      );
    }

    var finalAlpha = baseColor.a * input.alpha;

    // Circle SDF: circleUV is (-2,-2) for area fragments, (-1..1) for dots
    if (input.circleUV.x > -1.5) {
      let dist = length(input.circleUV);
      let sdf = dist - (1.0 / 1.2);
      let pixelSize = frameUniforms.devicePixelRatio / (input.circleRadius * 2.0);
      let circleAlpha = 1.0 - smoothstep(-pixelSize, pixelSize, sdf);
      finalAlpha *= circleAlpha;
      if (finalAlpha < 0.01) { discard; }
    }

    return vec4<f32>(baseColor.rgb * finalAlpha, finalAlpha);
  }
  `;
	}

	const areasShaderCode = buildShaderCode()
		.replace('{{FACET_BINDING}}', faceted ? FACET_BINDING_WGSL : '')
		.replace('{{FACET_DISCARD}}', faceted ? FACET_DISCARD_WGSL : '')
		.replace('{{FACET_BOUNDARY}}', faceted ? FACET_BOUNDARY_WGSL : '');

	const vertexBufferLayout: GPUVertexBufferLayout[] = [
		{
			arrayStride: 2 * 4, // 2 floats per vertex
			attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }]
		}
	];

	const baseDataBindingConfig = [
		{ binding: BINDINGS.DIM, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.TOP, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.BOTTOM, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.SERIES, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.COLOR, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{
			binding: BINDINGS.CONSTANTS,
			type: 'uniform',
			visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
		}
	];

	const dataBindingConfig = faceted
		? [
				...baseDataBindingConfig,
				{ binding: BINDINGS.FACET, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX }
			]
		: baseDataBindingConfig;

	// --- DATA WRITING EFFECTS ---

	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.DIM, dimData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.TOP, topData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.BOTTOM, bottomData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && seriesData)
			renderer.writeAttribute(BINDINGS.SERIES, seriesData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && colorValueData)
			renderer.writeAttribute(BINDINGS.COLOR, colorValueData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && facetData) renderer.writeAttribute(BINDINGS.FACET, facetData);
	});

	// Write uniforms when configuration changes
	$effect(() => {
		if (renderer?.resourcesCreated) {
			// Guard: skip uniform write when colorMode=1 but color data hasn't
			// arrived yet. colorValueData is tracked reactively so the effect
			// re-fires once data loads.
			if (colorMode === 1 && !colorValueData) return;

			const buffer = new ArrayBuffer(48);
			const view = new DataView(buffer);
			const LE = true;

			view.setUint32(UNIFORM_OFFSETS.POINT_COUNT, dimData ? dimData.length : 0, LE);
			view.setUint32(UNIFORM_OFFSETS.COLOR_MODE, colorMode, LE);
			view.setUint32(UNIFORM_OFFSETS.COLOR_SCALE_INDEX, colorScaleIndex, LE);
			view.setUint32(UNIFORM_OFFSETS.ORIENTATION, orientation === 'horizontal' ? 1 : 0, LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 0, constantColor[0], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 4, constantColor[1], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 8, constantColor[2], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 12, constantColor[3], LE);
			view.setFloat32(UNIFORM_OFFSETS.FILL_OPACITY, fillOpacity, LE);
			view.setFloat32(UNIFORM_OFFSETS.DOT_RADIUS, dotRadius, LE);
			view.setUint32(UNIFORM_OFFSETS.SHOW_BOTTOM_DOTS, showBottomDots ? 1 : 0, LE);
			view.setFloat32(UNIFORM_OFFSETS.FULL_DOMAIN_SPAN, fullDomainSpan, LE);

			renderer.writeUniform(BINDINGS.CONSTANTS, new Uint8Array(buffer));
		}
	});

	// Instance count = number of data points (last instance per series discards)
	$effect(() => {
		if (renderer?.resourcesCreated) {
			renderer.updateInstanceCount(dimData && dimData.length > 1 ? dimData.length : 0);
		}
	});

	// Facet layer registration (reactive — fires when FacetCells resolve)
	$effect(() => {
		if (!renderer?.resourcesCreated || !faceted) return;
		const ids = chartContext.facetChartIds;
		if (!ids?.length) return;
		renderer.registerFacetLayers(ids, drawAreas);
	});

	// Geometry: N sub-segment quads (6N vertices) + 2 dot circle quads (12 vertices).
	// Sub-segment quads: quadCorner.x = t value [0..1], .y = boundary {0=bottom, 1=top}
	// Circle quads: quadCorner = [-1..1] for SDF (top at 6N, bottom at 6N+6)
	function createAreaGeometry(res: number) {
		const verts = [];
		for (let i = 0; i < res; i++) {
			const tLeft = i / res;
			const tRight = (i + 1) / res;
			// prettier-ignore
			verts.push(
				tLeft, 0,   tRight, 0,   tLeft, 1,
				tRight, 0,  tRight, 1,   tLeft, 1
			);
		}
		// Top circle quad (vertices 6N to 6N+5)
		// prettier-ignore
		verts.push(
			-1, -1,   1, -1,  -1,  1,
			 1, -1,   1,  1,  -1,  1
		);
		// Bottom circle quad (vertices 6N+6 to 6N+11)
		// prettier-ignore
		verts.push(
			-1, -1,   1, -1,  -1,  1,
			 1, -1,   1,  1,  -1,  1
		);
		return new Float32Array(verts);
	}

	async function initializeGeometry() {
		const device = webGPUContext.getDevice();
		const areaVertices = createAreaGeometry(resolution);
		areaGeometryBuffer = device.createBuffer({
			size: areaVertices.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			label: `areas-geometry-${curve}`
		});
		device.queue.writeBuffer(areaGeometryBuffer, 0, areaVertices);
	}

	function drawAreas(passEncoder: GPURenderPassEncoder) {
		if (!areaGeometryBuffer || renderer.instanceCount === 0) return;
		passEncoder.setVertexBuffer(0, areaGeometryBuffer);
		passEncoder.draw(areaVertexCount, renderer.instanceCount);
	}

	onMount(() =>
		host.mount({
			init: {
				markShaderCode: areasShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition: areaRendererDefinition
			},
			async ready(r) {
				await initializeGeometry();

				// Non-faceted: register with the single chart canvas.
				// Faceted: registration handled by the reactive $effect above.
				if (!faceted) r.registerLayer(drawAreas);

				// Series and colour default to zeros until their data arrives.
				if (!seriesData && dimData)
					r.writeAttribute(BINDINGS.SERIES, new Float32Array(dimData.length));
				if (!colorValueData && dimData)
					r.writeAttribute(BINDINGS.COLOR, new Float32Array(dimData.length));
			}
		})
	);

	// Release retained renderer from a previous instance once this one has data
	$effect(() => {
		if (renderer?.resourcesCreated && markId) {
			gpuCoordinator?.releaseRetained(markId);
		}
	});

	onDestroy(() => {
		const r = renderer;
		const agb = areaGeometryBuffer;
		const retained =
			r &&
			markId &&
			gpuCoordinator?.retainRenderer(markId, {
				destroy() {
					agb?.destroy();
					r.destroy();
				}
			});
		if (retained) return;
		if (agb) agb.destroy();
		if (r) r.destroy();
	});
</script>

{#if initializationError}
	<div class="areas-error">{initializationError}</div>
{/if}
