<script lang="ts">
	import { activityReads, connectedActivityWGSL } from './activity-reads';
	import { UNIFORM_BYTES } from './uniform-sizes';
	import { getContext, onMount, onDestroy } from 'svelte';
	import { RendererHost } from './RendererHost.svelte';
	import { getGPUContext } from '$lib/gpu';
	import { getCurveWGSL, getCurveResolution } from '$lib/gpu/CurveShaderLib';
	import { NAN_WGSL } from '$lib/gpu/NanShaderLib';
	import { DEFAULT_STROKE_COLOR } from '$lib/scales/color-utils';
	import type { ChartContext, WebGPUCanvasContext, CurveType } from '$lib/types';
	import type { M4Decimator } from '$lib/gpu/decimation/M4Decimator.svelte';

	// Lines uses projectToPixels() directly, so we don't need placeholder replacement.
	// We still define x/y so that scaleX/scaleY functions are generated.
	const lineRendererDefinition = {
		x: { concept: 'position', channels: ['x'] },
		y: { concept: 'position', channels: ['y'] }
		// No placeholders - Lines calls projectToPixels() which uses scaleX/scaleY internally
	};

	const BINDINGS = {
		X: 0,
		Y: 1,
		SERIES: 2,
		COLOR: 3,
		CONSTANTS: 4,
		FACET: 5
	};

	// Uniform struct offsets (matching WGSL MarkConstants; size in uniform-sizes.ts)
	const UNIFORM_OFFSETS = {
		STROKE_WIDTH: 0, // f32
		POINT_COUNT: 4, // u32
		COLOR_MODE: 8, // u32
		COLOR_SCALE_INDEX: 12, // u32
		CONSTANT_COLOR: 16, // vec4<f32>
		DOT_RADIUS: 32, // f32
		GLOBAL_ALPHA: 36, // f32
		GROUP_INDEX: 40, // u32
		ACTIVITY_COLOR_MODE: 44, // u32
		ACTIVITY_COLOR_SCALE_INDEX: 48, // u32
		ACTIVITY_SERIES_MODE: 52, // u32
		ACTIVITY_SERIES_SCALE_INDEX: 56 // u32
	};

	interface Props {
		xData: Float32Array;
		yData: Float32Array;
		seriesData?: Float32Array | null;
		colorValueData?: Float32Array | null;
		facetData?: Float32Array | null;
		dataVersion?: number;
		zIndex?: number;
		curve?: CurveType;
		strokeWidth?: number;
		dotRadius?: number;
		colorMode?: number;
		colorScaleIndex?: number;
		/** The page-wide index of this mark's filter group: which run of a field's activity block it reads. */
		groupIndex?: number;
		/**
		 * The colour mode and scale index selection activity is read through,
		 * from `colorValueData`; null for the line's own colour. An area's
		 * outline in a constant stroke passes its fill's, with the fill's values.
		 */
		activityColorMode?: number | null;
		activityColorScaleIndex?: number | null;
		/**
		 * The series scale selection activity is also read through, from
		 * `seriesData`: mode 1 and its index when the mark groups by a `z` of
		 * its own, mode 0 (no read) otherwise. MarkSeries decides.
		 */
		activitySeriesMode?: number;
		activitySeriesScaleIndex?: number;
		constantColor?: [number, number, number, number];
		m4Decimator?: M4Decimator | null;
		dotsRung?: import('$lib/lod/DotsRung.svelte').DotsRung | null;
		globalAlpha?: number;
		markId?: string;
	}

	let {
		xData,
		yData,
		seriesData = null,
		colorValueData = null,
		facetData = null,
		dataVersion = 0,
		zIndex = 0,
		curve = 'linear',
		strokeWidth = 2,
		dotRadius = 0,
		colorMode = 0,
		colorScaleIndex = 0,
		groupIndex = 0,
		activityColorMode = null,
		activityColorScaleIndex = null,
		activitySeriesMode = 0,
		activitySeriesScaleIndex = 0,
		constantColor = DEFAULT_STROKE_COLOR,
		m4Decimator = null,
		dotsRung = null,
		globalAlpha = 1.0,
		markId = ''
	}: Props = $props();

	const chartContext = getContext<ChartContext>('chart');
	const webGPUContext = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const gpuCoordinator = getGPUContext();
	const faceted = !!chartContext.fx;
	const baseMarkType = curve === 'linear' ? 'lines' : `lines-${curve}`;
	const effectiveMarkType = faceted ? `${baseMarkType}-faceted` : baseMarkType;

	/** The selection activity this shader reads; routing reads the same table. */
	const ACTIVITY_READS = activityReads('lines');

	// --- Facet compile-time specialization ---
	// Lines uses a storage buffer (not a vertex attribute) for facet indices because
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
		label: 'Lines'
	});
	const renderer = $derived(host.renderer);
	const initializationError = $derived(host.error);
	let quadGeometryBuffer: GPUBuffer;
	const m4ComputeKey = `m4-${crypto.randomUUID()}`;

	// Resolution and vertex count derived from curve type
	const resolution = getCurveResolution(curve);
	const quadVertexCount = 6 * resolution + 6; // 6N segment + 6 circle
	// Pipeline variant key includes curve type for separate shader compilation
	// Line shader: sub-segment quads + round join circles at data points.
	// evaluateCurve() and CURVE_RESOLUTION are prepended from CurveShaderLib.
	// With linear (resolution=1): single quad per segment, identical to original.
	// With step (resolution=2): two quads capture horizontal+vertical transition.
	// With catmull-rom (resolution=16): smooth cubic approximation.
	function buildShaderCode() {
		return `
  ${getCurveWGSL(curve)}

  struct MarkConstants {
    strokeWidth: f32,
    pointCount: u32,
    colorMode: u32,
    colorScaleIndex: u32,
    constantColor: vec4<f32>,
    dotRadius: f32,
    globalAlpha: f32,
    groupIndex: u32, // Page-wide filter group index, for activity reads
    // Which colour scale this line's selection activity is read through. Its
    // own colour by default; an area's outline, drawn in a constant stroke,
    // reads its fill's so it dims with the fill.
    activityColorMode: u32,
    activityColorScaleIndex: u32,
    // The series scale it is also read through, for a z of its own; mode 0
    // reads nothing.
    activitySeriesMode: u32,
    activitySeriesScaleIndex: u32
  };
  @group(1) @binding(4) var<uniform> markConstants: MarkConstants;

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) colorValue: f32,
    @location(1) alpha: f32,
    @location(2) circleUV: vec2<f32>,
    @location(3) circleRadius: f32
  };

  @group(1) @binding(0) var<storage, read> xValues: array<f32>;
  @group(1) @binding(1) var<storage, read> yValues: array<f32>;
  @group(1) @binding(2) var<storage, read> seriesValues: array<f32>;
  @group(1) @binding(3) var<storage, read> colorValues: array<f32>;
  {{FACET_BINDING}}

  ${NAN_WGSL}

  const DISCARD_POS = vec4<f32>(2.0, 2.0, 2.0, 1.0);

  @vertex
  fn vertexMain(
    @location(0) quadPosition: vec2<f32>,
    @builtin(instance_index) instanceIdx: u32,
    @builtin(vertex_index) vertexIdx: u32
  ) -> VertexOutput {
    {{FACET_DISCARD}}
    let pointCount = markConstants.pointCount;
    let halfWidth = markConstants.strokeWidth * frameUniforms.devicePixelRatio * 0.5;
    let isCircle = vertexIdx >= CURVE_RESOLUTION * 6u;

    // === ROUND JOIN CIRCLE (vertices 6N .. 6N+5) ===
    if (isCircle) {
      if (instanceIdx >= pointCount) {
        var output: VertexOutput;
        output.position = DISCARD_POS;
        return output;
      }
      let x = xValues[instanceIdx];
      let y = yValues[instanceIdx];
      if (isNaN(x) || isNaN(y)) {
        var output: VertexOutput;
        output.position = DISCARD_POS;
        return output;
      }
      let center = projectToPixels(vec2<f32>(x, y));

      // JS computes dotRadius via DotsRung. 0 = no dots. >0 = show at this size.
      let circleR = select(halfWidth, markConstants.dotRadius * frameUniforms.devicePixelRatio,
        markConstants.dotRadius > 0.0);
      let pos = center + quadPosition * circleR * 1.2;

      var output: VertexOutput;
      output.position = pixelsToClip(pos);
      output.colorValue = colorValues[instanceIdx];
      output.alpha = markConstants.globalAlpha * selectionDim(
        ${connectedActivityWGSL(ACTIVITY_READS, {
					color:
						'markConstants.activityColorMode, markConstants.activityColorScaleIndex, colorValues[instanceIdx]',
					series:
						'markConstants.activitySeriesMode, markConstants.activitySeriesScaleIndex, seriesValues[instanceIdx]',
					group: 'markConstants.groupIndex'
				})}
      );
      output.circleUV = quadPosition;
      output.circleRadius = circleR;
      return output;
    }

    // === LINE SEGMENT SUB-QUADS (vertices 0 .. 6N-1) ===
    let currIdx = instanceIdx;
    let nextIdx = instanceIdx + 1u;

    if (nextIdx >= pointCount) {
      var output: VertexOutput;
      output.position = DISCARD_POS;
      return output;
    }
    {{FACET_BOUNDARY}}

    let xCurr = xValues[currIdx];
    let yCurr = yValues[currIdx];
    let xNext = xValues[nextIdx];
    let yNext = yValues[nextIdx];
    let seriesCurr = seriesValues[currIdx];
    let seriesNext = seriesValues[nextIdx];

    if (seriesCurr != seriesNext || isNaN(xCurr) || isNaN(yCurr) || isNaN(xNext) || isNaN(yNext)) {
      var output: VertexOutput;
      output.position = DISCARD_POS;
      return output;
    }

    // Project segment endpoints to pixel space
    let pCurr = projectToPixels(vec2<f32>(xCurr, yCurr));
    let pNext = projectToPixels(vec2<f32>(xNext, yNext));

    // Adaptive sub-segment resolution: more segments for longer pixel spans.
    // Fixed-resolution curves (linear, step) have CURVE_RESOLUTION <= 3;
    // smooth curves (catmull-rom, monotone) adapt up to CURVE_RESOLUTION.
    let subSegIdx = vertexIdx / 6u;
    var effectiveRes: u32;
    if (CURVE_RESOLUTION > 3u) {
      let chordPixelLen = length(pNext - pCurr);
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

    // Project neighbor control points
    let pPrev = projectToPixels(vec2<f32>(xValues[prevIdx], yValues[prevIdx]));
    let pAfter = projectToPixels(vec2<f32>(xValues[afterIdx], yValues[afterIdx]));

    // Compute t values from effective resolution (not geometry buffer)
    let subSegSize = 1.0 / f32(effectiveRes);
    let tLeft = f32(subSegIdx) * subSegSize;
    let tRight = tLeft + subSegSize;

    // Evaluate curve at sub-segment endpoints for tangent direction
    let pLeft = evaluateCurve(pPrev, pCurr, pNext, pAfter, tLeft);
    let pRight = evaluateCurve(pPrev, pCurr, pNext, pAfter, tRight);

    let segmentDir = pRight - pLeft;
    let segmentLen = length(segmentDir);

    if (segmentLen < 0.001) {
      var output: VertexOutput;
      output.position = DISCARD_POS;
      return output;
    }

    // Constant tangent per sub-segment for clean perpendicular expansion
    let tangent = segmentDir / segmentLen;
    let normal = vec2<f32>(-tangent.y, tangent.x);
    let side = quadPosition.y;

    // Compute t for this vertex from vertex index (adaptive-resolution aware)
    let localVert = vertexIdx % 6u;
    let isRight = localVert == 1u || localVert == 3u || localVert == 4u;
    let t = select(tLeft, tRight, isRight);
    let curvePos = evaluateCurve(pPrev, pCurr, pNext, pAfter, t);
    let finalPos = curvePos + normal * side * halfWidth;

    var output: VertexOutput;
    output.position = pixelsToClip(finalPos);
    output.colorValue = colorValues[currIdx];
    output.alpha = markConstants.globalAlpha * selectionDim(
      ${connectedActivityWGSL(ACTIVITY_READS, {
				color:
					'markConstants.activityColorMode, markConstants.activityColorScaleIndex, colorValues[currIdx]',
				series:
					'markConstants.activitySeriesMode, markConstants.activitySeriesScaleIndex, seriesValues[currIdx]',
				group: 'markConstants.groupIndex'
			})}
    );
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

    // Circle SDF: circleUV is (-2,-2) for line fragments, (-1..1) for circles
    if (input.circleUV.x > -1.5) {
      let dist = length(input.circleUV);
      // Pixel-accurate AA matching Dots renderer
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

	const linesShaderCode = buildShaderCode()
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
		{ binding: BINDINGS.X, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.Y, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
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

	// --- WRITING EFFECTS ---

	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.X, xData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.Y, yData);
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
			const activityMode = activityColorMode ?? colorMode;
			const activityScale = activityColorScaleIndex ?? colorScaleIndex;
			if ((colorMode === 1 || activityMode === 1) && !colorValueData) return;

			const buffer = new ArrayBuffer(UNIFORM_BYTES.linesMarkConstants);
			const view = new DataView(buffer);
			const LE = true;

			const rawCount = xData ? xData.length : 0;
			// With drawIndirect, GPU controls instance count. pointCount in MarkConstants
			// is used for bounds checking only — set to max of both modes.
			const pointCount = m4Decimator?.configured
				? Math.max(m4Decimator.outputSize, rawCount)
				: rawCount;
			view.setFloat32(UNIFORM_OFFSETS.STROKE_WIDTH, strokeWidth, LE);
			view.setUint32(UNIFORM_OFFSETS.POINT_COUNT, pointCount, LE);
			view.setUint32(UNIFORM_OFFSETS.COLOR_MODE, colorMode, LE);
			view.setUint32(UNIFORM_OFFSETS.COLOR_SCALE_INDEX, colorScaleIndex, LE);
			view.setUint32(UNIFORM_OFFSETS.GROUP_INDEX, groupIndex, LE);
			view.setUint32(UNIFORM_OFFSETS.ACTIVITY_COLOR_MODE, activityMode, LE);
			view.setUint32(UNIFORM_OFFSETS.ACTIVITY_COLOR_SCALE_INDEX, activityScale, LE);
			view.setUint32(UNIFORM_OFFSETS.ACTIVITY_SERIES_MODE, activitySeriesMode, LE);
			view.setUint32(UNIFORM_OFFSETS.ACTIVITY_SERIES_SCALE_INDEX, activitySeriesScaleIndex, LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 0, constantColor[0], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 4, constantColor[1], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 8, constantColor[2], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 12, constantColor[3], LE);
			view.setFloat32(UNIFORM_OFFSETS.DOT_RADIUS, dotRadius, LE);
			view.setFloat32(UNIFORM_OFFSETS.GLOBAL_ALPHA, globalAlpha, LE);

			renderer.writeUniform(BINDINGS.CONSTANTS, new Uint8Array(buffer));

			// Rebuild M4 render bind group (references current output buffers + markConstants)
			if (m4Decimator?.configured) {
				const perDataLayout = renderer.pipeline.getBindGroupLayout(1);
				const markConstantsBuffer = renderer.getBuffer(BINDINGS.CONSTANTS);
				if (perDataLayout && markConstantsBuffer) {
					m4Decimator.createRenderBindGroup(perDataLayout, markConstantsBuffer);
				}
			}
		}
	});

	// Wire DotsRung render target — lets it write dotRadius directly to GPU buffer
	$effect(() => {
		if (!dotsRung || !renderer?.resourcesCreated) {
			dotsRung?.clearRenderTarget();
			return;
		}

		const constantsBuffer = renderer.getBuffer(BINDINGS.CONSTANTS);
		const device = gpuCoordinator?.device;
		if (!constantsBuffer || !device) return;

		const r = renderer; // capture for closure
		const f32Buf = new Float32Array(1); // pre-allocated, reused per frame
		dotsRung.setRenderTarget(
			(radius: number) => {
				f32Buf[0] = radius;
				device.queue.writeBuffer(constantsBuffer, UNIFORM_OFFSETS.DOT_RADIUS, f32Buf);
			},
			() => r.invalidateLayer()
		);

		return () => dotsRung?.clearRenderTarget();
	});

	// Instance count — with drawIndirect the GPU controls the actual count,
	// but we still set a CPU-side value so the renderer.instanceCount === 0 guard works.
	$effect(() => {
		if (renderer?.resourcesCreated) {
			if (xData && xData.length > 1) {
				const count = m4Decimator?.configured
					? Math.max(m4Decimator.outputSize, xData.length)
					: xData.length;
				renderer.updateInstanceCount(count);
			} else {
				renderer.updateInstanceCount(0);
			}
		}
	});

	// M4 compute work: register/unregister with GPUCoordinator
	$effect(() => {
		if (!renderer?.resourcesCreated || !m4Decimator?.configured) {
			gpuCoordinator.removeComputeWork(m4ComputeKey);
			return;
		}

		// Ensure decimator knows the vertex count for drawIndirect
		m4Decimator.setVertexCount(quadVertexCount);

		const chartId = chartContext.chartId;
		gpuCoordinator.registerComputeWork(
			m4ComputeKey,
			(commandEncoder) => {
				const xBuf = renderer.getBuffer(BINDINGS.X);
				const yBuf = renderer.getBuffer(BINDINGS.Y);
				const seriesBuf = renderer.getBuffer(BINDINGS.SERIES);
				const colorBuf = renderer.getBuffer(BINDINGS.COLOR);

				if (!xBuf || !yBuf || !seriesBuf || !colorBuf) return;

				m4Decimator.encode(
					commandEncoder,
					{ x: xBuf, y: yBuf, series: seriesBuf, color: colorBuf },
					xData?.length ?? 0
				);
			},
			// Only this chart reads the decimated output; M4 is never on a facet grid.
			chartId
		);

		return () => {
			gpuCoordinator.removeComputeWork(m4ComputeKey);
		};
	});

	// Facet layer registration (reactive — fires when FacetCells resolve)
	$effect(() => {
		if (!renderer?.resourcesCreated || !faceted) return;
		const ids = chartContext.facetChartIds;
		if (!ids?.length) return;
		renderer.registerFacetLayers(ids, drawLines);
	});

	// Geometry: N sub-segment quads (6N vertices) + 1 join circle quad (6 vertices).
	// Sub-segment quads: quadPosition.x = t value [0..1], .y = side {-1, 1}
	// Circle quad: quadPosition = [-1..1] for SDF
	function createLineGeometry(res: number) {
		const verts = [];
		for (let i = 0; i < res; i++) {
			const tLeft = i / res;
			const tRight = (i + 1) / res;
			// prettier-ignore
			verts.push(
				tLeft, -1,  tRight, -1,  tLeft,  1,
				tRight, -1, tRight,  1,  tLeft,  1
			);
		}
		// Circle quad (vertices 6N to 6N+5): x,y = local position for SDF
		// prettier-ignore
		verts.push(
			-1, -1,   1, -1,  -1,  1,
			 1, -1,   1,  1,  -1,  1
		);
		return new Float32Array(verts);
	}

	async function initializeGeometry() {
		const device = webGPUContext.getDevice();
		const quadVertices = createLineGeometry(resolution);
		quadGeometryBuffer = device.createBuffer({
			size: quadVertices.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			label: `lines-geometry-${curve}`
		});
		device.queue.writeBuffer(quadGeometryBuffer, 0, quadVertices);
	}

	function drawLines(passEncoder: GPURenderPassEncoder) {
		if (!quadGeometryBuffer || renderer.instanceCount === 0) return;
		if (m4Decimator?.renderBindGroup) {
			passEncoder.setBindGroup(1, m4Decimator.renderBindGroup);
		}
		passEncoder.setVertexBuffer(0, quadGeometryBuffer);
		if (m4Decimator?.indirectBuffer) {
			passEncoder.drawIndirect(m4Decimator.indirectBuffer, 0);
		} else {
			passEncoder.draw(quadVertexCount, renderer.instanceCount);
		}
	}

	onMount(() =>
		host.mount({
			init: {
				markShaderCode: linesShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition: lineRendererDefinition
			},
			async ready(r) {
				await initializeGeometry();

				// Non-faceted: register with the single chart canvas.
				// Faceted: registration handled by the reactive $effect above.
				if (!faceted) r.registerLayer(drawLines);

				// Series and colour default to zeros until their data arrives.
				if (!seriesData && xData) r.writeAttribute(BINDINGS.SERIES, new Float32Array(xData.length));
				if (!colorValueData && xData)
					r.writeAttribute(BINDINGS.COLOR, new Float32Array(xData.length));

				// Tell M4 the vertex count for drawIndirect.
				m4Decimator?.setVertexCount(quadVertexCount);
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
		const qgb = quadGeometryBuffer;
		const key = m4ComputeKey;
		const retained =
			r &&
			markId &&
			gpuCoordinator?.retainRenderer(markId, {
				destroy() {
					gpuCoordinator.removeComputeWork(key);
					qgb?.destroy();
					r.destroy();
				}
			});
		if (retained) return;
		gpuCoordinator.removeComputeWork(m4ComputeKey);
		if (qgb) qgb.destroy();
		if (r) r.destroy();
	});
</script>

{#if initializationError}
	<div class="lines-error">{initializationError}</div>
{/if}
