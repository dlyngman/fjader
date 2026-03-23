<script lang="ts">
	import { getContext, onMount, onDestroy } from 'svelte';
	import { BaseGPURenderer } from './BaseGPURenderer.svelte';
	import { getGPUContext } from '$lib/gpu';
	import { getCurveWGSL, getCurveResolution } from '$lib/gpu/CurveShaderLib';
	import { DEFAULT_STROKE_COLOR } from '$lib/scales/color-utils';
	import type { ChartContext, CurveType, WebGPUCanvasContext } from '$lib/types';

	const MAX_AXES = 16;
	const UNIFORM_SIZE = 176; // bytes, must match WGSL struct layout

	// Both x and y so ScaleTemplateSystem generates scaleX(), scaleLinearY(), pixelsToClip()
	const rendererDefinition = {
		x: { concept: 'position', channels: ['x'] },
		y: { concept: 'position', channels: ['y'] }
	};

	const BINDINGS = {
		DATA: 0, // column-major packed storage buffer
		COLOR: 1, // per-row color values
		CONFIG: 2 // ParallelConfig uniform
	};

	interface Props {
		markId?: string;
		columnData: Record<string, Float32Array>;
		parallelColumns: string[];
		colorValueData?: Float32Array | null;
		colorMode?: number;
		colorScaleIndex?: number;
		constantColor?: [number, number, number, number];
		axisOrder: number[];
		axisScaleIndices: number[];
		strokeWidth?: number;
		opacity?: number;
		curve?: CurveType;
		rowCount: number;
		axisCount: number;
	}

	let {
		markId = '',
		columnData,
		parallelColumns,
		colorValueData = null,
		colorMode = 0,
		colorScaleIndex = 0,
		constantColor = DEFAULT_STROKE_COLOR,
		axisOrder,
		axisScaleIndices,
		strokeWidth = 2,
		opacity = 1,
		curve = 'linear',
		rowCount,
		axisCount
	}: Props = $props();

	const resolution = getCurveResolution(curve);
	const markType = curve === 'linear' ? 'parallel-lines' : `parallel-lines-${curve}`;

	const chartContext = getContext<ChartContext>('chart');
	const webGPUContext = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const gpuCoordinator = getGPUContext();

	let renderer = $state<BaseGPURenderer | null>(null);
	let initializationError = $state<string | null>(null);
	let quadGeometryBuffer: GPUBuffer;

	// (N-1) segments × resolution sub-quads × 6 verts + N circles × 6 verts
	const vertexCount = $derived((axisCount - 1) * 6 * resolution + axisCount * 6);

	// evaluateCurve() and CURVE_RESOLUTION are prepended from CurveShaderLib.
	// With linear (resolution=1): single quad per segment, identical to original.
	// With bump-x (resolution=128): smooth S-curves between axes, adaptive.
	function buildShaderCode() {
		return `
  ${getCurveWGSL(curve)}

  struct ParallelConfig {
    axisCount: u32,
    rowCount: u32,
    strokeWidth: f32,
    opacity: f32,
    colorMode: u32,
    colorScaleIndex: u32,
    _pad0: u32,
    _pad1: u32,
    constantColor: vec4<f32>,
    axisOrder: array<vec4<u32>, 4>,
    axisScaleIndices: array<vec4<u32>, 4>,
  };

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) colorValue: f32,
    @location(1) alpha: f32,
    @location(2) circleUV: vec2<f32>,
    @location(3) circleRadius: f32,
  };

  @group(1) @binding(0) var<storage, read> data: array<f32>;
  @group(1) @binding(1) var<storage, read> colorValues: array<f32>;
  @group(1) @binding(2) var<uniform> config: ParallelConfig;

  fn isNaN(v: f32) -> bool { return v != v; }
  const DISCARD_POS = vec4<f32>(2.0, 2.0, 2.0, 1.0);

  fn getAxisOrder(visualIdx: u32) -> u32 {
    return config.axisOrder[visualIdx / 4u][visualIdx % 4u];
  }

  fn getAxisScaleIndex(dataIdx: u32) -> u32 {
    return config.axisScaleIndices[dataIdx / 4u][dataIdx % 4u];
  }

  fn getColumnValue(colIdx: u32, rowIdx: u32) -> f32 {
    return data[colIdx * config.rowCount + rowIdx];
  }

  // Evenly space axes across the x range — bypasses x-scale domain entirely.
  fn axisXPosition(visualIdx: u32) -> f32 {
    let t = f32(visualIdx) / f32(config.axisCount - 1u);
    return frameUniforms.rangeMin.x + t * (frameUniforms.rangeMax.x - frameUniforms.rangeMin.x);
  }

  fn scaleForAxis(value: f32, dataAxisIdx: u32) -> f32 {
    return scaleLinearY(value, getAxisScaleIndex(dataAxisIdx));
  }

  // Get pixel position for an axis value, with NaN fallback to a reference point.
  fn axisPoint(visualIdx: u32, rowIdx: u32) -> vec2<f32> {
    let dataIdx = getAxisOrder(visualIdx);
    let value = getColumnValue(dataIdx, rowIdx);
    return vec2<f32>(axisXPosition(visualIdx), scaleForAxis(value, dataIdx));
  }

  @vertex
  fn vertexMain(
    @location(0) quadPosition: vec2<f32>,
    @builtin(instance_index) rowIdx: u32,
    @builtin(vertex_index) vertexIdx: u32,
  ) -> VertexOutput {
    let N = config.axisCount;
    let segmentVertexCount = (N - 1u) * CURVE_RESOLUTION * 6u;
    let halfWidth = config.strokeWidth * frameUniforms.devicePixelRatio * 0.5;

    if (rowIdx >= config.rowCount) {
      var output: VertexOutput;
      output.position = DISCARD_POS;
      return output;
    }

    // === JOIN CIRCLE (vertices segmentVertexCount .. end) ===
    if (vertexIdx >= segmentVertexCount) {
      let joinIdx = (vertexIdx - segmentVertexCount) / 6u;
      if (joinIdx >= N) {
        var output: VertexOutput;
        output.position = DISCARD_POS;
        return output;
      }

      let dataIdx = getAxisOrder(joinIdx);
      let value = getColumnValue(dataIdx, rowIdx);
      if (isNaN(value)) {
        var output: VertexOutput;
        output.position = DISCARD_POS;
        return output;
      }

      let center = vec2<f32>(axisXPosition(joinIdx), scaleForAxis(value, dataIdx));
      let pos = center + quadPosition * halfWidth * 1.2;

      var output: VertexOutput;
      output.position = pixelsToClip(pos);
      output.colorValue = colorValues[rowIdx];
      output.alpha = config.opacity;
      output.circleUV = quadPosition;
      output.circleRadius = halfWidth;
      return output;
    }

    // === LINE SEGMENT SUB-QUADS (vertices 0 .. segmentVertexCount-1) ===
    let totalSubSegIdx = vertexIdx / 6u;
    let segmentIdx = totalSubSegIdx / CURVE_RESOLUTION;
    let subSegIdx = totalSubSegIdx % CURVE_RESOLUTION;
    if (segmentIdx >= N - 1u) {
      var output: VertexOutput;
      output.position = DISCARD_POS;
      return output;
    }

    let leftDataIdx = getAxisOrder(segmentIdx);
    let rightDataIdx = getAxisOrder(segmentIdx + 1u);
    let leftValue = getColumnValue(leftDataIdx, rowIdx);
    let rightValue = getColumnValue(rightDataIdx, rowIdx);

    if (isNaN(leftValue) || isNaN(rightValue)) {
      var output: VertexOutput;
      output.position = DISCARD_POS;
      return output;
    }

    // 4 control points from neighboring axes (clamped at edges)
    let pCurr = vec2<f32>(axisXPosition(segmentIdx), scaleForAxis(leftValue, leftDataIdx));
    let pNext = vec2<f32>(axisXPosition(segmentIdx + 1u), scaleForAxis(rightValue, rightDataIdx));
    let pPrev = select(axisPoint(segmentIdx - 1u, rowIdx), pCurr, segmentIdx == 0u);
    let pAfter = select(axisPoint(segmentIdx + 2u, rowIdx), pNext, segmentIdx + 2u >= N);

    // Adaptive resolution: more sub-segments for longer pixel spans.
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

    // Sub-segment t values
    let subSegSize = 1.0 / f32(effectiveRes);
    let tLeft = f32(subSegIdx) * subSegSize;
    let tRight = tLeft + subSegSize;

    // Evaluate curve at sub-segment endpoints for tangent direction
    let pLeft = evaluateCurve(pPrev, pCurr, pNext, pAfter, tLeft);
    let pRight = evaluateCurve(pPrev, pCurr, pNext, pAfter, tRight);

    let segDir = pRight - pLeft;
    let segLen = length(segDir);
    if (segLen < 0.001) {
      var output: VertexOutput;
      output.position = DISCARD_POS;
      return output;
    }

    let tangent = segDir / segLen;
    let normal = vec2<f32>(-tangent.y, tangent.x);
    let side = quadPosition.y;

    // Position vertex on curve with perpendicular expansion
    let localVert = vertexIdx % 6u;
    let isRight = localVert == 1u || localVert == 3u || localVert == 4u;
    let t = select(tLeft, tRight, isRight);
    let curvePos = evaluateCurve(pPrev, pCurr, pNext, pAfter, t);
    let finalPos = curvePos + normal * side * halfWidth;

    var output: VertexOutput;
    output.position = pixelsToClip(finalPos);
    output.colorValue = colorValues[rowIdx];
    output.alpha = config.opacity;
    output.circleUV = vec2<f32>(-2.0, -2.0);
    output.circleRadius = 0.0;
    return output;
  }

  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    var baseColor: vec4<f32>;
    if (config.colorMode == 0u) {
      baseColor = config.constantColor;
    } else {
      baseColor = getColorFromScale(
        config.colorScaleIndex,
        input.colorValue,
        frameUniforms.nullColor
      );
    }

    var finalAlpha = baseColor.a * input.alpha;

    // Circle SDF: circleUV is (-2,-2) for line fragments, (-1..1) for circles
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

	const shaderCode = buildShaderCode();

	const vertexBufferLayout: GPUVertexBufferLayout[] = [
		{
			arrayStride: 2 * 4,
			attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }]
		}
	];

	const dataBindingConfig = [
		{ binding: BINDINGS.DATA, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.COLOR, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{
			binding: BINDINGS.CONFIG,
			type: 'uniform',
			visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
		}
	];

	// --- Data upload: pack all columns into single column-major buffer ---
	$effect(() => {
		if (!renderer?.resourcesCreated || !columnData || !rowCount) return;
		const totalFloats = axisCount * rowCount;
		const packed = new Float32Array(totalFloats);
		for (let colIdx = 0; colIdx < parallelColumns.length; colIdx++) {
			const colData = columnData[parallelColumns[colIdx]];
			if (colData) packed.set(colData, colIdx * rowCount);
		}
		renderer.writeAttribute(BINDINGS.DATA, packed);
	});

	// --- Color data upload ---
	$effect(() => {
		if (!renderer?.resourcesCreated || !colorValueData)
			return;
		renderer.writeAttribute(BINDINGS.COLOR, colorValueData);
	});

	// --- Uniform upload ---
	$effect(() => {
		if (!renderer?.resourcesCreated) return;
		if (colorMode === 1 && !colorValueData) return;

		const buffer = new ArrayBuffer(UNIFORM_SIZE);
		const f32 = new Float32Array(buffer);
		const u32 = new Uint32Array(buffer);

		u32[0] = axisCount;
		u32[1] = rowCount;
		f32[2] = strokeWidth;
		f32[3] = opacity;
		u32[4] = colorMode;
		u32[5] = colorScaleIndex;
		// u32[6], u32[7] = padding
		f32[8] = constantColor[0];
		f32[9] = constantColor[1];
		f32[10] = constantColor[2];
		f32[11] = constantColor[3];

		// axisOrder: offset 48 = u32 index 12
		for (let i = 0; i < MAX_AXES; i++) {
			u32[12 + i] = i < axisOrder.length ? axisOrder[i] : 0;
		}
		// axisScaleIndices: offset 112 = u32 index 28
		for (let i = 0; i < MAX_AXES; i++) {
			u32[28 + i] = i < axisScaleIndices.length ? axisScaleIndices[i] : 0;
		}

		renderer.writeUniform(BINDINGS.CONFIG, new Uint8Array(buffer));
	});

	// --- Instance count ---
	$effect(() => {
		if (renderer?.resourcesCreated && rowCount > 0) {
			renderer.updateInstanceCount(rowCount);
		}
	});

	// --- Geometry buffer ---
	function createParallelGeometry(N: number, res: number): Float32Array {
		const verts: number[] = [];
		// Segment sub-quads: (N-1) segments × res sub-quads, 6 vertices each.
		// quadPosition.y (-1/1) is used for perpendicular expansion.
		// quadPosition.x isn't used — shader computes t from vertexIdx.
		for (let s = 0; s < N - 1; s++) {
			for (let r = 0; r < res; r++) {
				// prettier-ignore
				verts.push(
					0, -1,  1, -1,  0,  1,
					1, -1,  1,  1,  0,  1
				);
			}
		}
		// Join circles: N circles, 6 vertices each
		for (let j = 0; j < N; j++) {
			// prettier-ignore
			verts.push(
				-1, -1,   1, -1,  -1,  1,
				 1, -1,   1,  1,  -1,  1
			);
		}
		return new Float32Array(verts);
	}

	function drawParallelLines(passEncoder: GPURenderPassEncoder) {
		if (!quadGeometryBuffer || !renderer || renderer.instanceCount === 0) return;
		passEncoder.setVertexBuffer(0, quadGeometryBuffer);
		passEncoder.draw(vertexCount, renderer.instanceCount);
	}

	async function initializeRenderer() {
		try {
			renderer = new BaseGPURenderer(markType, webGPUContext, gpuCoordinator, chartContext, {
				zIndex: 0,
				xScaleType: chartContext.scaleTypes?.x || 'linear',
				yScaleType: 'linear'
			});

			await renderer.initialize({
				markShaderCode: shaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition
			});

			// Create geometry buffer
			const device = webGPUContext.getDevice();
			const quadVertices = createParallelGeometry(axisCount, resolution);
			quadGeometryBuffer = device.createBuffer({
				size: quadVertices.byteLength,
				usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
				label: 'parallel-lines-geometry'
			});
			device.queue.writeBuffer(quadGeometryBuffer, 0, quadVertices as Float32Array<ArrayBuffer>);

			renderer.registerLayer(drawParallelLines);

			// Initialize color buffer with zeros if not provided
			if (!colorValueData && rowCount > 0) {
				renderer.writeAttribute(BINDINGS.COLOR, new Float32Array(rowCount));
			}
		} catch (error) {
			console.error('ParallelLines init failed:', error);
			initializationError = (error as Error).message;
		}
	}

	async function waitForWebGPU() {
		let attempts = 0;
		while (!webGPUContext.isInitialized() && attempts < 100) {
			await new Promise((r) => setTimeout(r, 50));
			attempts++;
		}
		if (webGPUContext.isInitialized()) await initializeRenderer();
	}

	onMount(() => waitForWebGPU());

	$effect(() => {
		if (renderer?.resourcesCreated && markId) {
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
					qgb?.destroy();
					r.destroy();
				}
			});
		if (retained) return;
		if (qgb) qgb.destroy();
		if (r) r.destroy();
	});
</script>

{#if initializationError}
	<div class="parallel-lines-error">{initializationError}</div>
{/if}
