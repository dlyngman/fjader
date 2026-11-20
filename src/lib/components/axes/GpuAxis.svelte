<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { hasEntered } from '$lib/scales/entered';
	import AxisRenderer from '../rendering/AxisRenderer.svelte';
	import { categoryLabel } from '$lib/query-engine/categorical-identity';
	import { dimsBySelection } from '$lib/components/rendering/activity-reads';
	import { clearTitleOffset, textWidth } from './axis-title';
	import type { AxisSpec, AxisTitle } from './axis-spec';
	import type { TextAtlas, TextStyle } from '$lib/gpu/text/TextAtlas.svelte';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import type { ChartContext, ContinuousScaleState, WebGPUCanvasContext } from '$lib/types';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

	/**
	 * One declared axis (charts/declarations), drawn on the GPU (AxisRenderer).
	 *
	 * What it computes, whenever the axis changes: per tick its position, its
	 * opacity and its label's atlas slot. The same sources the SVG axes read:
	 * a continuous scale's `tickFrame` (live ticks, or two sets crossfading in
	 * place), a band scale's `bandTicks` with each label's opacity (travel and
	 * selection dimming). No DOM: a few numbers per tick, written to the GPU.
	 *
	 * Labels: each distinct string is acquired from the chart's text atlas once
	 * and kept while a tick shows it; a new string draws once the atlas paints
	 * it (its entry is empty until then, which draws nothing), as a new tick's
	 * crossfade starts transparent anyway.
	 */

	interface Props {
		spec: AxisSpec;
	}

	let { spec }: Props = $props();

	const c = getContext<ChartContext>('chart');
	const atlas = getContext<TextAtlas>('text-atlas');
	const canvas = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const filterGroups = getContext<FilterGroupRegistry | undefined>('filter-groups');

	const axis = untrack(() => (spec.side === 'bottom' ? 'x' : 'y'));
	const STYLE: TextStyle = { fontSize: 10, fontWeight: 'normal', fontFamily: null };
	/**
	 * The axes' colour, as the SVG axes drew them, and following it: a theme
	 * switch or a changed custom property reaches the GPU through the atlas's
	 * swatch for it (TextAtlas.watchColor).
	 */
	const AXIS_COLOR = 'var(--fjader-text-secondary, #6b7280)';
	const colorWatch = atlas.watchColor(
		AXIS_COLOR,
		canvas.getCssColor('--fjader-text-secondary', '#6b7280')
	);

	const scale = $derived(axis === 'x' ? c.xScaleState : c.yScaleState);
	const band = $derived(c.scaleTypes?.[axis] === 'band');
	/**
	 * The labels' formatter: one per set of ticks (tickFormatFor), not a new
	 * closure per frame of a pan, so formatted labels are kept until the ticks
	 * change. Returned as is: wrapping it would make a new function each time.
	 */
	// A custom tickFormat is the scale's format too (tooltips, MarginLabel). Set
	// here, per cell, not where the axis is declared: a declaration reads no
	// chart context (charts/declarations).
	$effect(() => {
		const s = scale;
		const format = spec.tickFormat;
		if (format && s && s.scaleType !== 'band') (s as ContinuousScaleState).setCustomFormat(format);
	});

	const formatter: (value: unknown) => string = $derived.by(() => {
		// A specifier string is applied by the scale's formatter (set above).
		if (typeof spec.tickFormat === 'function') return spec.tickFormat;
		const s = scale;
		if (s && 'tickFormatFor' in s)
			return (s as ContinuousScaleState).tickFormatFor() as (value: unknown) => string;
		return String;
	});

	// --- Label strings → atlas slots ---

	/** Acquired strings, and whether this pass used each. */
	const held = new Map<string, { slot: number; used: boolean }>();
	/** Formatted strings by value, for the formatter they were made with. */
	let formatted = new Map<unknown, string>();
	let formattedWith: unknown = null;

	function labelOf(value: unknown, isBand: boolean): string {
		if (formattedWith !== formatter) {
			formatted = new Map();
			formattedWith = formatter;
		}
		let s = formatted.get(value);
		if (s === undefined) {
			s = isBand ? String(categoryLabel(value)) : String(formatter(value));
			if (formatted.size > 4096) formatted.clear();
			formatted.set(value, s);
		}
		return s;
	}

	function slotOf(text: string): number {
		const entry = held.get(text);
		if (entry) {
			entry.used = true;
			return entry.slot;
		}
		const slot = atlas.acquire(text, STYLE);
		held.set(text, { slot, used: true });
		return slot;
	}

	/** Release what this pass did not use; mark the rest unused for the next. */
	function sweep(): void {
		for (const [text, entry] of held) {
			if (!entry.used) {
				atlas.release(entry.slot);
				held.delete(text);
			} else entry.used = false;
		}
	}

	// --- Selection dimming on a band axis, as the SVG labels did ---

	/** The filter groups of the chart's marks that dim: a label dims with them. */
	const groups = $derived.by(() => {
		if (!filterGroups) return [];
		const indices: number[] = [];
		for (const entry of c.config.entries.values()) {
			if (!dimsBySelection(entry.selectionResponse)) continue;
			const index = filterGroups.get(entry.selection).index;
			if (!indices.includes(index)) indices.push(index);
		}
		return indices;
	});

	// --- Per tick, whenever the axis changes ---

	/**
	 * The tick data the renderer has, and a second buffer each pass writes into:
	 * swapped in only when it differs. While a domain animates, the tick frame
	 * is the same values every frame (data values, placed by the scale on the
	 * GPU): no upload, and no allocation per frame. Grown, never shrunk.
	 */
	let ticks = $state(new Float32Array(64));
	let back = new Float32Array(64);
	let count = $state(0);
	let plotSpace = $state(false);

	function ensureBack(n: number): Float32Array<ArrayBuffer> {
		if (back.length < n * 4) back = new Float32Array(Math.max(n * 4, back.length * 2));
		return back;
	}

	/** Swap in `back` (its first n ticks) when it differs from what is drawn. */
	function commitTicks(n: number, plot: boolean): void {
		let same = n === count && plot === plotSpace && back.length === ticks.length;
		for (let i = 0; same && i < n * 4; i++) {
			const a = back[i];
			const b = ticks[i];
			if (a !== b && !(a !== a && b !== b)) same = false;
		}
		if (same) return;
		const drawn = ticks;
		ticks = back;
		back = drawn.length >= ticks.length ? drawn : new Float32Array(ticks.length);
		count = n;
		plotSpace = plot;
	}

	/**
	 * The widest label the title has to clear (titleOffset 'auto'): of the
	 * current scale, reset when the scale changes, as the SVG axis measured it.
	 */
	let widest = $state(0);
	let widestScale: unknown = null;
	function measure(text: string, scaleNow: unknown): void {
		if (scaleNow !== widestScale) {
			widestScale = scaleNow;
			widest = 0;
		}
		const w = textWidth(text);
		if (w > widest) widest = w;
	}

	/** The continuous frame and formatter the ticks were last written from. */
	let lastFrame: unknown = null;
	let lastFormat: unknown = null;

	$effect(() => {
		const s = scale;
		const isBand = band;
		const n = spec.ticksNumber;
		void formatter;
		// No scale yet, or not entered: no ticks. Cleared, not left: ticks of the
		// scale before (a band axis switched to a numeric one) would otherwise be
		// drawn through the new one.
		if (!s || !c.scaleTypes || (!isBand && (!hasEntered(s) || !('tickFrame' in s)))) {
			lastFrame = null;
			untrack(() => {
				sweep();
				commitTicks(0, false);
			});
			return;
		}
		if (isBand) {
			lastFrame = null;
			const b = s as BandScaleState;
			const list = b.bandTicks();
			const key = b.identityKey ?? b.sourceField;
			const gs = groups;
			// Tracked: a selection's fade moves label opacities with no change to
			// the ticks. Only the bookkeeping and the write are untracked.
			const out = ensureBack(list.length);
			for (let i = 0; i < list.length; i++) {
				const tick = list[i];
				const selected = !filterGroups
					? 1
					: b.hasIdentity
						? filterGroups.opacityOfId(key, gs, tick.key)
						: filterGroups.opacityOfValue(key, gs, tick.value);
				out[i * 4] = tick.key;
				out[i * 4 + 1] = b.tickOpacity(tick.key) * selected;
			}
			untrack(() => {
				for (let i = 0; i < list.length; i++) {
					const text = labelOf(list[i].value, true);
					measure(text, s);
					out[i * 4 + 2] = slotOf(text);
				}
				sweep();
				commitTicks(list.length, false);
			});
			return;
		}
		const cs = s as ContinuousScaleState;
		const frame = cs.tickFrame(n);
		const crossfading = cs.crossfading;
		const format = formatter;
		// At rest the same frame is the same ticks (tickFrame): nothing to do on
		// a pan frame that keeps them. A crossfade moves opacities every frame.
		if (!crossfading && frame === lastFrame && format === lastFormat) return;
		lastFrame = frame;
		lastFormat = format;
		untrack(() => {
			const out = ensureBack(frame.length);
			for (let i = 0; i < frame.length; i++) {
				const t = frame[i];
				const text = labelOf(t.value, false);
				if (t.target) measure(text, s);
				out[i * 4] = crossfading ? t.position : t.value;
				out[i * 4 + 1] = t.alpha;
				out[i * 4 + 2] = slotOf(text);
			}
			sweep();
			commitTicks(frame.length, crossfading);
		});
	});

	// --- The title ---

	let titleSlot = -1;
	let titleText: string | null = null;
	const titleString = $derived(spec.title ? ((axis === 'x' ? c.xLabel : c.yLabel) ?? null) : null);
	const titleSlotNow = $derived.by(() => {
		const text = titleString;
		return untrack(() => {
			if (text === titleText) return titleSlot;
			if (titleSlot >= 0) atlas.release(titleSlot);
			titleText = text;
			titleSlot = text ? atlas.acquire(text, STYLE) : -1;
			return titleSlot;
		});
	});

	const title: AxisTitle | null = $derived.by(() => {
		const slot = titleSlotNow;
		if (slot < 0) return null;
		if (axis === 'x') {
			const mode = spec.titleAnchor === 'start' ? 1 : spec.titleAnchor === 'end' ? 2 : 0;
			return { slot, mode, offset: 20 };
		}
		if (spec.titlePlacement === 'top') return { slot, mode: 4, offset: 10 };
		const offset =
			spec.titleOffset === 'auto' ? clearTitleOffset(widest, c.margin.left) : spec.titleOffset;
		return { slot, mode: 3, offset };
	});

	onDestroy(() => {
		for (const entry of held.values()) atlas.release(entry.slot);
		held.clear();
		if (titleSlot >= 0) atlas.release(titleSlot);
		atlas.unwatchColor(colorWatch);
	});
</script>

{#if c.isReady && c.scaleTypes}
	<AxisRenderer {axis} {ticks} {count} {plotSpace} {title} color={colorWatch.rgba} />
{/if}
