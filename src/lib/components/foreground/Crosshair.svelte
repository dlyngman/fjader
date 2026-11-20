<script lang="ts">
	import { warnIfInChildren } from '$lib/components/charts/declarations.svelte';
	import { getContext } from 'svelte';
	import type { ChartContext } from '$lib/types';

	// An overlay draws its own SVG/HTML where it is placed: not yet a declaration.
	warnIfInChildren('Crosshair', 'foreground');

	interface Props {
		show?: 'both' | 'x' | 'y';
	}

	let { show = 'both' }: Props = $props();

	const c = getContext<ChartContext>('chart');

	const isValid = (val: unknown): val is number =>
		val !== null && val !== undefined && !isNaN(val as number);
</script>

{#if c.xScale && c.yScale && c.innerHeight && c.innerWidth}
	<g class="crosshair">
		{#if isValid(c.currentXScreenPoint) && (show === 'both' || show === 'x')}
			<line x1={c.currentXScreenPoint} y1={c.innerHeight} x2={c.currentXScreenPoint} y2={0} />
		{/if}
		{#if isValid(c.currentYScreenPoint) && (show === 'both' || show === 'y')}
			<line x1={0} y1={c.currentYScreenPoint} x2={c.innerWidth} y2={c.currentYScreenPoint} />
		{/if}
	</g>
{/if}

<style>
	line {
		stroke: var(--fjader-text-muted, #d1d5db);
	}
</style>
