<script lang="ts">
	import { PARALLEL_MAX_AXES, PARALLEL_TICKS_PER_AXIS, UNIFORM_BYTES } from './uniform-sizes';
	import { getContext, onMount, onDestroy } from 'svelte';
	import { RendererHost } from './RendererHost.svelte';
	import { getGPUContext } from '$lib/gpu';
	import { ATLAS_WGSL } from '$lib/gpu/text/atlas-bindings';
	import type { ChartContext, WebGPUCanvasContext } from '$lib/types';

	/**
	 * A parallel coordinates chart's axes, drawn on the GPU over the lines (a
	 * `cell`-space layer, so the column names can sit in the margin). One
	 * instanced draw: per axis its line, its tick marks, its tick labels and its
	 * column name, and the drop indicator of a reorder.
	 *
	 * Ticks are placed as the lines place their points: a value through its
	 * axis's own scale params, which the coordinator writes on frames the chart
	 * draws (registerScaleBlock, as ParallelLines), so a pan or zoom of one axis
	 * moves its ticks with its lines and nothing is written from JS. Axis x
	 * positions are the reorder springs' (one uniform write per frame of a
	 * reorder, as the lines get them).
	 *
	 * Each axis owns a fixed region of the tick buffer (TICKS_PER_AXIS ticks,
	 * by data index, so a reorder moves nothing), written by `writeAxisTicks`
	 * only when that axis's ticks change.
	 */

	interface Props {
		axisCount: number;
		/** Each axis's scale id, in data order. */
		scaleIds: string[];
		/**
		 * The tick records, TICKS_PER_AXIS per axis by data index, four floats
		 * each: position, opacity, label slot (−1 none), unused. Owned by the
		 * caller, which writes an axis's region and calls `uploadAxis`.
		 */
		ticks: Float32Array<ArrayBuffer>;
		/** Visual position → data index. */
		order: ArrayLike<number>;
		/** Per visual position: x as a fraction of the plot (the reorder springs). */
		positions: ArrayLike<number>;
		/** Per data index: its column name's atlas slot, −1 none. */
		titleSlots: ArrayLike<number>;
		/** Data index of the axis being dragged, −1 none. */
		dragged: number;
		/** The visual slot a drop would land in, −1 none. */
		dropSlot: number;
		/** Bit d: axis d's tick positions are plot fractions (a crossfade). */
		plotSpaceMask: number;
		color: [number, number, number, number];
		accent: [number, number, number, number];
		halo: [number, number, number, number];
		/** CSS pixels: a tick mark's half length, each side of the axis. */
		tickLength?: number;
		/** CSS pixels from the axis to a tick label's near edge (first and last axis). */
		labelGap?: number;
		/** CSS pixels: how far the halo reaches past a glyph. */
		haloRadius?: number;
		/** CSS pixels below the plot to the column name's top, as the x axis's title. */
		titleGap?: number;
	}

	let {
		axisCount,
		scaleIds,
		ticks,
		order,
		positions,
		titleSlots,
		dragged,
		dropSlot,
		plotSpaceMask,
		color,
		accent,
		halo,
		tickLength = 4,
		labelGap = 8,
		haloRadius = 1,
		titleGap = 20
	}: Props = $props();

	const TICKS_PER_AXIS = PARALLEL_TICKS_PER_AXIS;
	const MAX_AXES = PARALLEL_MAX_AXES;

	const BINDINGS = { TICKS: 0, CONSTANTS: 1, AXIS_SCALES: 2 };
	/** Above the lines, as the chart's axes are. */
	const AXIS_Z_INDEX = 900;

	const chartContext = getContext<ChartContext>('chart');
	const webGPUContext = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const gpuCoordinator = getGPUContext();

	const host = new RendererHost({
		// 'axis-' marks it a guide: it neither enters nor starts the entrance.
		markType: 'axis-parallel',
		webGPUContext,
		gpuCoordinator,
		chartContext,
		zIndex: AXIS_Z_INDEX,
		space: 'cell',
		yScaleType: 'linear',
		// Each axis has its own scale; the chart registers no y scale at all.
		readsChartScales: false,
		label: 'Parallel axes'
	});
	const renderer = $derived(host.renderer);
	const initializationError = $derived(host.error);
	let quadBuffer: GPUBuffer;

	const shaderCode = `
    ${ATLAS_WGSL}

    struct ParallelAxisConstants {
      color: vec4<f32>,              // axis lines, ticks, their labels, column names
      accent: vec4<f32>,             // the dragged axis's name, the drop indicator
      halo: vec4<f32>,               // under text, for reading over lines
      axisCount: u32,
      dragged: i32,                  // data index, -1 none
      dropSlot: i32,                 // visual slot, -1 none
      plotSpaceMask: u32,            // bit d: axis d's positions are plot fractions
      tickLength: f32,               // CSS pixels
      labelGap: f32,
      haloRadius: f32,
      titleGap: f32,
      axisX: array<vec4<f32>, 4>,    // per data index: x as a plot fraction
      visual: array<vec4<u32>, 4>,   // per data index: visual position
      titleSlot: array<vec4<f32>, 4>, // per data index: atlas slot, -1 none
    };
    @group(1) @binding(${BINDINGS.CONSTANTS}) var<uniform> axisConstants: ParallelAxisConstants;
    // Per tick, ${TICKS_PER_AXIS} per axis by data index: x = value (or plot
    // fraction), y = opacity, z = label slot (-1 none).
    @group(1) @binding(${BINDINGS.TICKS}) var<storage, read> ticks: array<vec4<f32>>;
    @group(1) @binding(${BINDINGS.AXIS_SCALES}) var<uniform> axisScales: array<ScaleParam, ${MAX_AXES}>;

    const TICKS_PER_AXIS = ${TICKS_PER_AXIS}u;
    const KIND_LINE = 0u;
    const KIND_TEXT = 1u;
    const KIND_DASH = 2u;
    const KIND_PLAIN_TEXT = 3u;    // text with no halo: the names, in the margin

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) texel: vec2<f32>,
      @location(1) @interpolate(flat) rect: vec4<f32>,
      @location(2) @interpolate(flat) color: vec4<f32>,
      @location(3) alpha: f32,
      @location(4) @interpolate(flat) kind: u32,
      @location(5) dash: f32,
    };

    fn nothing() -> VertexOutput {
      var out: VertexOutput;
      out.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
      return out;
    }

    fn axisXOf(d: u32) -> f32 {
      let t = axisConstants.axisX[d / 4u][d % 4u];
      return frameUniforms.rangeMin.x + t * (frameUniforms.rangeMax.x - frameUniforms.rangeMin.x);
    }

    fn axisAlpha(d: u32) -> f32 {
      return select(1.0, 0.6, i32(d) == axisConstants.dragged);
    }

    /** A solid quad from lo to hi (plot px). */
    fn solidQuad(lo: vec2<f32>, hi: vec2<f32>, corner: vec2<f32>, color: vec4<f32>, alpha: f32, kind: u32) -> VertexOutput {
      let p = lo + corner * (hi - lo);
      var out: VertexOutput;
      out.position = cellToClip(plotToCell(p));
      out.color = color;
      out.alpha = alpha;
      out.kind = kind;
      out.dash = p.y / frameUniforms.devicePixelRatio;
      return out;
    }

    /**
     * A text quad from atlas entry \`slot\` with its top left at \`origin\` (plot
     * px), grown by the halo's reach, or nothing.
     */
    fn textQuad(slot: f32, origin: vec2<f32>, corner: vec2<f32>, color: vec4<f32>, alpha: f32, kind: u32) -> VertexOutput {
      if (slot < 0.0) { return nothing(); }
      let rect = textAtlasEntries.rects[u32(slot)];
      if (rect.z <= 0.0 || rect.w <= 0.0) { return nothing(); }
      let reach = ceil(axisConstants.haloRadius * frameUniforms.devicePixelRatio);
      let local = corner * (rect.zw + 2.0 * reach) - reach;
      // Whole device pixels on the canvas: a texel lands on a pixel.
      let p = round(plotToCell(origin)) + local;
      var out: VertexOutput;
      out.position = cellToClip(p);
      out.texel = rect.xy + local;
      out.rect = rect;
      out.color = color;
      out.alpha = alpha;
      out.kind = kind;
      return out;
    }

    @vertex
    fn vertexMain(
      @location(0) corner: vec2<f32>,
      @builtin(instance_index) i: u32,
    ) -> VertexOutput {
      let n = axisConstants.axisCount;
      let perAxis = n * TICKS_PER_AXIS;
      let dpr = frameUniforms.devicePixelRatio;
      let plotW = frameUniforms.resolution.x;
      let plotH = frameUniforms.resolution.y;
      let lineW = dpr;

      // Axis lines.
      if (i < n) {
        let x = axisXOf(i);
        return solidQuad(vec2<f32>(x - lineW * 0.5, 0.0), vec2<f32>(x + lineW * 0.5, plotH),
          corner, axisConstants.color, axisAlpha(i), KIND_LINE);
      }

      // Tick marks, then tick labels.
      if (i < n + 2u * perAxis) {
        let j = (i - n) % perAxis;
        let isLabel = i >= n + perAxis;
        let d = j / TICKS_PER_AXIS;
        let t = ticks[j];
        let slot = t.z;
        if (t.y <= 0.0) { return nothing(); }
        let plotSpace = (axisConstants.plotSpaceMask >> d) & 1u;
        let plotPos = frameUniforms.rangeMax.y - t.x * (frameUniforms.rangeMax.y - frameUniforms.rangeMin.y);
        let at = select(scaleLinearYFrom(t.x, axisScales[d]), plotPos, plotSpace != 0u);
        // A tick beyond the plot (its axis panned) is not drawn.
        if (at < -0.5 || at > plotH + 0.5) { return nothing(); }
        let x = axisXOf(d);
        let alpha = t.y * axisAlpha(d);

        if (isLabel) {
          if (slot < 0.0) { return nothing(); }
          let size = textAtlasEntries.rects[u32(slot)].zw;
          // The first axis labels to its left, the last to its right, the rest centred.
          let v = axisConstants.visual[d / 4u][d % 4u];
          let gap = axisConstants.labelGap * dpr;
          var left = x - size.x * 0.5;
          if (v == 0u) { left = x - gap - size.x; }
          else if (v == n - 1u) { left = x + gap; }
          return textQuad(slot, vec2<f32>(left, at - size.y * 0.5), corner, axisConstants.color, alpha, KIND_TEXT);
        }

        // A tick mark waits for its label: during a pan a new tick would
        // otherwise show its mark a frame or two before the atlas paints its string.
        if (slot >= 0.0 && textAtlasEntries.rects[u32(slot)].z <= 0.0) { return nothing(); }
        let len = axisConstants.tickLength * dpr;
        return solidQuad(vec2<f32>(x - len, at - lineW * 0.5), vec2<f32>(x + len, at + lineW * 0.5),
          corner, axisConstants.color, alpha, KIND_LINE);
      }

      // Column names, below the plot.
      if (i < 2u * n + 2u * perAxis) {
        let d = i - n - 2u * perAxis;
        let slot = axisConstants.titleSlot[d / 4u][d % 4u];
        if (slot < 0.0) { return nothing(); }
        let size = textAtlasEntries.rects[u32(slot)].zw;
        let x = axisXOf(d);
        let isDragged = i32(d) == axisConstants.dragged;
        let color = select(axisConstants.color, axisConstants.accent, isDragged);
        return textQuad(slot, vec2<f32>(x - size.x * 0.5, plotH + axisConstants.titleGap * dpr),
          corner, color, axisAlpha(d), KIND_PLAIN_TEXT);
      }

      // The drop indicator: where the dragged axis would land.
      let slot = axisConstants.dropSlot;
      if (slot < 0 || n == 0u) { return nothing(); }
      let f = select(0.5, f32(slot) / f32(n - 1u), n > 1u);
      let x = frameUniforms.rangeMin.x + f * (frameUniforms.rangeMax.x - frameUniforms.rangeMin.x);
      let w = 2.0 * dpr;
      let over = 5.0 * dpr;
      return solidQuad(vec2<f32>(x - w * 0.5, -over), vec2<f32>(x + w * 0.5, plotH + over),
        corner, axisConstants.accent, 1.0, KIND_DASH);
    }

    @fragment
    fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
      if (input.kind == KIND_TEXT || input.kind == KIND_PLAIN_TEXT) {
        let coverage = atlasCoverageAt(input.rect, input.texel);
        let reach = axisConstants.haloRadius * frameUniforms.devicePixelRatio;
        var ring = 0.0;
        if (input.kind == KIND_TEXT) { ring = atlasHaloAt(input.rect, input.texel, reach); }
        // The string over its halo, both premultiplied.
        let textA = input.color.a * coverage;
        let haloA = axisConstants.halo.a * ring * (1.0 - textA);
        let rgb = (input.color.rgb * textA + axisConstants.halo.rgb * haloA) * input.alpha;
        return vec4<f32>(rgb, (textA + haloA) * input.alpha);
      }
      // Dashes of 4, gaps of 3 CSS pixels.
      if (input.kind == KIND_DASH && fract(input.dash / 7.0) >= 4.0 / 7.0) { discard; }
      let a = input.color.a * input.alpha;
      return vec4<f32>(input.color.rgb * a, a);
    }
  `;

	const rendererDefinition = {
		x: { concept: 'position', channels: ['x'] },
		y: { concept: 'position', channels: ['y'] }
	};

	const dataBindingConfig = [
		{ binding: BINDINGS.TICKS, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{
			binding: BINDINGS.CONSTANTS,
			type: 'uniform',
			visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
		},
		{ binding: BINDINGS.AXIS_SCALES, type: 'uniform', visibility: GPUShaderStage.VERTEX }
	];

	const vertexBufferLayout: GPUVertexBufferLayout[] = [
		{
			arrayStride: 2 * 4,
			attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }]
		}
	];

	// --- Ticks: uploaded one axis's region at a time ---

	const AXIS_FLOATS = TICKS_PER_AXIS * 4;
	let ticksUploaded = false;

	/** Upload axis `d`'s region of `ticks`, after its owner rewrote it. */
	export function uploadAxis(d: number): void {
		if (d < 0 || d >= MAX_AXES || !ticksUploaded) return;
		const r = renderer;
		const buffer = r?.getBuffer(BINDINGS.TICKS);
		if (!r || !buffer) return;
		const base = d * AXIS_FLOATS;
		webGPUContext.getDevice()!.queue.writeBuffer(buffer, base * 4, ticks, base, AXIS_FLOATS);
		r.invalidateLayer();
	}

	// --- Constants: one reused buffer, written when any of them changes ---

	const constantsBytes = new ArrayBuffer(UNIFORM_BYTES.parallelAxisConstants);
	const constantsView = new DataView(constantsBytes);
	const constantsU8 = new Uint8Array(constantsBytes);

	function writeColor(offset: number, rgba: [number, number, number, number]): void {
		for (let k = 0; k < 4; k++) constantsView.setFloat32(offset + k * 4, rgba[k], true);
	}

	$effect(() => {
		const r = renderer;
		if (!r?.resourcesCreated) return;
		const view = constantsView;
		const LE = true;
		writeColor(0, color);
		writeColor(16, accent);
		writeColor(32, halo);
		view.setUint32(48, Math.min(axisCount, MAX_AXES), LE);
		view.setInt32(52, dragged, LE);
		view.setInt32(56, dropSlot, LE);
		view.setUint32(60, plotSpaceMask, LE);
		view.setFloat32(64, tickLength, LE);
		view.setFloat32(68, labelGap, LE);
		view.setFloat32(72, haloRadius, LE);
		view.setFloat32(76, titleGap, LE);
		// Per data index: x and visual position, from the visual order. Evenly
		// spaced until the springs have positions for every axis.
		const n = Math.min(order.length, MAX_AXES);
		const sprung = positions.length === order.length;
		for (let v = 0; v < n; v++) {
			const d = order[v];
			if (d >= MAX_AXES) continue;
			const x = sprung ? positions[v] : n > 1 ? v / (n - 1) : 0.5;
			view.setFloat32(80 + d * 4, x, LE);
			view.setUint32(144 + d * 4, v, LE);
		}
		for (let d = 0; d < MAX_AXES; d++)
			view.setFloat32(208 + d * 4, d < titleSlots.length ? titleSlots[d] : -1, LE);
		r.writeUniform(BINDINGS.CONSTANTS, constantsU8);
	});

	// --- Each axis's scale params, from the coordinator (as ParallelLines) ---

	$effect(() => {
		const r = renderer;
		if (!r?.resourcesCreated || scaleIds.length === 0) return;
		const block = gpuCoordinator.registerScaleBlock(chartContext.chartId, {
			scaleIds: [...scaleIds],
			buffer: () => r.getBuffer(BINDINGS.AXIS_SCALES)
		});
		return () => block.remove();
	});

	const corners = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);

	function draw(pass: GPURenderPassEncoder) {
		if (!quadBuffer) return;
		const n = Math.min(axisCount, MAX_AXES);
		if (n === 0) return;
		pass.setVertexBuffer(0, quadBuffer);
		// Lines, tick marks, tick labels, names, and the drop indicator.
		pass.draw(6, 2 * n + 2 * n * TICKS_PER_AXIS + 1);
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
					label: 'axis-parallel-geometry'
				});
				device.queue.writeBuffer(quadBuffer, 0, corners);
				// Sized once, before the layer can draw: the ticks written so far,
				// and the scale params the coordinator fills from the first frame.
				r.writeAttribute(BINDINGS.TICKS, ticks);
				ticksUploaded = true;
				r.writeUniform(BINDINGS.AXIS_SCALES, new Uint8Array(UNIFORM_BYTES.parallelAxisScales));
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
