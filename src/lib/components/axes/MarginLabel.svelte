<script lang="ts">
	import { getContext } from 'svelte';
	import type { ChartContext, ContinuousScaleState } from '$lib/types';

	interface Props {
		show?: 'both' | 'x' | 'y';
	}

	let { show = 'both' }: Props = $props();

	const c = getContext<ChartContext>('chart');

	const xFormatter = $derived(
		c.xScaleState && c.xScaleState.scaleType !== 'band' ? (v: unknown) => (c.xScaleState as ContinuousScaleState).formatValue(v as number) : String
	);
	const yFormatter = $derived(
		c.yScaleState && c.yScaleState.scaleType !== 'band' ? (v: unknown) => (c.yScaleState as ContinuousScaleState).formatValue(v as number) : String
	);
</script>

{#if c.xScale && c.yScale && c.innerHeight && c.innerWidth}
	<g class="margin-label">
		{#if c.currentXScreenPoint && c.currentXDataPoint && (show === 'both' || show === 'x') && c.active}
			<text text-anchor="middle" x={c.currentXScreenPoint} y={-5}>
				{xFormatter(c.currentXDataPoint)}
			</text>
		{/if}
		{#if c.currentYScreenPoint && c.currentYDataPoint && (show === 'both' || show === 'y') && c.active}
			<text
				text-anchor="start"
				dominant-baseline="middle"
				x={c.innerWidth + 5}
				y={c.currentYScreenPoint}
			>
				{yFormatter(c.currentYDataPoint)}
			</text>
		{/if}
	</g>
{/if}

<style>
	text {
		fill: var(--diveplot-text-secondary, #6b7280);
		font-family: var(--diveplot-font, system-ui, sans-serif);
		font-size: 10px;
	}
</style>
