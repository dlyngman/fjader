<script>
	import { getContext, onMount, onDestroy } from 'svelte';
	import { BaseGPURenderer } from './BaseGPURenderer.svelte.js';
	import { getGPUContext } from '$lib/gpu';
	import { getCurveWGSL, getCurveResolution } from '$lib/gpu/CurveShaderLib.js';

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
		CONSTANTS: 4
	};

	// Uniform struct offsets (matching WGSL MarkConstants layout, 48 bytes)
	const UNIFORM_OFFSETS = {
		STROKE_WIDTH: 0, // f32
		POINT_COUNT: 4, // u32
		COLOR_MODE: 8, // u32
		COLOR_SCALE_INDEX: 12, // u32
		CONSTANT_COLOR: 16, // vec4<f32>
		DOT_RADIUS: 32 // f32
	};

	let {
		xData,
		yData,
		seriesData = null,
		colorValueData = null,
		dataVersion = 0,
		zIndex = 0,
		curve = 'linear',
		strokeWidth = 2,
		dotRadius = 0, // 0 = strokeWidth/2 (gap-filling only), >0 = explicit radius in px
		colorMode = 0, // 0 = constant, 1 = scale
		colorScaleIndex = 0,
		constantColor = [0.13, 0.55, 0.13, 1.0]
	} = $props();

	const chartContext = getContext('chart');
	const webGPUContext = getContext('webgpu-canvas');
	const gpuCoordinator = getGPUContext();

	let renderer = $state(null);
	let initializationError = $state(null);
	let quadGeometryBuffer;

	// Resolution and vertex count derived from curve type
	const resolution = getCurveResolution(curve);
	const quadVertexCount = 6 * resolution + 6; // 6N segment + 6 circle
	// Pipeline variant key includes curve type for separate shader compilation
	const effectiveMarkType = curve === 'linear' ? 'lines' : `lines-${curve}`;

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
    dotRadius: f32
  };
  @group(1) @binding(4) var<uniform> markConstants: MarkConstants;

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) colorValue: f32,
    @location(1) alpha: f32,
    @location(2) circleUV: vec2<f32>
  };

  @group(1) @binding(0) var<storage, read> xValues: array<f32>;
  @group(1) @binding(1) var<storage, read> yValues: array<f32>;
  @group(1) @binding(2) var<storage, read> seriesValues: array<f32>;
  @group(1) @binding(3) var<storage, read> colorValues: array<f32>;

  fn isNaN(v: f32) -> bool {
    return v != v;
  }

  const DISCARD_POS = vec4<f32>(2.0, 2.0, 2.0, 1.0);

  @vertex
  fn vertexMain(
    @location(0) quadPosition: vec2<f32>,
    @builtin(instance_index) instanceIdx: u32,
    @builtin(vertex_index) vertexIdx: u32
  ) -> VertexOutput {
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
      let circleR = select(halfWidth, markConstants.dotRadius * frameUniforms.devicePixelRatio, markConstants.dotRadius > 0.0);
      let pos = center + quadPosition * circleR * 1.2;

      var output: VertexOutput;
      output.position = pixelsToClip(pos);
      output.colorValue = colorValues[instanceIdx];
      output.alpha = 1.0;
      output.circleUV = quadPosition;
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
    output.alpha = 1.0;
    output.circleUV = vec2<f32>(-2.0, -2.0);
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
      let circleR = select(
        markConstants.strokeWidth * frameUniforms.devicePixelRatio * 0.5,
        markConstants.dotRadius * frameUniforms.devicePixelRatio,
        markConstants.dotRadius > 0.0
      );
      let pixelSize = frameUniforms.devicePixelRatio / (circleR * 2.0);
      let circleAlpha = 1.0 - smoothstep(-pixelSize, pixelSize, sdf);
      finalAlpha *= circleAlpha;
      if (finalAlpha < 0.01) { discard; }
    }

    return vec4<f32>(baseColor.rgb * finalAlpha, finalAlpha);
  }
  `;
	}

	const linesShaderCode = buildShaderCode();

	const vertexBufferLayout = [
		{
			arrayStride: 2 * 4, // 2 floats per vertex
			attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }]
		}
	];

	const dataBindingConfig = [
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

	// Write uniforms when configuration changes
	$effect(() => {
		if (renderer?.resourcesCreated) {
			const buffer = new ArrayBuffer(48);
			const view = new DataView(buffer);
			const LE = true;

			view.setFloat32(UNIFORM_OFFSETS.STROKE_WIDTH, strokeWidth, LE);
			view.setUint32(UNIFORM_OFFSETS.POINT_COUNT, xData ? xData.length : 0, LE);
			view.setUint32(UNIFORM_OFFSETS.COLOR_MODE, colorMode, LE);
			view.setUint32(UNIFORM_OFFSETS.COLOR_SCALE_INDEX, colorScaleIndex, LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 0, constantColor[0], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 4, constantColor[1], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 8, constantColor[2], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 12, constantColor[3], LE);
			view.setFloat32(UNIFORM_OFFSETS.DOT_RADIUS, dotRadius, LE);

			renderer.writeUniform(BINDINGS.CONSTANTS, new Uint8Array(buffer));
		}
	});

	// Instance count = number of points (segments use pairs, circles use each point)
	$effect(() => {
		if (renderer?.resourcesCreated && xData && xData.length > 1) {
			renderer.updateInstanceCount(xData.length);
		}
	});

	// Geometry: N sub-segment quads (6N vertices) + 1 join circle quad (6 vertices).
	// Sub-segment quads: quadPosition.x = t value [0..1], .y = side {-1, 1}
	// Circle quad: quadPosition = [-1..1] for SDF
	function createLineGeometry(res) {
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

	function drawLines(passEncoder) {
		if (!quadGeometryBuffer || renderer.instanceCount === 0) return;
		passEncoder.setVertexBuffer(0, quadGeometryBuffer);
		passEncoder.draw(quadVertexCount, renderer.instanceCount);
	}

	async function initializeLines() {
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
				markShaderCode: linesShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition: lineRendererDefinition
			});

			await initializeGeometry();
			renderer.registerLayer(drawLines);

			// Initialize series buffer with zeros if not provided
			if (!seriesData && xData) {
				const defaultSeries = new Float32Array(xData.length);
				renderer.writeAttribute(BINDINGS.SERIES, defaultSeries);
			}

			// Initialize color buffer with zeros if not provided
			if (!colorValueData && xData) {
				const defaultColor = new Float32Array(xData.length);
				renderer.writeAttribute(BINDINGS.COLOR, defaultColor);
			}
		} catch (error) {
			console.error('Lines init failed:', error);
			initializationError = error.message;
		}
	}

	async function waitForWebGPU() {
		let attempts = 0;
		while (!webGPUContext.isInitialized() && attempts < 100) {
			await new Promise((r) => setTimeout(r, 50));
			attempts++;
		}
		if (webGPUContext.isInitialized()) await initializeLines();
	}

	onMount(() => waitForWebGPU());

	onDestroy(() => {
		if (quadGeometryBuffer) quadGeometryBuffer.destroy();
		if (renderer) renderer.destroy();
	});
</script>

{#if initializationError}
	<div class="lines-error">{initializationError}</div>
{/if}
