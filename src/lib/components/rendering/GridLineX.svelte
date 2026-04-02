<script lang="ts">
	import { getContext, onMount, onDestroy } from 'svelte';
	import { BaseGPURenderer } from './BaseGPURenderer.svelte';
	import { getGPUContext } from '$lib/gpu';
	import type { ChartContext, WebGPUCanvasContext } from '$lib/types';

	// GridLineX: Vertical grid lines (X-axis)
	// Only binds X scale - eliminates Y scale binding overhead
	const ruleXRendererDefinition = {
		x: { concept: 'position', channels: ['x'] },
		y: null, // No Y scale binding
		placeholders: { x: '{{X_AXIS_LOGIC}}' }
	};

	const BINDINGS = {
		POSITIONS: 0,
		CONSTANTS: 6
	};

	const UNIFORM_OFFSETS = {
		LINE_WIDTH: 0,
		// 4-12: padding
		COLOR: 16
	};

	interface Props {
		positions: Float32Array;
		color?: [number, number, number, number];
		lineWidth?: number;
		zIndex?: number;
	}

	let { positions, color = [0.8, 0.8, 0.8, 0.3], lineWidth = 1, zIndex = -10 }: Props = $props();

	const chartContext = getContext<ChartContext>('chart');
	const webGPUContext = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const gpuCoordinator = getGPUContext();
	const faceted = !!chartContext.fx;

	let renderer = $state<BaseGPURenderer | null>(null);
	let initializationError = $state<string | null>(null);
	let lineGeometryBuffer: GPUBuffer;

	const ruleXShaderCode = `
    struct RuleConstants {
      lineWidth: f32,
      _pad0: u32,
      _pad1: u32,
      _pad2: u32,
      color: vec4<f32>,
    };
    @group(1) @binding(6) var<uniform> ruleConstants: RuleConstants;

    @group(1) @binding(0) var<storage, read> positions: array<f32>;

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) color: vec4<f32>,
    };

    @vertex
    fn vertexMain(
      @location(0) lineVertex: vec2<f32>,
      @builtin(instance_index) instanceIdx: u32,
    ) -> VertexOutput {
      let x = positions[instanceIdx];

      // X axis scaling (for vertical lines)
      {{X_AXIS_LOGIC}}

      // Render vertical line as a thin quad
      let halfWidth = ruleConstants.lineWidth * 0.5 * frameUniforms.devicePixelRatio;

      // Vertical: fixed X, span full Y
      let screenY = mix(0.0, frameUniforms.resolution.y, lineVertex.y);
      let offsetX = (lineVertex.x - 0.5) * 2.0 * halfWidth;
      let worldPos = vec2<f32>(scaledX + offsetX, screenY);

      let normalizedPos = (worldPos / frameUniforms.resolution) * 2.0 - 1.0;

      var output: VertexOutput;
      output.position = vec4<f32>(normalizedPos.x, -normalizedPos.y, 0.0, 1.0);
      output.color = ruleConstants.color;
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
		if (renderer?.resourcesCreated && positions) {
			renderer.updateInstanceCount(positions.length);
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
			label: 'ruleX-line-geometry'
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
			renderer = new BaseGPURenderer('ruleX', webGPUContext, gpuCoordinator, chartContext, {
				zIndex,
				xScaleType: chartContext.scaleTypes?.x || 'linear',
				yScaleType: chartContext.scaleTypes?.y || 'linear'
			});

			await renderer.initialize({
				markShaderCode: ruleXShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition: ruleXRendererDefinition
			});

			await initializeLineGeometry();

			// Non-faceted: register with the single chart canvas
			// Faceted: registration handled by reactive $effect above
			if (!faceted) {
				renderer.registerLayer(drawRules);
			}
		} catch (error) {
			console.error('RuleX renderer init failed:', error);
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
