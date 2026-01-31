<script>
	import { getContext, onMount, onDestroy } from 'svelte';
	import { BaseGPURenderer } from './BaseGPURenderer.svelte.js';
	import { getGPUContext } from '$lib/gpu';

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

	// Uniform struct offsets (matching WGSL MarkConstants layout)
	const UNIFORM_OFFSETS = {
		STROKE_WIDTH: 0, // f32
		MITER_LIMIT: 4, // f32
		COLOR_MODE: 8, // u32
		COLOR_SCALE_INDEX: 12, // u32
		CONSTANT_COLOR: 16 // vec4<f32>
	};

	let {
		xData,
		yData,
		seriesData = null,
		colorValueData = null,
		dataVersion = 0,
		zIndex = 0,
		strokeWidth = 2,
		miterLimit = 4,
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

	const quadVertexCount = 6; // 2 triangles per segment

	// Line shader with miter joins and series boundary detection
	const linesShaderCode = `
  struct MarkConstants {
    strokeWidth: f32,
    miterLimit: f32,
    colorMode: u32,
    colorScaleIndex: u32,
    constantColor: vec4<f32>
  };
  @group(1) @binding(4) var<uniform> markConstants: MarkConstants;

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) colorValue: f32,
    @location(1) alpha: f32
  };

  @group(1) @binding(0) var<storage, read> xValues: array<f32>;
  @group(1) @binding(1) var<storage, read> yValues: array<f32>;
  @group(1) @binding(2) var<storage, read> seriesValues: array<f32>;
  @group(1) @binding(3) var<storage, read> colorValues: array<f32>;

  fn isNaN(v: f32) -> bool {
    return v != v;
  }

  fn getPointCount() -> u32 {
    return arrayLength(&xValues);
  }

  @vertex
  fn vertexMain(
    @location(0) quadPosition: vec2<f32>,
    @builtin(instance_index) instanceIdx: u32,
    @builtin(vertex_index) vertexIdx: u32
  ) -> VertexOutput {
    let pointCount = getPointCount();
    let currIdx = instanceIdx;
    let nextIdx = instanceIdx + 1u;

    // --- BOUNDS CHECK ---
    if (nextIdx >= pointCount) {
      var output: VertexOutput;
      output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0); 
      return output;
    }

    let xCurr = xValues[currIdx];
    let yCurr = yValues[currIdx];
    let xNext = xValues[nextIdx];
    let yNext = yValues[nextIdx];
    let seriesCurr = seriesValues[currIdx];
    let seriesNext = seriesValues[nextIdx];
    let colorValue = colorValues[currIdx];

    if (seriesCurr != seriesNext || isNaN(xCurr) || isNaN(yCurr) || isNaN(xNext) || isNaN(yNext)) {
      var output: VertexOutput;
      output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0); 
      return output;
    }

    // --- TOPOLOGY ---
    let isStartOfSeries = (currIdx == 0u) || (seriesValues[currIdx - 1u] != seriesCurr);
    let isEndOfSeries = ((nextIdx + 1u) >= pointCount) || (seriesValues[nextIdx + 1u] != seriesNext);

    // --- PROJECTION ---
    let pCurr = projectToPixels(vec2<f32>(xCurr, yCurr));
    let pNext = projectToPixels(vec2<f32>(xNext, yNext));
    let segmentDir = pNext - pCurr;
    let segmentLen = length(segmentDir);

    if (segmentLen < 0.001) {
      var output: VertexOutput;
      output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0); 
      return output;
    }

    let tangent = segmentDir / segmentLen;
    // Normal points "Right" relative to direction
    let normal = vec2<f32>(-tangent.y, tangent.x);

    // side: -1 = Left/Outer(RightTurn), 1 = Right/Inner(RightTurn)
    let side = quadPosition.y;

    var miterStart = normal;
    var miterEnd = normal;

    // --- START JOIN ---
    if (!isStartOfSeries) {
        let prevIdx = currIdx - 1u;
        let xPrev = xValues[prevIdx];
        let yPrev = yValues[prevIdx];
        if (!isNaN(xPrev) && !isNaN(yPrev)) {
            let pPrev = projectToPixels(vec2<f32>(xPrev, yPrev));
            let prevDir = pCurr - pPrev;
            if (length(prevDir) > 0.001) {
                let prevTangent = normalize(prevDir);
                let prevNormal = vec2<f32>(-prevTangent.y, prevTangent.x);
                let sumNormals = prevNormal + normal;
                
                if (length(sumNormals) > 0.001) {
                    let bisector = normalize(sumNormals);
                    let dotProd = dot(bisector, normal);
                    let miterLen = 1.0 / max(dotProd, 0.0001);
                    
                    // Turn Direction (2D Cross Product)
                    // > 0: Right Turn (CW)
                    // < 0: Left Turn (CCW)
                    let cross = prevTangent.x * tangent.y - prevTangent.y * tangent.x;
                    
                    // Determine if this side is on the "Outer" (sharp) side of the turn
                    var isOuter = false;
                    if (cross > 0.0) {
                        // Right Turn: Left side (-1) is Outer
                        isOuter = (side < 0.0);
                    } else {
                        // Left Turn: Right side (+1) is Outer
                        isOuter = (side > 0.0);
                    }
                    
                    var finalLen = miterLen;
                    if (isOuter) {
                        // Outer: Strict clamp to avoid spikes
                        finalLen = min(miterLen, markConstants.miterLimit);
                    } else {
                        // Inner: Allow extension to close the gap...
                        // ...BUT cap it at a safety limit (100.0) to prevent 
                        // infinite explosion on near-180 hairpins.
                        finalLen = min(miterLen, 100.0);
                    }
                    
                    miterStart = bisector * finalLen;
                }
            }
        }
    }

    // --- END JOIN ---
    if (!isEndOfSeries) {
        let nextNextIdx = nextIdx + 1u;
        let xNextNext = xValues[nextNextIdx];
        let yNextNext = yValues[nextNextIdx];
        if (!isNaN(xNextNext) && !isNaN(yNextNext)) {
            let pNextNext = projectToPixels(vec2<f32>(xNextNext, yNextNext));
            let nextDir = pNextNext - pNext;
            if (length(nextDir) > 0.001) {
                let nextTangent = normalize(nextDir);
                let nextNormal = vec2<f32>(-nextTangent.y, nextTangent.x);
                let sumNormals = normal + nextNormal;
                
                if (length(sumNormals) > 0.001) {
                    let bisector = normalize(sumNormals);
                    let dotProd = dot(bisector, normal);
                    let miterLen = 1.0 / max(dotProd, 0.0001);
                    
                    let cross = tangent.x * nextTangent.y - tangent.y * nextTangent.x;
                    
                    var isOuter = false;
                    if (cross > 0.0) {
                        isOuter = (side < 0.0);
                    } else {
                        isOuter = (side > 0.0);
                    }
                    
                    var finalLen = miterLen;
                    if (isOuter) {
                        finalLen = min(miterLen, markConstants.miterLimit);
                    } else {
                        // Safety Cap: 100x thickness is plenty to look "filled" 
                        // but small enough to avoid rendering artifacts.
                        finalLen = min(miterLen, 100.0);
                    }
                    
                    miterEnd = bisector * finalLen;
                }
            }
        }
    }

    // --- EXTRUSION ---
    let halfWidth = markConstants.strokeWidth * frameUniforms.devicePixelRatio * 0.5;
    let t = quadPosition.x * 0.5 + 0.5; 

    let basePos = mix(pCurr, pNext, t);
    let miter = mix(miterStart, miterEnd, t);
    let finalPos = basePos + miter * side * halfWidth;

    // --- OVERLAP LOGIC ---
    // Only extend TRUE endpoints
    let overlap = frameUniforms.devicePixelRatio * 0.5;
    var adjustedPos = finalPos;
    
    if (t < 0.01 && isStartOfSeries) {
          adjustedPos = finalPos - tangent * overlap;
    } else if (t > 0.99 && isEndOfSeries) {
          adjustedPos = finalPos + tangent * overlap;
    }

    var output: VertexOutput;
    output.position = pixelsToClip(adjustedPos);
    output.colorValue = colorValue;
    output.alpha = 1.0;
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
			const buffer = new ArrayBuffer(32);
			const view = new DataView(buffer);
			const LE = true;

			view.setFloat32(UNIFORM_OFFSETS.STROKE_WIDTH, strokeWidth, LE);
			view.setFloat32(UNIFORM_OFFSETS.MITER_LIMIT, miterLimit, LE);
			view.setUint32(UNIFORM_OFFSETS.COLOR_MODE, colorMode, LE);
			view.setUint32(UNIFORM_OFFSETS.COLOR_SCALE_INDEX, colorScaleIndex, LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 0, constantColor[0], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 4, constantColor[1], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 8, constantColor[2], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 12, constantColor[3], LE);

			renderer.writeUniform(BINDINGS.CONSTANTS, new Uint8Array(buffer));
		}
	});

	// Instance count = number of segments = points - 1
	$effect(() => {
		if (renderer?.resourcesCreated && xData && xData.length > 1) {
			renderer.updateInstanceCount(xData.length - 1);
		}
	});

	// Quad geometry for line segments
	// Each vertex has (x, y) where:
	//   x: position along segment (-1 = start, 1 = end)
	//   y: perpendicular offset (-1 = left, 1 = right)
	function createQuadGeometry() {
		return new Float32Array([
			// Triangle 1
			-1,
			-1, // Start, left
			1,
			-1, // End, left
			-1,
			1, // Start, right
			// Triangle 2
			1,
			-1, // End, left
			1,
			1, // End, right
			-1,
			1 // Start, right
		]);
	}

	async function initializeGeometry() {
		const device = webGPUContext.getDevice();
		const quadVertices = createQuadGeometry();
		quadGeometryBuffer = device.createBuffer({
			size: quadVertices.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			label: 'lines-geometry'
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
			renderer = new BaseGPURenderer('lines', webGPUContext, gpuCoordinator, chartContext, {
				zIndex,
				xScaleType: chartContext.scaleTypes?.x || 'linear',
				yScaleType: chartContext.scaleTypes?.y || 'linear'
			});

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
