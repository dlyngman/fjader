<script lang="ts">
	import { getContext } from 'svelte';
	import type { ChartContext } from '$lib/types';
	import type { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
	import type { ScaleContinuousNumeric } from 'd3-scale';

	interface Props {
		ticksNumber?: number;
		tickFormat?: ((value: unknown) => string) | null;
	}

	let { ticksNumber = 5, tickFormat = null }: Props = $props();
	const c = getContext<ChartContext>('chart');

	const ps = $derived(c.parallelScales);

	// Single derived that reads _version from every scale state (via getTicks/updateScaleDomain).
	// Returns a new array each animation frame, so {#each} re-renders.
	const axes = $derived.by(() => {
		if (!ps) return [];
		const n = ps.columns.length;
		return ps.scaleStates.map((state, i) => {
			const s = state as LinearScaleState;
			const ticks = s.getTicks(ticksNumber);
			const base = s.getBaseScale('y', c.innerHeight);
			s.updateScaleDomain(base);
			const fmt = tickFormat ?? s.tickFormat(ticksNumber);
			const x = n > 1 ? (i / (n - 1)) * c.innerWidth : c.innerWidth / 2;
			return {
				column: ps.columns[i],
				ticks,
				scale: base as ScaleContinuousNumeric<number, number>,
				fmt,
				x
			};
		});
	});
</script>

{#if c.isReady && axes.length > 0}
	{#each axes as axis, i (i)}
		{@const anchor = i === 0 ? 'end' : i === axes.length - 1 ? 'start' : 'middle'}
		{@const labelX = i === 0 ? -8 : i === axes.length - 1 ? 8 : 0}
		<g class="parallel-axis" transform="translate({axis.x}, 0)">
			<line x1={0} x2={0} y1={0} y2={c.innerHeight} class="axis-line" />
			{#each axis.ticks as tick, j (j)}
				{@const y = axis.scale(tick)}
				<line x1={-4} x2={4} y1={y} y2={y} class="tick-line" />
				<text class="tick-halo" text-anchor={anchor} dominant-baseline="middle" x={labelX} y={y}>
					{axis.fmt(tick)}
				</text>
				<text class="tick-label" text-anchor={anchor} dominant-baseline="middle" x={labelX} y={y}>
					{axis.fmt(tick)}
				</text>
			{/each}

			<text class="axis-label" text-anchor="middle" y={c.innerHeight + 20}>
				{axis.column}
			</text>
		</g>
	{/each}
{/if}

<style>
	.axis-line {
		stroke: var(--diveplot-text-secondary, #6b7280);
		stroke-width: 1;
	}

	.tick-line {
		stroke: var(--diveplot-text-secondary, #6b7280);
	}

	.tick-halo {
		fill: none;
		stroke: var(--diveplot-bg, #ffffff);
		stroke-width: 3px;
		stroke-linejoin: round;
		font-family: var(--diveplot-font, system-ui, sans-serif);
		font-size: 10px;
	}

	.tick-label {
		fill: var(--diveplot-text-secondary, #6b7280);
		font-family: var(--diveplot-font, system-ui, sans-serif);
		font-size: 10px;
	}

	.axis-label {
		font-size: 11px;
		font-weight: 500;
		fill: var(--diveplot-text-primary, #374151);
	}
</style>
