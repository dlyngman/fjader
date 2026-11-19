<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { hasEntered } from '$lib/scales/entered';
	import AxisRenderer from '../rendering/AxisRenderer.svelte';
	import { categoryLabel } from '$lib/query-engine/categorical-identity';
	import { dimsBySelection } from '$lib/components/rendering/activity-reads';
	import { clearTitleOffset, textWidth } from './axis-title';
	import type { AxisSpec, AxisTitle } from './axis-registry.svelte';
	import type { TextAtlas, TextStyle } from '$lib/gpu/text/TextAtlas.svelte';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import type { ChartContext, ContinuousScaleState, WebGPUCanvasContext } from '$lib/types';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

	/**
	 * One declared axis (axis-registry), drawn on the GPU (AxisRenderer).
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
	/** The axes' colour, as the SVG axes drew them. */
	const color = canvas.getCssColor('--fjader-text-secondary', '#6b7280');

	const scale = $derived(axis === 'x' ? c.xScaleState : c.yScaleState);
	const band = $derived(c.scaleTypes?.[axis] === 'band');
	const formatter: (value: unknown) => string = $derived.by(() => {
		if (spec.tickFormat) return spec.tickFormat;
		const f = scale?.tickFormat ? (scale.tickFormat() as (value: never) => string) : null;
		return f ? (value: unknown) => f(value as never) : (value: unknown) => String(value);
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

	let ticks = $state(new Float32Array(4));

	/**
	 * Replace the tick data only when it differs: while a domain animates the
	 * tick frame is a new array every frame with the same values (they are data
	 * values, placed by the scale on the GPU), and an upload per frame of the
	 * same numbers is work for nothing.
	 */
	function setTicks(out: Float32Array<ArrayBuffer>, n: number, plot: boolean): void {
		const same =
			n === count &&
			plot === plotSpace &&
			out.length === ticks.length &&
			out.every((v, i) => v === ticks[i] || (v !== v && ticks[i] !== ticks[i]));
		if (same) return;
		ticks = out;
		count = n;
		plotSpace = plot;
	}
	let count = $state(0);
	let plotSpace = $state(false);
	/** The ticks the title offset was last measured from, and the widest label seen. */
	let widest = 0;

	$effect(() => {
		const s = scale;
		const isBand = band;
		const n = spec.ticksNumber;
		void formatter;
		if (!s || !c.scaleTypes) return;
		if (isBand) {
			const b = s as BandScaleState;
			const list = b.bandTicks();
			const key = b.identityKey ?? b.sourceField;
			const gs = groups;
			// Tracked: a selection's fade moves label opacities with no change to
			// the ticks. Only writing the results is untracked.
			{
				const out = new Float32Array(Math.max(4, list.length * 4));
				for (let i = 0; i < list.length; i++) {
					const tick = list[i];
					const selected = !filterGroups
						? 1
						: b.hasIdentity
							? filterGroups.opacityOfId(key, gs, tick.key)
							: filterGroups.opacityOfValue(key, gs, tick.value);
					const text = labelOf(tick.value, true);
					widest = Math.max(widest, textWidth(text));
					out[i * 4] = tick.key;
					out[i * 4 + 1] = b.tickOpacity(tick.key) * selected;
					out[i * 4 + 2] = slotOf(text);
				}
				untrack(() => {
					sweep();
					setTicks(out, list.length, false);
				});
			}
			return;
		}
		if (!hasEntered(s) || !('tickFrame' in s)) return;
		const cs = s as ContinuousScaleState;
		const frame = cs.tickFrame(n);
		const crossfading = cs.crossfading;
		untrack(() => {
			const out = new Float32Array(Math.max(4, frame.length * 4));
			for (let i = 0; i < frame.length; i++) {
				const t = frame[i];
				const text = labelOf(t.value, false);
				if (t.target) widest = Math.max(widest, textWidth(text));
				out[i * 4] = crossfading ? t.position : t.value;
				out[i * 4 + 1] = t.alpha;
				out[i * 4 + 2] = slotOf(text);
			}
			sweep();
			setTicks(out, frame.length, crossfading);
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
		void count;
		const offset =
			spec.titleOffset === 'auto' ? clearTitleOffset(widest, c.margin.left) : spec.titleOffset;
		return { slot, mode: 3, offset };
	});

	onDestroy(() => {
		for (const entry of held.values()) atlas.release(entry.slot);
		held.clear();
		if (titleSlot >= 0) atlas.release(titleSlot);
	});
</script>

{#if c.isReady && c.scaleTypes}
	<AxisRenderer {axis} {ticks} {count} {plotSpace} {title} {color} />
{/if}
