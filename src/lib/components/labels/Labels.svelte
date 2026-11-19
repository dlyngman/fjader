<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import BoxLabels from '../rendering/BoxLabels.svelte';
	import { parseColorToRGBA } from '$lib/scales/color-utils';
	import type { TextAtlas, TextStyle } from '$lib/gpu/text/TextAtlas.svelte';
	import { TextSlots } from '$lib/gpu/text/TextSlots';
	import type { ChartContext, FieldRef, WebGPUCanvasContext } from '$lib/types';
	import {
		LABEL_MARK_HOST,
		LABEL_RENDERER_HOST,
		type LabelAnchor,
		type LabelFillMode,
		type LabelMarkHost
	} from './label-host';
	import type { LabelRendererHolder } from './LabelRendererHolder.svelte';

	/**
	 * Labels on the mark this is a child of:
	 *
	 * ```svelte
	 * <BarMarkY table="flights" x="carrier" y={count()}>
	 *   <Labels />
	 * </BarMarkY>
	 * ```
	 *
	 * One label per drawn row, where the mark's placement put the row this
	 * frame (labels/label-host.ts). It runs no query of its own: the text is the
	 * mark's (its measure by default, a channel of it, or a column it adds to the
	 * mark's query), so labels and bars are always the same rows.
	 */

	interface Props {
		/**
		 * The text: a column or expression, added to the mark's query (a category
		 * by its column: `text="carrier"`), or one of the mark's measure channels
		 * (`'y'`, `'y1'`, `'y2'`, `'x1'`, `'x2'`). Default: each row's own measure
		 * (a stacked segment's, not the stack's); on an Other bar, the part a
		 * selection holds, where the label then sits.
		 *
		 * Known limit: a column added to an aggregating mark's query is a grouping
		 * key too. A category column the mark already groups by is harmless; on a
		 * mark with a topN Other bucket it splits Other back into its members, so
		 * label such a mark by its measure (the default).
		 */
		text?: FieldRef;
		/** Formats a value. Default: numbers to at most two decimals, grouped. */
		format?: (value: unknown) => string;
		/** Where on the bar: `end` (default), `inside-end`, `center`, `inside-start`, `start`. */
		anchor?: LabelAnchor;
		/**
		 * `contrast` (default): black or white against the bar on an inside label,
		 * the chart's text colour outside. `inherit`: the bar's colour. Or a colour.
		 */
		fill?: 'contrast' | 'inherit' | string;
		fontSize?: number;
		fontWeight?: string;
		fontFamily?: string | null;
		/** CSS pixels between a label and its bar's edge. */
		padding?: number;
		dx?: number;
		dy?: number;
	}

	let {
		text = undefined,
		format = defaultFormat,
		anchor = 'end',
		fill = 'contrast',
		fontSize = 11,
		fontWeight = 'normal',
		fontFamily = null,
		padding = 3,
		dx = 0,
		dy = 0
	}: Props = $props();

	const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
	function defaultFormat(value: unknown): string {
		return typeof value === 'number' ? numberFormat.format(value) : String(value);
	}

	const markHost = getContext<LabelMarkHost | undefined>(LABEL_MARK_HOST);
	const rendererHost = getContext<LabelRendererHolder | undefined>(LABEL_RENDERER_HOST);
	const textAtlas = getContext<TextAtlas | undefined>('text-atlas');
	const canvas = getContext<WebGPUCanvasContext | undefined>('webgpu-canvas');
	const chartContext = getContext<ChartContext>('chart');
	if (!markHost || !rendererHost || !textAtlas || !canvas) {
		throw new Error(
			"<Labels> attaches to a mark: place it inside one, as in <BarMarkY …><Labels /></BarMarkY>, in the chart's canvasComponents."
		);
	}
	if (chartContext.fx) console.warn('[fjader] <Labels> does not draw in faceted charts yet.');

	/** This layer's slot channel on the host renderer: written there, so holds carry it. */
	const slotBinding = rendererHost.allocateSlotChannel();

	// --- The text column ---

	/**
	 * The mark's measure channels: read from its rows as they are. Not its band
	 * or colour channels, which carry category ids rather than names: a
	 * category is named by its column, which joins the query.
	 */
	const MARK_CHANNELS = new Set(['y', 'x1', 'x2', 'y1', 'y2', 'r']);
	const labelId = Math.random().toString(36).slice(2, 10);

	/** The column the text is read from, or null for the measure. */
	const textColumn = $derived.by((): string | null => {
		if (text === undefined) return null;
		if (typeof text === 'string' && MARK_CHANNELS.has(text)) return text;
		return `__label_${labelId}`;
	});

	// A column the mark does not select joins its query (once per change of `text`).
	$effect(() => {
		const column = textColumn;
		const field = text;
		if (!column?.startsWith('__label_') || field === undefined) return;
		return untrack(() => markHost.addSelect(column, field));
	});

	// --- Strings, per data change ---

	/**
	 * The strings, and per row whether its label takes the whole bar (1) or,
	 * on an Other bar with a selected part, sits on that part (0).
	 */
	const labelled = $derived.by((): { strings: (string | null)[]; whole: Float32Array } | null => {
		void markHost.dataVersion();
		const rows = markHost.rows();
		if (!rows || rows.length === 0) return null;
		const n = rows.length;
		const out = new Array<string | null>(n);
		const whole = new Float32Array(n).fill(1);
		const column = textColumn;
		if (column === null) {
			const { base, end } = markHost.measure();
			if (!end) return null;
			// An Other bar's label is the part the selection holds (share 1 + s),
			// unless none is selected: then the whole bar.
			const share = markHost.share();
			for (let i = 0; i < n; i++) {
				const total = end[i] - (base ? base[i] : 0);
				const s = share ? share.split[i] : 0;
				const part = s > 0.5 && share!.flat[i] !== 1;
				if (part) whole[i] = 0;
				const v = part ? total * Math.min(1, s - 1) : total;
				out[i] = Number.isFinite(v) ? format(v) : null;
			}
			return { strings: out, whole };
		}
		const values = rows.getColumn(column);
		if (!values) return null;
		for (let i = 0; i < n; i++) {
			const v = values[i];
			out[i] =
				v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v)) ? null : format(v);
		}
		return { strings: out, whole };
	});

	const style: TextStyle = $derived({ fontSize, fontWeight, fontFamily });

	/**
	 * New strings are staged and the rows switch to them once they are painted
	 * (gpu/text/TextSlots.ts), then the slots are written through the host
	 * renderer. A renderer that remounts gets the current slots written again.
	 */
	const textSlots = new TextSlots(textAtlas);
	let staged = $state(0);
	let version = $state(0);
	/** The staged rows' `whole` flags, written with the slots when they commit. */
	let stagedWhole: Float32Array | null = null;
	let committedWhole: Float32Array | null = null;
	$effect(() => {
		const rows = labelled;
		const s = style;
		untrack(() => {
			textSlots.stage(rows?.strings ?? null, s);
			stagedWhole = rows?.whole ?? null;
			staged++;
		});
	});

	/**
	 * The layer's channel: two floats per row, its atlas slot and whether it
	 * takes the whole bar. One buffer, so text and position switch together.
	 */
	function channel(slots: Float32Array, whole: Float32Array | null): Float32Array {
		const out = new Float32Array(slots.length * 2);
		for (let i = 0; i < slots.length; i++) {
			out[i * 2] = slots[i];
			out[i * 2 + 1] = whole ? whole[i] : 1;
		}
		return out;
	}
	let writtenTo: unknown = null;
	$effect(() => {
		void staged;
		void textAtlas.paintVersion;
		const renderer = rendererHost.renderer();
		if (!renderer?.resourcesCreated) return;
		untrack(() => {
			const committed = textSlots.commit();
			if (committed) committedWhole = stagedWhole;
			const slots = committed ?? (writtenTo !== renderer ? textSlots.current : null);
			if (!slots) return;
			renderer.writeAttribute(slotBinding, channel(slots, committedWhole));
			writtenTo = renderer;
			version++;
		});
	});

	// --- Colour ---

	const fillMode: LabelFillMode = $derived(
		fill === 'contrast' || fill === 'inherit' ? fill : 'color'
	);
	const color = $derived.by((): [number, number, number, number] => {
		if (fill !== 'contrast' && fill !== 'inherit') {
			const [r, g, b, a] = parseColorToRGBA(fill);
			return [r, g, b, a];
		}
		return canvas.getTextColor();
	});

	onDestroy(() => {
		textSlots.destroy();
		rendererHost.releaseSlotChannel(slotBinding);
	});
</script>

{#if !chartContext.fx && rendererHost.attached}
	<BoxLabels
		{slotBinding}
		{anchor}
		{fillMode}
		{color}
		hostColor={rendererHost.color()}
		measureAxis={markHost.measureAxis}
		{padding}
		{dx}
		{dy}
		{version}
	/>
{/if}
