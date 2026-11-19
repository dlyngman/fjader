<script lang="ts">
	import { UNIFORM_BYTES } from './uniform-sizes';
	import { getContext, onMount, onDestroy } from 'svelte';
	import { RendererHost } from './RendererHost.svelte';
	import { getGPUContext } from '$lib/gpu';
	import { ATLAS_WGSL } from '$lib/gpu/text/atlas-bindings';
	import { isNanExpr } from '$lib/gpu/NanShaderLib';
	import type { ChartContext, WebGPUCanvasContext } from '$lib/types';
	import {
		LABEL_RENDERER_HOST,
		type LabelAnchor,
		type LabelFillMode,
		type LabelHostColor,
		type LabelRendererHost
	} from '../labels/label-host';

	/**
	 * Labels on a box-shaped mark (bars, rects), drawn from the mark's own
	 * record (gpu/placement.ts): one quad per drawn row, over its string's
	 * rectangle in the chart's text atlas, anchored on the row's box.
	 *
	 * It binds two buffers of its host's renderer, the record and this layer's
	 * slot channel, and nothing of the host's data. Where the record says the
	 * bar is this frame, the label is: through morphs, reorders, rebins (the
	 * slots ride holds and cuts as a host channel) and the entrance. Its
	 * opacity is the record's, so it dims and fades with its bar.
	 *
	 * Anchors run along the measure axis, from the bar's base to its end
	 * (record corners 0 and 1), so one set serves vertical and horizontal bars
	 * and bars below zero: `end` and `start` sit outside the bar, `inside-end`
	 * and `inside-start` inside, `center` in the middle. An inside label longer
	 * than its bar moves to the outside on the frame it stops fitting, decided
	 * per frame here, so a bar shrinking through its label pushes it out.
	 *
	 * Drawn in a layer above every mark (zIndex), so a label on one layer is
	 * never covered by the next layer's bars.
	 */

	const ANCHORS: Record<LabelAnchor, number> = {
		end: 0,
		'inside-end': 1,
		center: 2,
		'inside-start': 3,
		start: 4
	};
	const FILLS: Record<LabelFillMode, number> = { color: 0, inherit: 1, contrast: 2 };

	const BINDINGS = { RECORDS: 0, SLOTS: 1, CONSTANTS: 2, WHOLE: 3 };
	const LABEL_Z_INDEX = 1000;

	interface Props {
		/** The host's channels for this layer: atlas slots, and whether a label takes the whole bar. */
		slotBinding: number;
		wholeBinding: number;
		anchor?: LabelAnchor;
		fillMode?: LabelFillMode;
		/** `color` fill, and an outside label's colour under `contrast`. */
		color: [number, number, number, number];
		hostColor: LabelHostColor;
		measureAxis: 'x' | 'y';
		/** CSS pixels between a label and its bar's edge. */
		padding?: number;
		dx?: number;
		dy?: number;
		/** Strings changed: redraw (the atlas entries, not the slots, moved). */
		version?: number;
	}

	let {
		slotBinding,
		wholeBinding,
		anchor = 'end',
		fillMode = 'contrast',
		color,
		hostColor,
		measureAxis,
		padding = 3,
		dx = 0,
		dy = 0,
		version = 0
	}: Props = $props();

	const chartContext = getContext<ChartContext>('chart');
	const webGPUContext = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const labelHost = getContext<LabelRendererHost>(LABEL_RENDERER_HOST);
	const gpuCoordinator = getGPUContext();

	const host = new RendererHost({
		markType: `labels-${labelHost.recordKind}`,
		webGPUContext,
		gpuCoordinator,
		chartContext,
		zIndex: LABEL_Z_INDEX,
		label: 'BoxLabels'
	});
	const renderer = $derived(host.renderer);
	const initializationError = $derived(host.error);
	let quadBuffer: GPUBuffer;

	const shaderCode = `
    ${ATLAS_WGSL}
    ${labelHost.recordWGSL}

    struct LabelConstants {
      hostColor: vec4<f32>,      // the host's constant colour
      color: vec4<f32>,          // fill 'color', and outside labels under 'contrast'
      hostColorMode: u32,        // 0 constant, 1 by scale
      hostColorScaleIndex: u32,
      fillMode: u32,             // 0 color, 1 inherit, 2 contrast
      anchor: u32,               // 0 end, 1 inside-end, 2 center, 3 inside-start, 4 start
      measureAxis: u32,          // 0 x, 1 y
      padding: f32,              // CSS pixels
      dx: f32,
      dy: f32,
    };
    @group(1) @binding(${BINDINGS.CONSTANTS}) var<uniform> labelConstants: LabelConstants;
    @group(1) @binding(${BINDINGS.RECORDS}) var<storage, read> records: array<Record>;
    // Per row: its atlas slot; and 1 when it takes the whole bar (0: an Other
    // bar's label on the part a selection holds). Two columns of the host, one
    // f32 per row each, so rebin holds and cuts carry them as any channel.
    @group(1) @binding(${BINDINGS.SLOTS}) var<storage, read> slots: array<f32>;
    @group(1) @binding(${BINDINGS.WHOLE}) var<storage, read> wholes: array<f32>;

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) uv: vec2<f32>,
      @location(1) alpha: f32,
      @location(2) @interpolate(flat) colorValue: f32,
      @location(3) @interpolate(flat) outside: u32,
    };

    fn nothing() -> VertexOutput {
      var out: VertexOutput;
      out.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
      return out;
    }

    @vertex
    fn vertexMain(
      @location(0) corner: vec2<f32>,
      @builtin(instance_index) i: u32,
    ) -> VertexOutput {
      if (i >= arrayLength(&slots)) { return nothing(); }
      let slot = slots[i];
      if (slot < 0.0) { return nothing(); }
      let whole = select(1.0, wholes[i], i < arrayLength(&wholes));
      let rect = textAtlasEntries.rects[u32(slot)];
      if (rect.z <= 0.0 || rect.w <= 0.0) { return nothing(); }
      let r = records[i];
      // A bar the scales put nowhere (a category not displayed) has no label.
      // Bit tests: Apple GPUs fold v != v away (NanShaderLib).
      if (${isNanExpr('r.box.x')} || ${isNanExpr('r.box.y')} || ${isNanExpr('r.box.z')} || ${isNanExpr('r.box.w')}) {
        return nothing();
      }

      let dpr = frameUniforms.devicePixelRatio;
      let m = labelConstants.measureAxis;   // the measure axis, 0 x or 1 y
      let c = 1u - m;                       // the cross axis
      let base = r.box.xy;
      // An Other bar's label sits on the part a selection holds (share 1 + s,
      // morphing with the bar): on the measure axis its end is that part's end.
      // The cross axis keeps the bar's full width.
      let held = select(1.0, clamp(r.share - 1.0, 0.0, 1.0), r.share > 0.5 && whole < 0.5);
      var end = r.box.zw;
      end[m] = base[m] + (end[m] - base[m]) * held;
      let size = rect.zw;
      let pad = labelConstants.padding * dpr;

      // Along the measure: from base to end. A bar of no length points the way
      // a positive one would: right on x, up on y.
      let along = end[m] - base[m];
      let dir = select(sign(along), select(1.0, -1.0, m == 1u), along == 0.0);
      let len = size[m];

      // An inside label that does not fit its bar goes outside, at the same end.
      var k = labelConstants.anchor;
      let fits = abs(along) - 2.0 * pad >= len;
      if (k == 1u && !fits) { k = 0u; }
      if (k == 3u && !fits) { k = 4u; }

      // The label's near edge on the measure axis, and which way it extends.
      var lo: f32;
      if (k == 2u) {
        lo = (base[m] + end[m] - len) * 0.5;
      } else {
        let atEnd = k <= 1u;
        let edge = select(base[m], end[m], atEnd);
        // end and start extend away from the bar; the inside anchors into it.
        let outward = select(-dir, dir, atEnd);
        let s = select(outward, -outward, k == 1u || k == 3u);
        let near = edge + s * pad;
        lo = select(near - len, near, s > 0.0);
      }
      var origin: vec2<f32>;
      origin[m] = lo;
      origin[c] = (base[c] + end[c] - size[c]) * 0.5;
      // Whole device pixels: one atlas texel per pixel.
      origin = round(origin + vec2<f32>(labelConstants.dx, labelConstants.dy) * dpr);

      let atlasSize = vec2<f32>(textureDimensions(textAtlas));
      var out: VertexOutput;
      // To clip space as Rects and Dots do (pixelsToClip is generated only for
      // renderers with axes; this one reads boxes already in pixels).
      let ndc = ((origin + corner * size) / frameUniforms.resolution) * 2.0 - 1.0;
      out.position = vec4<f32>(ndc.x, -ndc.y, 0.0, 1.0);
      out.uv = (rect.xy + corner * size) / atlasSize;
      out.alpha = r.alpha;
      out.colorValue = r.colorValue;
      out.outside = select(0u, 1u, k == 0u || k == 4u);
      return out;
    }

    fn hostColorOf(value: f32) -> vec4<f32> {
      if (labelConstants.hostColorMode == 0u) { return labelConstants.hostColor; }
      return getColorFromScale(labelConstants.hostColorScaleIndex, value, frameUniforms.nullColor);
    }

    @fragment
    fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
      let coverage = textureSample(textAtlas, textAtlasSampler, input.uv).a;
      var color = labelConstants.color;
      if (labelConstants.fillMode == 1u) {
        color = hostColorOf(input.colorValue);
      } else if (labelConstants.fillMode == 2u && input.outside == 0u) {
        // On the bar: black or white, whichever reads against its colour.
        let bar = hostColorOf(input.colorValue);
        let luminance = dot(bar.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
        color = select(vec4<f32>(1.0, 1.0, 1.0, 1.0), vec4<f32>(0.08, 0.08, 0.08, 1.0), luminance > 0.55);
      }
      let a = color.a * coverage * input.alpha;
      return vec4<f32>(color.rgb * a, a);
    }
  `;

	const dataBindingConfig = [
		{ binding: BINDINGS.RECORDS, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.SLOTS, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.WHOLE, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
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

	// The host's buffers, looked up when this layer binds (BaseGPURenderer.syncExternal).
	// Until they are set, the bind group holds stand-ins: nothing draws.
	let hostBound = false;
	$effect(() => {
		const r = renderer;
		if (!r?.resourcesCreated) return;
		const binding = slotBinding;
		const wholeAt = wholeBinding;
		r.setExternalBinding(BINDINGS.RECORDS, () =>
			labelHost.renderer()?.bufferFor(labelHost.recordBinding)
		);
		r.setExternalBinding(BINDINGS.SLOTS, () => labelHost.renderer()?.bufferFor(binding));
		r.setExternalBinding(BINDINGS.WHOLE, () => labelHost.renderer()?.bufferFor(wholeAt));
		hostBound = true;
	});

	$effect(() => {
		if (!renderer?.resourcesCreated) return;
		void version;
		const buffer = new ArrayBuffer(UNIFORM_BYTES.labelConstants);
		const view = new DataView(buffer);
		const LE = true;
		for (let k = 0; k < 4; k++) view.setFloat32(k * 4, hostColor.constant[k], LE);
		for (let k = 0; k < 4; k++) view.setFloat32(16 + k * 4, color[k], LE);
		view.setUint32(32, hostColor.mode, LE);
		view.setUint32(36, hostColor.scaleIndex, LE);
		view.setUint32(40, FILLS[fillMode], LE);
		view.setUint32(44, ANCHORS[anchor], LE);
		view.setUint32(48, measureAxis === 'x' ? 0 : 1, LE);
		view.setFloat32(52, padding, LE);
		view.setFloat32(56, dx, LE);
		view.setFloat32(60, dy, LE);
		renderer.writeUniform(BINDINGS.CONSTANTS, new Uint8Array(buffer));
	});

	const corners = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);

	function draw(pass: GPURenderPassEncoder) {
		const hostRenderer = labelHost.renderer();
		const count = hostRenderer?.instanceCount ?? 0;
		if (!hostBound || !quadBuffer || count === 0 || !renderer.syncExternal()) return;
		// Set here, after the sync: a rebuild this frame replaced the bind group
		// the coordinator set before calling this.
		pass.setBindGroup(1, renderer.perDataBindGroup!);
		pass.setVertexBuffer(0, quadBuffer);
		pass.draw(6, count);
	}

	onMount(() =>
		host.mount({
			init: {
				markShaderCode: shaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition: { x: null, y: null, placeholders: {} }
			},
			async ready(r) {
				const device = webGPUContext.getDevice()!;
				quadBuffer = device.createBuffer({
					size: corners.byteLength,
					usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
					label: 'box-labels-geometry'
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
	<div class="box-labels-error">{initializationError}</div>
{/if}
