<script lang="ts">
	import { UNIFORM_BYTES } from './uniform-sizes';
	import { getContext, onMount, onDestroy } from 'svelte';
	import { RendererHost } from './RendererHost.svelte';
	import { getGPUContext } from '$lib/gpu';
	import { ATLAS_WGSL } from '$lib/gpu/text/atlas-bindings';
	import type { ChartContext, WebGPUCanvasContext } from '$lib/types';
	import type { AxisTitle } from '../axes/axis-spec';

	/**
	 * One axis, drawn on the GPU in the chart's margins (a `cell`-space layer):
	 * its tick marks, its tick labels from the chart's text atlas, and its title.
	 * One instanced draw: instances [0, n) are the marks, [n, 2n) the labels,
	 * 2n the title.
	 *
	 * A tick is placed as the grid places its line (GridLine): as a value through
	 * the axis's own scale code, so a pan moves it with nothing written; as a
	 * fraction of the plot while the axis crossfades, so a set stays where its
	 * own domain put it; and on a band axis as a category id through the slot
	 * table, so a reorder moves the labels with their bars, on the GPU.
	 *
	 * Per tick, written when the axis changes (GpuAxis): its position, its
	 * opacity, its label's atlas slot. No DOM, no per-tick work on the main
	 * thread beyond those numbers.
	 */

	interface Props {
		axis: 'x' | 'y';
		/** Four floats per tick: position, opacity, label slot (−1 none), unused. */
		ticks: Float32Array;
		count: number;
		/** Whether positions are fractions of the plot (a crossfade) rather than values. */
		plotSpace: boolean;
		title: AxisTitle | null;
		color: [number, number, number, number];
		/** CSS pixels. */
		tickLength?: number;
		/** CSS pixels from the axis line to the near edge of a tick label. */
		labelGap?: number;
		lineWidth?: number;
		version?: number;
	}

	let {
		axis,
		ticks,
		count,
		plotSpace,
		title,
		color,
		tickLength = 5,
		labelGap = 8,
		lineWidth = 1,
		version = 0
	}: Props = $props();

	const BINDINGS = { TICKS: 0, CONSTANTS: 1 };
	/** Above the marks, below labels on them (BoxLabels): the margins are the axes'. */
	const AXIS_Z_INDEX = 900;

	const chartContext = getContext<ChartContext>('chart');
	const webGPUContext = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const gpuCoordinator = getGPUContext();

	const host = new RendererHost({
		markType: `axis-${axis}`,
		webGPUContext,
		gpuCoordinator,
		chartContext,
		zIndex: AXIS_Z_INDEX,
		space: 'cell',
		label: `Axis (${axis})`
	});
	const renderer = $derived(host.renderer);
	const initializationError = $derived(host.error);
	let quadBuffer: GPUBuffer;

	// Where a tick sits along the plot, in plot pixels, as GridLine places a line.
	const along =
		axis === 'x'
			? `
      let x = t.x;
      {{X_AXIS_LOGIC}}
      let plotPos = frameUniforms.rangeMin.x + x * (frameUniforms.rangeMax.x - frameUniforms.rangeMin.x);
      let at = select(scaledX, plotPos, axisConstants.plotSpace != 0u);`
			: `
      let y = t.x;
      {{Y_AXIS_LOGIC}}
      let plotPos = frameUniforms.rangeMax.y - y * (frameUniforms.rangeMax.y - frameUniforms.rangeMin.y);
      let at = select(scaledY, plotPos, axisConstants.plotSpace != 0u);`;

	const shaderCode = `
    ${ATLAS_WGSL}

    struct AxisConstants {
      color: vec4<f32>,
      tickCount: u32,
      plotSpace: u32,      // 1: positions are plot fractions (a crossfade)
      titleSlot: f32,      // -1: no title
      titleMode: u32,      // bottom: 0 centre, 1 start, 2 end; left: 3 beside, 4 above
      tickLength: f32,     // CSS pixels
      labelGap: f32,
      titleOffset: f32,
      lineWidth: f32,
    };
    @group(1) @binding(${BINDINGS.CONSTANTS}) var<uniform> axisConstants: AxisConstants;
    // Per tick: x = position, y = opacity, z = label slot.
    @group(1) @binding(${BINDINGS.TICKS}) var<storage, read> ticks: array<vec4<f32>>;

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) uv: vec2<f32>,
      @location(1) alpha: f32,
      @location(2) @interpolate(flat) isText: u32,
    };

    fn nothing() -> VertexOutput {
      var out: VertexOutput;
      out.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
      return out;
    }

    /** A text quad from atlas entry \`slot\` with its top left at \`origin\` (plot px), or nothing. */
    fn textQuad(slot: f32, origin: vec2<f32>, corner: vec2<f32>, alpha: f32, rotated: bool) -> VertexOutput {
      if (slot < 0.0) { return nothing(); }
      let rect = textAtlasEntries.rects[u32(slot)];
      if (rect.z <= 0.0 || rect.w <= 0.0) { return nothing(); }
      let size = rect.zw;
      // On the canvas, whole device pixels: rounded after the plot's offset,
      // so a texel lands on a pixel (rounding in plot pixels and then adding
      // a fractional offset left labels between pixels, blurred).
      var p: vec2<f32>;
      if (rotated) {
        // Read bottom to top: the text's x runs up the screen. origin is the
        // rotated box's centre; a whole-pixel corner keeps the rotated texels
        // on pixels too.
        let local = (corner - 0.5) * size;
        let centre = round(plotToCell(origin) - vec2<f32>(size.y, size.x) * 0.5) + vec2<f32>(size.y, size.x) * 0.5;
        p = centre + vec2<f32>(local.y, -local.x);
      } else {
        p = round(plotToCell(origin)) + corner * size;
      }
      let atlasSize = vec2<f32>(textureDimensions(textAtlas));
      var out: VertexOutput;
      out.position = cellToClip(p);
      out.uv = (rect.xy + corner * size) / atlasSize;
      out.alpha = alpha;
      out.isText = 1u;
      return out;
    }

    @vertex
    fn vertexMain(
      @location(0) corner: vec2<f32>,
      @builtin(instance_index) i: u32,
    ) -> VertexOutput {
      let n = axisConstants.tickCount;
      let dpr = frameUniforms.devicePixelRatio;
      let plotW = frameUniforms.resolution.x;
      let plotH = frameUniforms.resolution.y;
      let len = axisConstants.tickLength * dpr;
      let gap = axisConstants.labelGap * dpr;

      if (i == 2u * n) {
        // The title.
        let slot = axisConstants.titleSlot;
        if (slot < 0.0) { return nothing(); }
        let size = textAtlasEntries.rects[u32(max(slot, 0.0))].zw;
        let mode = axisConstants.titleMode;
        let off = axisConstants.titleOffset * dpr;
        if (mode == 3u) {
          return textQuad(slot, vec2<f32>(-off - size.y * 0.5, plotH * 0.5), corner, 1.0, true);
        }
        if (mode == 4u) {
          return textQuad(slot, vec2<f32>(0.0, -off - size.y), corner, 1.0, false);
        }
        let x = select(select(plotW * 0.5 - size.x * 0.5, 0.0, mode == 1u), plotW - size.x, mode == 2u);
        return textQuad(slot, vec2<f32>(x, plotH + off), corner, 1.0, false);
      }
      if (i >= 2u * n) { return nothing(); }

      let t = ticks[i % n];
      ${along}
      // A tick beyond the plot (a band category off its edge) is not drawn.
      let extent = ${axis === 'x' ? 'plotW' : 'plotH'};
      if (at < -0.5 || at > extent + 0.5) { return nothing(); }

      if (i >= n) {
        // A tick label.
        let slot = t.z;
        if (slot < 0.0) { return nothing(); }
        let size = textAtlasEntries.rects[u32(slot)].zw;
        ${
					axis === 'x'
						? 'let origin = vec2<f32>(at - size.x * 0.5, plotH + gap);'
						: 'let origin = vec2<f32>(-gap - size.x, at - size.y * 0.5);'
				}
        return textQuad(slot, origin, corner, t.y, false);
      }

      // A tick mark waits for its label: a tick entering during a pan would
      // otherwise show its mark a frame or two before the atlas paints its string.
      if (t.z >= 0.0 && textAtlasEntries.rects[u32(t.z)].z <= 0.0) { return nothing(); }

      // A tick mark: a thin quad pointing out of the plot.
      let w = axisConstants.lineWidth * dpr;
      ${
				axis === 'x'
					? 'let p = vec2<f32>(at + (corner.x - 0.5) * w, plotH + corner.y * len);'
					: 'let p = vec2<f32>(-corner.x * len, at + (corner.y - 0.5) * w);'
			}
      var out: VertexOutput;
      out.position = cellToClip(plotToCell(p));
      out.alpha = t.y;
      out.isText = 0u;
      return out;
    }

    @fragment
    fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
      // Sampled in uniform control flow, used only by text.
      let coverage = textureSample(textAtlas, textAtlasSampler, input.uv).a;
      let a = axisConstants.color.a * input.alpha * select(1.0, coverage, input.isText == 1u);
      return vec4<f32>(axisConstants.color.rgb * a, a);
    }
  `;

	const rendererDefinition =
		axis === 'x'
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

	const dataBindingConfig = [
		{ binding: BINDINGS.TICKS, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{
			binding: BINDINGS.CONSTANTS,
			type: 'uniform',
			visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
		}
	];

	const vertexBufferLayout: GPUVertexBufferLayout[] = [
		{
			arrayStride: 2 * 4,
			attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }]
		}
	];

	$effect(() => {
		if (renderer?.resourcesCreated && count > 0) renderer.writeAttribute(BINDINGS.TICKS, ticks);
	});

	$effect(() => {
		if (!renderer?.resourcesCreated) return;
		void version;
		const buffer = new ArrayBuffer(UNIFORM_BYTES.axisConstants);
		const view = new DataView(buffer);
		const LE = true;
		for (let k = 0; k < 4; k++) view.setFloat32(k * 4, color[k], LE);
		view.setUint32(16, count, LE);
		view.setUint32(20, plotSpace ? 1 : 0, LE);
		view.setFloat32(24, title ? title.slot : -1, LE);
		view.setUint32(28, title ? title.mode : 0, LE);
		view.setFloat32(32, tickLength, LE);
		view.setFloat32(36, labelGap, LE);
		view.setFloat32(40, title ? title.offset : 0, LE);
		view.setFloat32(44, lineWidth, LE);
		renderer.writeUniform(BINDINGS.CONSTANTS, new Uint8Array(buffer));
	});

	const corners = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);

	function draw(pass: GPURenderPassEncoder) {
		if (!quadBuffer) return;
		pass.setVertexBuffer(0, quadBuffer);
		// Every tick's mark and label, and the title.
		pass.draw(6, 2 * count + 1);
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
					label: `axis-${axis}-geometry`
				});
				device.queue.writeBuffer(quadBuffer, 0, corners);
				r.registerLayer(draw);
			}
		})
	);

	onDestroy(() => {
		quadBuffer?.destroy();
		renderer?.destroy();
	});
</script>

{#if initializationError}
	<div class="axis-error">{initializationError}</div>
{/if}
