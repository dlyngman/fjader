<script lang="ts">
	import { hasEntered } from '$lib/scales/entered';
	import { getContext } from 'svelte';
	import { GridLine } from '../rendering';
	import type { ChartContext, ContinuousScaleState, ScaleStateInstance } from '$lib/types';
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
	let xBuffer: Float32Array<ArrayBuffer> = new Float32Array(64);
	let yBuffer: Float32Array<ArrayBuffer> = new Float32Array(64);
	// A continuous axis's line opacities (its tick frame), reused like the positions.
	let xAlphaBuffer: Float32Array<ArrayBuffer> = new Float32Array(64);
	let yAlphaBuffer: Float32Array<ArrayBuffer> = new Float32Array(64);
	/** A continuous axis's opacities, as ticksOf last wrote them. */
	let xFrameAlpha: Float32Array<ArrayBuffer> | null = null;
	let yFrameAlpha: Float32Array<ArrayBuffer> | null = null;

	function grow(buffer: Float32Array<ArrayBuffer>, n: number): Float32Array<ArrayBuffer> {
		return buffer.length >= n ? buffer : new Float32Array(Math.max(n, buffer.length * 2));
	}

	function ticksOf(
		scale: ScaleStateInstance | null,
		which: 'x' | 'y',
		band: boolean
	): Float32Array | null {
		// None until the scale has entered: its domain is a placeholder before that.
		if (!scale || !hasEntered(scale)) return null;
		if (!band && 'tickFrame' in scale) {
			// The axis's own tick frame: through a discrete change, each line where
			// its set puts it (as a value under the domain drawn now) and faded as
			// that set is; at rest the live ticks, fully drawn.
			const continuous = scale as ContinuousScaleState;
			const frame = continuous.tickFrame();
			if (frame.length === 0) return null;
			const positions = grow(which === 'x' ? xBuffer : yBuffer, frame.length);
			const alphas = grow(which === 'x' ? xAlphaBuffer : yAlphaBuffer, frame.length);
			for (let i = 0; i < frame.length; i++) {
				positions[i] = continuous.valueAt(frame[i].position);
				alphas[i] = frame[i].alpha;
			}
			const alpha = alphas.subarray(0, frame.length);
			if (which === 'x') {
				xBuffer = positions;
				xAlphaBuffer = alphas;
				xFrameAlpha = alpha;
			} else {
				yBuffer = positions;
				yAlphaBuffer = alphas;
				yFrameAlpha = alpha;
			}
			return positions.subarray(0, frame.length);
		}
		const ticks = scale.getTicks ? (scale.getTicks() as ArrayLike<number>) : null;
		if (!ticks || ticks.length === 0) return null;
		const buffer = grow(which === 'x' ? xBuffer : yBuffer, ticks.length);
		if (which === 'x') xBuffer = buffer;
		else yBuffer = buffer;
		for (let i = 0; i < ticks.length; i++) buffer[i] = ticks[i];
		return buffer.subarray(0, ticks.length);
	}

	function visibilityOf(scale: ScaleStateInstance | null, band: boolean): Float32Array | null {
		return band && scale ? (scale as BandScaleState).tickVisibility() : null;
	}

	const xTickValues = $derived(ticksOf(xScale, 'x', xBand));
	const yTickValues = $derived(ticksOf(yScale, 'y', yBand));
	// Read after the positions, which wrote a continuous axis's opacities.
	const xAlpha = $derived(xTickValues && (xBand ? visibilityOf(xScale, true) : xFrameAlpha));
	const yAlpha = $derived(yTickValues && (yBand ? visibilityOf(yScale, true) : yFrameAlpha));
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
