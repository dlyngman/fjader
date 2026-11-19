<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import ParallelAxisRenderer from '../rendering/ParallelAxisRenderer.svelte';
	import ParallelAxisTicks from './ParallelAxisTicks.svelte';
	import { PARALLEL_MAX_AXES, PARALLEL_TICKS_PER_AXIS } from '../rendering/uniform-sizes';
	import type { ParallelAxesSpec } from './axis-registry.svelte';
	import type { TextAtlas, TextStyle } from '$lib/gpu/text/TextAtlas.svelte';
	import type { ChartContext, ContinuousScaleState, WebGPUCanvasContext } from '$lib/types';

	/**
	 * A parallel coordinates chart's declared axes (ParallelAxes), drawn on the
	 * GPU (ParallelAxisRenderer).
	 *
	 * What runs on the main thread: per axis, its ticks when they change
	 * (ParallelAxisTicks, one per axis); the column names when the columns
	 * change; and while a reorder moves, the axes' x positions, one uniform write
	 * a frame, as the lines get them. No DOM.
	 */
	interface Props {
		spec: ParallelAxesSpec;
	}

	let { spec }: Props = $props();

	const c = getContext<ChartContext>('chart');
	const atlas = getContext<TextAtlas>('text-atlas');
	const canvas = getContext<WebGPUCanvasContext>('webgpu-canvas');

	/** The axes' text: tick labels and column names, as GpuAxis draws its ticks and title. */
	const STYLE: TextStyle = { fontSize: 10, fontWeight: 'normal', fontFamily: null };

	/**
	 * Colours as the chart's axes draw them, followed through theme switches
	 * (TextAtlas.watchColor). Ticks and column names in one style and colour, as
	 * AxisBottom's title: the accent marks the axis being dragged.
	 */
	const watch = (css: string, property: string, fallback: string) =>
		atlas.watchColor(css, canvas.getCssColor(property, fallback));
	const axisColor = watch(
		'var(--fjader-text-secondary, #6b7280)',
		'--fjader-text-secondary',
		'#6b7280'
	);
	const accentColor = watch('var(--fjader-accent, #3b82f6)', '--fjader-accent', '#3b82f6');
	const haloColor = watch('var(--fjader-bg, #ffffff)', '--fjader-bg', '#ffffff');

	const ps = $derived(c.parallelScales);
	const axisCount = $derived(Math.min(ps?.columns.length ?? 0, PARALLEL_MAX_AXES));

	/** The scales' ids in data order, as one key: stable while they are the same. */
	const scaleKey = $derived(ps ? ps.scaleStates.map((s) => s.id).join('\n') : '');
	const scaleIds = $derived(scaleKey ? scaleKey.split('\n') : []);

	// --- Ticks: every axis's region, written by its ParallelAxisTicks ---

	const ticks = new Float32Array(PARALLEL_MAX_AXES * PARALLEL_TICKS_PER_AXIS * 4);
	for (let i = 2; i < ticks.length; i += 4) ticks[i] = -1;

	let renderer: ParallelAxisRenderer | undefined = $state();
	const upload = (index: number) => renderer?.uploadAxis(index);

	let plotSpaceMask = $state(0);
	function setPlotSpace(index: number, plotSpace: boolean): void {
		const bit = 1 << index;
		const mask = plotSpace ? plotSpaceMask | bit : plotSpaceMask & ~bit;
		if (mask !== plotSpaceMask) plotSpaceMask = mask;
	}

	// --- Column names ---

	let titleText: (string | null)[] = [];
	let titleSlots: number[] = [];
	const titles = $derived.by(() => {
		const columns = ps?.columns ?? [];
		return untrack(() => {
			const n = Math.min(columns.length, PARALLEL_MAX_AXES);
			let changed = n !== titleSlots.length;
			for (let d = 0; !changed && d < n; d++) changed = columns[d] !== titleText[d];
			if (!changed) return titleSlots;
			const slots: number[] = [];
			const text: string[] = [];
			for (let d = 0; d < n; d++) {
				const i = titleText.indexOf(columns[d]);
				if (i >= 0) {
					slots.push(titleSlots[i]);
					titleText[i] = null;
				} else slots.push(atlas.acquire(columns[d], STYLE));
				text.push(columns[d]);
			}
			for (let i = 0; i < titleSlots.length; i++)
				if (titleText[i] !== null) atlas.release(titleSlots[i]);
			titleText = text;
			titleSlots = slots;
			return slots;
		});
	});

	// --- Reorder: the dragged axis, and where it would land ---

	const reorder = $derived(c.parallelReorderState);
	const dragged = $derived(reorder?.dataIdx ?? -1);
	const dropSlot = $derived.by(() => {
		const x = reorder?.currentX;
		if (dragged < 0 || x == null || !ps) return -1;
		// The count the shader spaces the axes by.
		const n = axisCount;
		const w = c.innerWidth;
		let best = 0;
		let bestDist = Infinity;
		for (let v = 0; v < n; v++) {
			const dist = Math.abs(x - (n > 1 ? (v / (n - 1)) * w : w / 2));
			if (dist < bestDist) {
				bestDist = dist;
				best = v;
			}
		}
		return best === ps.axisOrder.indexOf(dragged) ? -1 : best;
	});

	onDestroy(() => {
		for (let i = 0; i < titleSlots.length; i++) atlas.release(titleSlots[i]);
		titleSlots = [];
		for (const color of [axisColor, accentColor, haloColor]) atlas.unwatchColor(color);
	});
</script>

{#if c.isReady && ps && axisCount > 0}
	<!-- Keyed by index too: an axis whose index moves owns another region. -->
	{#each ps.scaleStates.slice(0, PARALLEL_MAX_AXES) as scale, d (`${d}:${scale.id}`)}
		<ParallelAxisTicks
			index={d}
			scale={scale as ContinuousScaleState}
			ticksNumber={spec.ticksNumber}
			tickFormat={spec.tickFormat}
			{atlas}
			style={STYLE}
			{ticks}
			{upload}
			{setPlotSpace}
		/>
	{/each}
	<ParallelAxisRenderer
		bind:this={renderer}
		{axisCount}
		{scaleIds}
		{ticks}
		order={ps.axisOrder}
		positions={c.animatedAxisXPositions ?? []}
		titleSlots={titles}
		{dragged}
		{dropSlot}
		{plotSpaceMask}
		color={axisColor.rgba}
		accent={accentColor.rgba}
		halo={haloColor.rgba}
	/>
{/if}
