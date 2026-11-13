<script lang="ts">
	import { UNIFORM_BYTES } from './uniform-sizes';
	import { getContext, onMount, onDestroy } from 'svelte';
	import { RendererHost } from './RendererHost.svelte';
	import { getGPUContext } from '$lib/gpu';
	import type { ChartContext, WebGPUCanvasContext } from '$lib/types';

	// Full-span grid lines along one axis: vertical lines at x positions, or
	// horizontal lines at y positions. Binds only that axis's scale.
	function rendererDefinitionFor(axis: 'x' | 'y') {
		return axis === 'x'
			? {
					x: { concept: 'position', channels: ['x'] },
					y: null,
					placeholders: { x: '{{X_AXIS_LOGIC}}' }
				}
			: {
					x: null,
					y: { concept: 'position', channels: ['y'] },
					placeholders: { y: '{{Y_AXIS_LOGIC}}' }
				};
	}

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
		/** Which axis the lines mark: vertical lines for x, horizontal for y. Fixed at creation. */
		axis: 'x' | 'y';
		positions: Float32Array;
		/**
		 * Per-line opacity, 0..1. On a band axis the lines are every id in the
		 * dim and this is 1 for the displayed ones, so a line fades in and out
		 * with its category — morphed on the GPU on the band axis's clock, the
		 * way a bar's height is. Omitted, every line is fully drawn.
		 */
		alpha?: Float32Array | null;
		/**
		 * The band layout whose first opacity write lands without morphing, or 0
		 * (a layout that landed at once; see BandScaleState.slotsLandedLayout).
		 */
		landsFor?: number;
		/** The band axis these lines belong to, when `alpha` should morph. */
		bandAxis?: 'x' | 'y' | null;
		color?: [number, number, number, number];
		lineWidth?: number;
		zIndex?: number;
	}

	let {
		axis,
		positions,
		alpha = null,
		landsFor = 0,
		bandAxis = null,
		color = [0.8, 0.8, 0.8, 0.3],
		lineWidth = 1,
		zIndex = -10
	}: Props = $props();

	const chartContext = getContext<ChartContext>('chart');
	const webGPUContext = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const gpuCoordinator = getGPUContext();
	const faceted = !!chartContext.fx;

	const host = new RendererHost({
		markType: `grid-line-${axis}`,
		webGPUContext,
		gpuCoordinator,
		chartContext,
		zIndex,
		label: `Grid line (${axis})`
	});
	const renderer = $derived(host.renderer);
	const initializationError = $derived(host.error);
	let lineGeometryBuffer: GPUBuffer;

	/**
	 * The two orientations differ only in which coordinate is scaled and which
	 * spans the plot; everything else is shared.
	 */
	function shaderFor(axis: 'x' | 'y'): string {
		const placement =
			axis === 'x'
				? `
      let x = positions[instanceIdx];
      {{X_AXIS_LOGIC}}
      // Vertical: fixed x, spanning the full height.
      let screenY = mix(0.0, frameUniforms.resolution.y, lineVertex.y);
      let offsetX = (lineVertex.x - 0.5) * 2.0 * halfWidth;
      let worldPos = vec2<f32>(scaledX + offsetX, screenY);`
				: `
      let y = positions[instanceIdx];
      {{Y_AXIS_LOGIC}}
      // Horizontal: fixed y, spanning the full width.
      let screenX = mix(0.0, frameUniforms.resolution.x, lineVertex.x);
      let offsetY = (lineVertex.y - 0.5) * 2.0 * halfWidth;
      let worldPos = vec2<f32>(screenX, scaledY + offsetY);`;
		return `
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
      // Rendered as a thin quad.
      let halfWidth = ruleConstants.lineWidth * 0.5 * frameUniforms.devicePixelRatio;
${placement}

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
	}

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
	// The landed layout last written; plain, read and set by the write alone.
	let lastLandedLayout = 0;
	$effect(() => {
		if (!renderer?.resourcesCreated || !morphs) return;
		// Only the first write after that layout lands: the opacity it changed.
		const first = landsFor !== lastLandedLayout;
		lastLandedLayout = landsFor;
		const land = first && landsFor !== 0 ? 'all' : undefined;
		renderer.writeMorphed(bandAxis!, positions, [[BINDINGS.ALPHA, alpha!]], land);
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
			const buffer = new ArrayBuffer(UNIFORM_BYTES.gridLineRuleConstants);
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
			label: `grid-line-${axis}-geometry`
		});
		device.queue.writeBuffer(lineGeometryBuffer, 0, lineVertices);
	}

	function drawRules(passEncoder: GPURenderPassEncoder) {
		if (!lineGeometryBuffer || renderer.instanceCount === 0) return;
		passEncoder.setVertexBuffer(0, lineGeometryBuffer);
		passEncoder.draw(6, renderer.instanceCount);
	}

	onMount(() =>
		host.mount({
			init: {
				markShaderCode: shaderFor(axis),
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition: rendererDefinitionFor(axis)
			},
			async ready(r) {
				await initializeLineGeometry();

				// Non-faceted: register with the single chart canvas.
				// Faceted: registration handled by the reactive $effect above.
				if (!faceted) r.registerLayer(drawRules);
			}
		})
	);

	onDestroy(() => {
		if (lineGeometryBuffer) lineGeometryBuffer.destroy();
		if (renderer) renderer.destroy();
	});
</script>

{#if initializationError}
	<div class="rule-error">{initializationError}</div>
{/if}
