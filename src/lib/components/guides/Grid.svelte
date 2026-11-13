<script lang="ts">
	import { hasEntered } from '$lib/scales/entered';
	import { getContext } from 'svelte';
	import { GridLine } from '../rendering';
	import type { ChartContext, ScaleStateInstance } from '$lib/types';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';

	interface Props {
		axis?: 'both' | 'x' | 'y';
		color?: [number, number, number, number];
		lineWidth?: number;
		zIndex?: number;
	}

	let {
		axis = 'both',
		color = [0.8, 0.8, 0.8, 0.4],
		lineWidth = 1,
		zIndex = -10
	}: Props = $props();

	const chartContext = getContext<ChartContext>('chart');

	// Get scales based on axis prop
	const xScale = $derived(axis === 'x' || axis === 'both' ? chartContext.xScaleState : null);
	const yScale = $derived(axis === 'y' || axis === 'both' ? chartContext.yScaleState : null);

	// A band axis draws a line for every id in its dim, positioned through the slot
	// table like a bar and faded with its category; `tickVisibility` is what each
	// line fades toward. Any other axis draws its ticks, fully.
	const xBand = $derived(chartContext.scaleTypes?.x === 'band');
	const yBand = $derived(chartContext.scaleTypes?.y === 'band');

	// One reusable buffer per axis. A continuous axis re-ticks on every pan frame,
	// so copying into a fresh array each time would allocate per frame; this
	// grows when a band axis's dim does and is otherwise reused. Uncapped: a band
	// axis draws a line per id in its dim.
	let xBuffer = new Float32Array(64);
	let yBuffer = new Float32Array(64);

	function ticksOf(scale: ScaleStateInstance | null, which: 'x' | 'y'): Float32Array | null {
		// None until the scale has entered: its domain is a placeholder before that.
		const ticks =
			scale?.getTicks && hasEntered(scale) ? (scale.getTicks() as ArrayLike<number>) : null;
		if (!ticks || ticks.length === 0) return null;
		let buffer = which === 'x' ? xBuffer : yBuffer;
		if (buffer.length < ticks.length) {
			buffer = new Float32Array(Math.max(ticks.length, buffer.length * 2));
			if (which === 'x') xBuffer = buffer;
			else yBuffer = buffer;
		}
		for (let i = 0; i < ticks.length; i++) buffer[i] = ticks[i];
		return buffer.subarray(0, ticks.length);
	}

	function visibilityOf(scale: ScaleStateInstance | null, band: boolean): Float32Array | null {
		return band && scale ? (scale as BandScaleState).tickVisibility() : null;
	}

	const xTickValues = $derived(ticksOf(xScale, 'x'));
	const yTickValues = $derived(ticksOf(yScale, 'y'));
	const xAlpha = $derived(visibilityOf(xScale, xBand));
	const yAlpha = $derived(visibilityOf(yScale, yBand));
	// A band axis's line opacity follows its layout: when that landed at once
	// (a catch-up result), the opacity lands with it.
	const landedOf = (scale: ScaleStateInstance | null, band: boolean) =>
		band && scale ? (scale as BandScaleState).slotsLandedLayout : 0;
	const xLands = $derived(landedOf(xScale, xBand));
	const yLands = $derived(landedOf(yScale, yBand));
</script>

{#if xTickValues}
	<GridLine
		axis="x"
		positions={xTickValues}
		alpha={xAlpha}
		landsFor={xLands}
		bandAxis={xBand ? 'x' : null}
		{color}
		{lineWidth}
		{zIndex}
	/>
{/if}
{#if yTickValues}
	<GridLine
		axis="y"
		positions={yTickValues}
		alpha={yAlpha}
		landsFor={yLands}
		bandAxis={yBand ? 'y' : null}
		{color}
		{lineWidth}
		{zIndex}
	/>
{/if}
