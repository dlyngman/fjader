<script lang="ts">
	import { getContext } from 'svelte';
	import { RuleX, RuleY } from '../rendering';
	import type { ChartContext, ScaleStateInstance } from '$lib/types';

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

	// =========================================================================
	// ZERO-ALLOCATION TICK BUFFERS (one per axis)
	// =========================================================================
	const MAX_TICKS = 200;
	const xTickBuffer = new Float32Array(MAX_TICKS);
	const yTickBuffer = new Float32Array(MAX_TICKS);

	let xTickValues = $state(null);
	let yTickValues = $state(null);

	// Helper: fill buffer from scale ticks (zero-allocation)
	function fillTickBuffer(scale: ScaleStateInstance, buffer: Float32Array) {
		const newTicks = scale?.getTicks ? scale.getTicks() : [];
		const count = Math.min(newTicks.length, MAX_TICKS);

		if (count > 0) {
			for (let i = 0; i < count; i++) {
				buffer[i] = newTicks[i];
			}
			return buffer.subarray(0, count);
		}
		return null;
	}

	// X axis ticks
	$effect(() => {
		xTickValues = xScale ? fillTickBuffer(xScale, xTickBuffer) : null;
	});

	// Y axis ticks
	$effect(() => {
		yTickValues = yScale ? fillTickBuffer(yScale, yTickBuffer) : null;
	});
</script>

{#if xTickValues}
	<RuleX positions={xTickValues} {color} {lineWidth} {zIndex} />
{/if}
{#if yTickValues}
	<RuleY positions={yTickValues} {color} {lineWidth} {zIndex} />
{/if}
