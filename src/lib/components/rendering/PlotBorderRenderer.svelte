<script lang="ts">
	import { getContext, onMount, onDestroy } from 'svelte';
	import { UNIFORM_BYTES } from './uniform-sizes';
	import { RendererHost } from './RendererHost.svelte';
	import { getGPUContext } from '$lib/gpu';
	import type { TextAtlas } from '$lib/gpu/text/TextAtlas.svelte';
	import type { ChartContext, WebGPUCanvasContext } from '$lib/types';

	/**
	 * The plot area's 1 CSS px border (`<Frame/>`), drawn on the GPU in cell
	 * space so edges are never clipped by the plot scissor. Each edge snaps to
	 * whole device pixels (`max(1, round(dpr))` wide) — centred on the plot
	 * boundary at even widths, with the extra pixel outside the plot at odd
	 * widths — so opposite borders keep identical thickness at fractional DPRs
	 * and window widths, with corners meeting flush without overlap.
	 */

	const BINDINGS = { CONSTANTS: 0 };
	/** Behind grid lines (-10) and marks (0), matching the former SVG background frame. */
	const BORDER_Z_INDEX = -20;

	const chartContext = getContext<ChartContext>('chart');
	const webGPUContext = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const atlas = getContext<TextAtlas>('text-atlas');
	const gpuCoordinator = getGPUContext();

	const BORDER_COLOR = 'var(--fjader-text-muted, #d1d5db)';
	const colorWatch = atlas.watchColor(
		BORDER_COLOR,
		webGPUContext.getCssColor('--fjader-text-muted', '#d1d5db')
	);

	const visible = $derived(
		!!(
			chartContext.xScale &&
			chartContext.yScale &&
			chartContext.innerWidth > 0 &&
			chartContext.innerHeight > 0
		)
	);

	const host = new RendererHost({
		markType: 'plot-border',
		webGPUContext,
		gpuCoordinator,
		chartContext,
		zIndex: BORDER_Z_INDEX,
		space: 'cell',
		xScaleType: 'linear',
		yScaleType: 'linear',
		readsChartScales: false,
		label: 'Plot border'
	});
	const renderer = $derived(host.renderer);
	const initializationError = $derived(host.error);
	let quadBuffer: GPUBuffer | undefined;

	const shaderCode = `
    const LINE_WIDTH: f32 = 1.0;

    struct BorderConstants {
      color: vec4<f32>,
    };
    @group(1) @binding(${BINDINGS.CONSTANTS}) var<uniform> borderConstants: BorderConstants;

    @vertex
    fn vertexMain(
      @location(0) corner: vec2<f32>,
      @builtin(instance_index) i: u32,
    ) -> @builtin(position) vec4<f32> {
      let w = max(1.0, round(LINE_WIDTH * frameUniforms.devicePixelRatio));
      let lo = floor(w * 0.5);
      let hi = w - lo;
      let origin = round(plotToCell(vec2<f32>(0.0, 0.0)));
      let end = round(plotToCell(frameUniforms.resolution));
      let innerLeft = origin.x + lo;
      let innerRight = max(innerLeft, end.x - lo);

      var p: vec2<f32>;
      if (i == 0u) {
        // Left edge (extra odd pixel on the outside; owns top and bottom corners)
        p = vec2<f32>(mix(origin.x - hi, innerLeft, corner.x), mix(origin.y - hi, end.y + hi, corner.y));
      } else if (i == 1u) {
        // Top edge (fits cleanly between left and right edges)
        p = vec2<f32>(mix(innerLeft, innerRight, corner.x), mix(origin.y - hi, origin.y + lo, corner.y));
      } else if (i == 2u) {
        // Bottom edge
        p = vec2<f32>(mix(innerLeft, innerRight, corner.x), mix(end.y - lo, end.y + hi, corner.y));
      } else {
        // Right edge (extra odd pixel on the outside; owns top and bottom corners)
        p = vec2<f32>(mix(end.x - lo, end.x + hi, corner.x), mix(origin.y - hi, end.y + hi, corner.y));
      }
      return cellToClip(p);
    }

    @fragment
    fn fragmentMain() -> @location(0) vec4<f32> {
      let a = borderConstants.color.a;
      return vec4<f32>(borderConstants.color.rgb * a, a);
    }
  `;

	const rendererDefinition = { x: null, y: null };

	const dataBindingConfig = [
		{
			binding: BINDINGS.CONSTANTS,
			type: 'uniform',
			visibility: GPUShaderStage.FRAGMENT
		}
	];

	const vertexBufferLayout: GPUVertexBufferLayout[] = [
		{
			arrayStride: 2 * 4,
			attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }]
		}
	];

	const constantsBytes = new ArrayBuffer(UNIFORM_BYTES.borderConstants);
	const constantsF32 = new Float32Array(constantsBytes);
	const constantsU8 = new Uint8Array(constantsBytes);

	$effect(() => {
		if (!renderer?.resourcesCreated) return;
		const rgba = colorWatch.rgba;
		for (let k = 0; k < 4; k++) constantsF32[k] = rgba[k];
		renderer.writeUniform(BINDINGS.CONSTANTS, constantsU8);
	});

	$effect(() => {
		void visible;
		if (renderer?.resourcesCreated) renderer.invalidateLayer();
	});

	const corners = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);

	function draw(pass: GPURenderPassEncoder) {
		if (!quadBuffer || !visible) return;
		pass.setVertexBuffer(0, quadBuffer);
		pass.draw(6, 4);
	}

	onMount(() =>
		host.mount({
			init: {
				markShaderCode: shaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition
			},
			async ready(r) {
				const device = webGPUContext.getDevice()!;
				quadBuffer = device.createBuffer({
					size: corners.byteLength,
					usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
					label: 'plot-border-geometry'
				});
				device.queue.writeBuffer(quadBuffer, 0, corners);
				r.registerLayer(draw);
			}
		})
	);

	onDestroy(() => {
		atlas.unwatchColor(colorWatch);
		quadBuffer?.destroy();
		renderer?.destroy();
	});
</script>

{#if initializationError}
	<div class="plot-border-error">{initializationError}</div>
{/if}
