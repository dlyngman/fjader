<script lang="ts">
	import { getContext, onMount, onDestroy } from 'svelte';
	import { BaseGPURenderer } from './BaseGPURenderer.svelte';
	import { getGPUContext } from '$lib/gpu';
	import type { ChartContext, WebGPUCanvasContext } from '$lib/types';

	// GridLineY: Horizontal grid lines (Y-axis)
	// Only binds Y scale - eliminates X scale binding overhead
	const ruleYRendererDefinition = {
		x: null, // No X scale binding
		y: { concept: 'position', channels: ['y'] },
		placeholders: { y: '{{Y_AXIS_LOGIC}}' }
	};

	const BINDINGS = {
		POSITIONS: 0,
		ALPHA: 1,
		CONSTANTS: 6
	};

	const UNIFORM_OFFSETS = {
		LINE_WIDTH: 0,
		// 4-12: padding
		COLOR: 16
	};

	interface Props {
		positions: Float32Array;
		/**
		 * Per-line opacity, 0..1. On a band axis the lines are every id in the
		 * dim and this is 1 for the displayed ones, so a line fades in and out
		 * with its category — morphed on the GPU on the band axis's clock, the
		 * way a bar's height is. Omitted, every line is fully drawn.
		 */
		alpha?: Float32Array | null;
		/** The band axis these lines belong to, when `alpha` should morph. */
		bandAxis?: 'x' | 'y' | null;
		color?: [number, number, number, number];
		lineWidth?: number;
		zIndex?: number;
	}

	let {
		positions,
		alpha = null,
		bandAxis = null,
		color = [0.8, 0.8, 0.8, 0.3],
		lineWidth = 1,
		zIndex = -10
	}: Props = $props();

	const chartContext = getContext<ChartContext>('chart');
	const webGPUContext = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const gpuCoordinator = getGPUContext();
	const faceted = !!chartContext.fx;

	let renderer = $state<BaseGPURenderer | null>(null);
	let initializationError = $state<string | null>(null);
	let lineGeometryBuffer: GPUBuffer;

	const ruleYShaderCode = `
    struct RuleConstants {
      lineWidth: f32,
      _pad0: u32,
      _pad1: u32,
      _pad2: u32,
      color: vec4<f32>,
    };
    @group(1) @binding(6) var<uniform> ruleConstants: RuleConstants;

    @group(1) @binding(0) var<storage, read> positions: array<f32>;
    @group(1) @binding(1) var<storage, read> alphaValues: array<f32>;

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) color: vec4<f32>,
    };

    @vertex
    fn vertexMain(
      @location(0) lineVertex: vec2<f32>,
      @builtin(instance_index) instanceIdx: u32,
    ) -> VertexOutput {
      let y = positions[instanceIdx];

      // Y axis scaling (for horizontal lines)
      {{Y_AXIS_LOGIC}}

      // Render horizontal line as a thin quad
      let halfWidth = ruleConstants.lineWidth * 0.5 * frameUniforms.devicePixelRatio;

      // Horizontal: span full X, fixed Y
      let screenX = mix(0.0, frameUniforms.resolution.x, lineVertex.x);
      let offsetY = (lineVertex.y - 0.5) * 2.0 * halfWidth;
      let worldPos = vec2<f32>(screenX, scaledY + offsetY);

      let normalizedPos = (worldPos / frameUniforms.resolution) * 2.0 - 1.0;

      var output: VertexOutput;
      output.position = vec4<f32>(normalizedPos.x, -normalizedPos.y, 0.0, 1.0);
      output.color = vec4<f32>(
        ruleConstants.color.rgb,
        ruleConstants.color.a * alphaValues[instanceIdx]
      );
      return output;
    }

    @fragment
    fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
      return vec4<f32>(input.color.rgb * input.color.a, input.color.a);
    }
  `;

	const vertexBufferLayout: GPUVertexBufferLayout[] = [
		{
			arrayStride: 2 * 4,
			attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }]
		}
	];

	const dataBindingConfig = [
		{ binding: BINDINGS.POSITIONS, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.ALPHA, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{
			binding: BINDINGS.CONSTANTS,
			type: 'uniform',
			visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
		}
	];

	// --- DATA WRITING EFFECTS ---

	// Update positions buffer when positions change
	$effect(() => {
		if (renderer?.resourcesCreated && positions) {
			renderer.writeAttribute(BINDINGS.POSITIONS, positions);
		}
	});

	// Opacity. On a band axis it morphs like a bar's height does: the rows are
	// every id in the dim, so row i is the same category on every update, and
	// the positions are that id list — which is what writeMorphed checks rows
	// against.
	const morphs = $derived(!!bandAxis && !!alpha && alpha.length === positions?.length);
	$effect(() => {
		if (!renderer?.resourcesCreated || !morphs) return;
		renderer.writeMorphed(bandAxis!, positions, [[BINDINGS.ALPHA, alpha!]]);
	});

	// Otherwise every line is fully drawn. Keyed on the line COUNT alone, because
	// a continuous axis's positions change on every pan frame and its opacity
	// does not; the ones are reused until the count outgrows them.
	const lineCount = $derived(positions?.length ?? 0);
	let ones = new Float32Array(0);
	$effect(() => {
		if (!renderer?.resourcesCreated || morphs) return;
		if (ones.length < lineCount)
			ones = new Float32Array(Math.max(lineCount, ones.length * 2)).fill(1);
		renderer.writeAttribute(BINDINGS.ALPHA, ones.subarray(0, lineCount));
	});

	// Update uniform constants
	$effect(() => {
		if (renderer?.resourcesCreated) {
			const buffer = new ArrayBuffer(32);
			const view = new DataView(buffer);
			const LE = true;

			view.setFloat32(UNIFORM_OFFSETS.LINE_WIDTH, lineWidth, LE);
			// padding at 4-12
			view.setFloat32(UNIFORM_OFFSETS.COLOR + 0, color[0], LE);
			view.setFloat32(UNIFORM_OFFSETS.COLOR + 4, color[1], LE);
			view.setFloat32(UNIFORM_OFFSETS.COLOR + 8, color[2], LE);
			view.setFloat32(UNIFORM_OFFSETS.COLOR + 12, color[3], LE);

			renderer.writeUniform(BINDINGS.CONSTANTS, new Uint8Array(buffer));
		}
	});

	// Update instance count
	$effect(() => {
		if (renderer?.resourcesCreated) {
			renderer.updateInstanceCount(positions?.length ?? 0);
		}
	});

	// Facet layer registration (reactive — fires when FacetCells resolve)
	$effect(() => {
		if (!renderer?.resourcesCreated || !faceted) return;
		const ids = chartContext.facetChartIds;
		if (!ids?.length) return;
		renderer.registerFacetLayers(ids, drawRules);
	});

	function createLineGeometry() {
		return new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);
	}

	async function initializeLineGeometry() {
		const device = webGPUContext.getDevice();
		const lineVertices = createLineGeometry();
		lineGeometryBuffer = device.createBuffer({
			size: lineVertices.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			label: 'ruleY-line-geometry'
		});
		device.queue.writeBuffer(lineGeometryBuffer, 0, lineVertices);
	}

	function drawRules(passEncoder: GPURenderPassEncoder) {
		if (!lineGeometryBuffer || renderer.instanceCount === 0) return;
		passEncoder.setVertexBuffer(0, lineGeometryBuffer);
		passEncoder.draw(6, renderer.instanceCount);
	}

	async function initializeRule() {
		try {
			renderer = new BaseGPURenderer('ruleY', webGPUContext, gpuCoordinator, chartContext, {
				zIndex,
				xScaleType: chartContext.scaleTypes?.x || 'linear',
				yScaleType: chartContext.scaleTypes?.y || 'linear'
			});

			await renderer.initialize({
				markShaderCode: ruleYShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition: ruleYRendererDefinition
			});

			await initializeLineGeometry();

			// Non-faceted: register with the single chart canvas
			// Faceted: registration handled by reactive $effect above
			if (!faceted) {
				renderer.registerLayer(drawRules);
			}
		} catch (error) {
			console.error('RuleY renderer init failed:', error);
			initializationError = (error as Error).message;
		}
	}

	async function waitForWebGPU() {
		if (!webGPUContext) return;
		let attempts = 0;
		while (!webGPUContext.isInitialized() && attempts < 100) {
			await new Promise((r) => setTimeout(r, 50));
			attempts++;
		}
		if (webGPUContext.isInitialized()) await initializeRule();
	}

	onMount(() => waitForWebGPU());

	onDestroy(() => {
		if (lineGeometryBuffer) lineGeometryBuffer.destroy();
		if (renderer) renderer.destroy();
	});
</script>

{#if initializationError}
	<div class="rule-error">{initializationError}</div>
{/if}
