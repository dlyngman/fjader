<script>
	import { getContext, onMount, onDestroy } from 'svelte';
	import { BaseGPURenderer } from './BaseGPURenderer.svelte.js';
	import { getGPUContext } from '$lib/gpu';
	import { CURVE_LINEAR } from '$lib/gpu/CurveShaderLib.js';

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
		CONSTANTS: 5
	};

	// Uniform struct offsets (matching WGSL MarkConstants layout, 48 bytes)
	const UNIFORM_OFFSETS = {
		POINT_COUNT: 0, // u32
		COLOR_MODE: 4, // u32
		COLOR_SCALE_INDEX: 8, // u32
		ORIENTATION: 12, // u32 (0=vertical, 1=horizontal)
		CONSTANT_COLOR: 16, // vec4<f32>
		FILL_OPACITY: 32 // f32
	};

	let {
		dimData,
		topData,
		bottomData,
		seriesData = null,
		colorValueData = null,
		dataVersion = 0,
		zIndex = 0,
		fillOpacity = 0.5,
		orientation = 'vertical', // 'vertical' (AreaY) or 'horizontal' (AreaX)
		colorMode = 0, // 0 = constant, 1 = scale
		colorScaleIndex = 0,
		constantColor = [0.2, 0.4, 0.8, 1.0]
	} = $props();

	const chartContext = getContext('chart');
	const webGPUContext = getContext('webgpu-canvas');
	const gpuCoordinator = getGPUContext();

	let renderer = $state(null);
	let initializationError = $state(null);
	let areaGeometryBuffer;

	const areaVertexCount = 6; // 2 triangles for one area quad

	// Area shader: filled quads between top and bottom boundaries along a dimension.
	// evaluateCurve() from CurveShaderLib enables future curve interpolation.
	// Orientation handled via uniform flag — all vertices take the same branch (zero divergence).
	const areasShaderCode = `
  ${CURVE_LINEAR}

  struct MarkConstants {
    pointCount: u32,
    colorMode: u32,
    colorScaleIndex: u32,
    orientation: u32,
    constantColor: vec4<f32>,
    fillOpacity: f32
  };
  @group(1) @binding(5) var<uniform> markConstants: MarkConstants;

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) colorValue: f32,
    @location(1) alpha: f32
  };

  @group(1) @binding(0) var<storage, read> dimValues: array<f32>;
  @group(1) @binding(1) var<storage, read> topValues: array<f32>;
  @group(1) @binding(2) var<storage, read> bottomValues: array<f32>;
  @group(1) @binding(3) var<storage, read> seriesValues: array<f32>;
  @group(1) @binding(4) var<storage, read> colorValues: array<f32>;

  fn isNaN(v: f32) -> bool {
    return v != v;
  }

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
    @builtin(instance_index) instanceIdx: u32
  ) -> VertexOutput {
    let pointCount = markConstants.pointCount;
    let currIdx = instanceIdx;
    let nextIdx = instanceIdx + 1u;

    // Last point in data has no next segment
    if (nextIdx >= pointCount) {
      var output: VertexOutput;
      output.position = DISCARD_POS;
      return output;
    }

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

    // Compute neighbor indices with series-aware boundary clamping
    // (for curve types that need 4 control points)
    let prevIdx = select(currIdx - 1u, currIdx,
      currIdx == 0u || seriesValues[currIdx - 1u] != seriesCurr);
    let afterIdx = select(nextIdx + 1u, nextIdx,
      nextIdx + 1u >= pointCount || seriesValues[nextIdx + 1u] != seriesNext);

    // Read neighbor dimension values for curve control points
    let dimPrev = dimValues[prevIdx];
    let dimAfter = dimValues[afterIdx];

    // Evaluate top boundary curve independently.
    // Project 4 control points for the top edge to pixel space.
    let topPxPrev = projectToPixels(makePoint(dimPrev, topValues[prevIdx]));
    let topPxCurr = projectToPixels(makePoint(dimCurr, topCurr));
    let topPxNext = projectToPixels(makePoint(dimNext, topNext));
    let topPxAfter = projectToPixels(makePoint(dimAfter, topValues[afterIdx]));
    // For linear: evaluateCurve = mix(p1, p2, t), so topPos = mix(topPxCurr, topPxNext, t)
    let topPos = evaluateCurve(topPxPrev, topPxCurr, topPxNext, topPxAfter, quadCorner.x);

    // Evaluate bottom boundary curve independently.
    let botPxPrev = projectToPixels(makePoint(dimPrev, bottomValues[prevIdx]));
    let botPxCurr = projectToPixels(makePoint(dimCurr, botCurr));
    let botPxNext = projectToPixels(makePoint(dimNext, botNext));
    let botPxAfter = projectToPixels(makePoint(dimAfter, bottomValues[afterIdx]));
    let botPos = evaluateCurve(botPxPrev, botPxCurr, botPxNext, botPxAfter, quadCorner.x);

    // Interpolate between bottom and top: quadCorner.y = 0 (bottom) or 1 (top)
    let finalPos = mix(botPos, topPos, quadCorner.y);

    var output: VertexOutput;
    output.position = pixelsToClip(finalPos);
    output.colorValue = colorValues[currIdx];
    output.alpha = markConstants.fillOpacity;
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

    return vec4<f32>(baseColor.rgb, baseColor.a * input.alpha);
  }
  `;

	const vertexBufferLayout = [
		{
			arrayStride: 2 * 4, // 2 floats per vertex
			attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }]
		}
	];

	const dataBindingConfig = [
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

	// Write uniforms when configuration changes
	$effect(() => {
		if (renderer?.resourcesCreated) {
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

			renderer.writeUniform(BINDINGS.CONSTANTS, new Uint8Array(buffer));
		}
	});

	// Instance count = number of data points (last instance per series discards)
	$effect(() => {
		if (renderer?.resourcesCreated && dimData && dimData.length > 1) {
			renderer.updateInstanceCount(dimData.length);
		}
	});

	// Area quad geometry: 6 vertices (2 triangles)
	// x: 0=curr point, 1=next point along dimension
	// y: 0=bottom boundary, 1=top boundary
	function createAreaGeometry() {
		// prettier-ignore
		return new Float32Array([
			0, 0,   1, 0,   0, 1,
			1, 0,   1, 1,   0, 1,
		]);
	}

	async function initializeGeometry() {
		const device = webGPUContext.getDevice();
		const areaVertices = createAreaGeometry();
		areaGeometryBuffer = device.createBuffer({
			size: areaVertices.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			label: 'areas-geometry'
		});
		device.queue.writeBuffer(areaGeometryBuffer, 0, areaVertices);
	}

	function drawAreas(passEncoder) {
		if (!areaGeometryBuffer || renderer.instanceCount === 0) return;
		passEncoder.setVertexBuffer(0, areaGeometryBuffer);
		passEncoder.draw(areaVertexCount, renderer.instanceCount);
	}

	async function initializeAreas() {
		try {
			renderer = new BaseGPURenderer('areas', webGPUContext, gpuCoordinator, chartContext, {
				zIndex,
				xScaleType: chartContext.scaleTypes?.x || 'linear',
				yScaleType: chartContext.scaleTypes?.y || 'linear'
			});

			await renderer.initialize({
				markShaderCode: areasShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition: areaRendererDefinition
			});

			await initializeGeometry();
			renderer.registerLayer(drawAreas);

			// Initialize series buffer with zeros if not provided
			if (!seriesData && dimData) {
				const defaultSeries = new Float32Array(dimData.length);
				renderer.writeAttribute(BINDINGS.SERIES, defaultSeries);
			}

			// Initialize color buffer with zeros if not provided
			if (!colorValueData && dimData) {
				const defaultColor = new Float32Array(dimData.length);
				renderer.writeAttribute(BINDINGS.COLOR, defaultColor);
			}
		} catch (error) {
			console.error('Areas init failed:', error);
			initializationError = error.message;
		}
	}

	async function waitForWebGPU() {
		let attempts = 0;
		while (!webGPUContext.isInitialized() && attempts < 100) {
			await new Promise((r) => setTimeout(r, 50));
			attempts++;
		}
		if (webGPUContext.isInitialized()) await initializeAreas();
	}

	onMount(() => waitForWebGPU());

	onDestroy(() => {
		if (areaGeometryBuffer) areaGeometryBuffer.destroy();
		if (renderer) renderer.destroy();
	});
</script>

{#if initializationError}
	<div class="areas-error">{initializationError}</div>
{/if}
