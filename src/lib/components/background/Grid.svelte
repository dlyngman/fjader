<script lang="ts">
	import { getContext } from 'svelte';
	import type { ChartContext } from '$lib/types';

	interface Props {
		show?: 'both' | 'x' | 'y';
		ticksNumber?: number;
	}

	let { show = 'both', ticksNumber = 5 }: Props = $props();
	const c = getContext<ChartContext>('chart');
</script>

{#if c.xScale && c.yScale && c.innerHeight && c.innerWidth}
	<g class="axis-grid">
		{#if show === 'both' || show === 'y'}
			{#each c.yScale.ticks(ticksNumber) as tick, i (i)}
				<line x1={0} x2={c.innerWidth} y1={c.yScale(tick)} y2={c.yScale(tick)} />
			{/each}
		{/if}
		{#if show === 'both' || show === 'x'}
			{#each c.xScale.ticks(ticksNumber) as tick, i (i)}
				<line x1={c.xScale(tick)} x2={c.xScale(tick)} y1={0} y2={c.innerHeight} />
			{/each}
		{/if}
	</g>
{/if}

<style>
	line {
		stroke: var(--fjader-text-muted, #d1d5db);
	}
</style>
