<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { hasEntered } from '$lib/scales/entered';
	import { PARALLEL_TICKS_PER_AXIS } from '../rendering/uniform-sizes';
	import type { ContinuousScaleState } from '$lib/types';
	import type { TextAtlas, TextStyle } from '$lib/gpu/text/TextAtlas.svelte';

	/**
	 * One parallel axis's ticks, written into its region of the shared tick
	 * records (GpuParallelAxes) when they change. One per axis, so a pan or zoom
	 * of one axis re-ticks that axis alone; while its domain animates the tick
	 * values are the same frame to frame (placed by its scale on the GPU), and
	 * nothing is uploaded. Renders nothing.
	 */
	interface Props {
		/** The axis's data index: its region of `ticks`. */
		index: number;
		scale: ContinuousScaleState;
		ticksNumber: number;
		tickFormat: ((value: unknown) => string) | null;
		atlas: TextAtlas;
		style: TextStyle;
		ticks: Float32Array<ArrayBuffer>;
		/** After this axis's region changed: upload it. */
		upload: (index: number) => void;
		/** Whether this axis's positions are plot fractions (a crossfade). */
		setPlotSpace: (index: number, plotSpace: boolean) => void;
	}

	let { index, scale, ticksNumber, tickFormat, atlas, style, ticks, upload, setPlotSpace }: Props =
		$props();

	const T = PARALLEL_TICKS_PER_AXIS;
	/** What this pass writes, compared against the region before it is copied in. */
	const next = new Float32Array(T * 4);

	const formatter: (value: unknown) => string = $derived.by(() => {
		if (tickFormat) return tickFormat;
		const f = scale.tickFormat(ticksNumber) as (value: never) => string;
		return (value: unknown) => f(value as never);
	});

	// --- Label strings → atlas slots, as GpuAxis holds them ---

	const held = new Map<string, { slot: number; used: boolean }>();
	let formatted = new Map<number, string>();
	let formattedWith: unknown = null;

	function labelOf(value: number): string {
		if (formattedWith !== formatter) {
			formatted = new Map();
			formattedWith = formatter;
		}
		let s = formatted.get(value);
		if (s === undefined) {
			s = String(formatter(value));
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
		const slot = atlas.acquire(text, style);
		held.set(text, { slot, used: true });
		return slot;
	}

	function sweep(): void {
		for (const [text, entry] of held) {
			if (!entry.used) {
				atlas.release(entry.slot);
				held.delete(text);
			} else entry.used = false;
		}
	}

	/** Copy `next` (its first n records) into this axis's region if it differs. */
	function commit(n: number): void {
		const base = index * T * 4;
		for (let i = n * 4; i < T * 4; i += 4) {
			next[i] = 0;
			next[i + 1] = 0;
			next[i + 2] = -1;
			next[i + 3] = 0;
		}
		let same = true;
		for (let i = 0; same && i < T * 4; i++) {
			const a = next[i];
			const b = ticks[base + i];
			if (a !== b && !(a !== a && b !== b)) same = false;
		}
		if (same) return;
		ticks.set(next, base);
		upload(index);
	}

	$effect(() => {
		const s = scale;
		void formatter;
		// Not entered: its domain is a placeholder. No ticks, as GpuAxis.
		if (!hasEntered(s)) {
			untrack(() => {
				sweep();
				commit(0);
				setPlotSpace(index, false);
			});
			return;
		}
		const frame = s.tickFrame(ticksNumber);
		const crossfading = s.crossfading;
		untrack(() => {
			const n = Math.min(frame.length, T);
			for (let i = 0; i < n; i++) {
				const t = frame[i];
				next[i * 4] = crossfading ? t.position : t.value;
				next[i * 4 + 1] = t.alpha;
				next[i * 4 + 2] = slotOf(labelOf(t.value));
				next[i * 4 + 3] = 0;
			}
			sweep();
			commit(n);
			setPlotSpace(index, crossfading);
		});
	});

	onDestroy(() => {
		for (const entry of held.values()) atlas.release(entry.slot);
		held.clear();
		next.fill(0);
		commit(0);
	});
</script>
