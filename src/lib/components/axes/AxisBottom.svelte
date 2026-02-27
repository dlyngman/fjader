<script lang="ts">
	import { getContext } from 'svelte';
	import type { ChartContext, D3BandScale } from '$lib/types';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import type { ContinuousScaleState } from '$lib/types';

	interface Props {
		ticksNumber?: number;
		tickFormat?: ((value: unknown) => string) | null;
	}

	let { ticksNumber = 5, tickFormat = null }: Props = $props();
	const c = getContext<ChartContext>('chart');

	// Propagate custom format to scale state once it exists (for MarginLabel, tooltips, etc.)
	$effect(() => {
		const s = c.xScaleState;
		if (tickFormat && s && s.scaleType !== 'band') (s as ContinuousScaleState).setCustomFormat(tickFormat);
	});

	// Continuous scales (linear, time): use scaleState.getTicks()
	const continuousTicks = $derived(
		c.xScaleState?.getTicks ? c.xScaleState.getTicks(ticksNumber) : []
	);

	// Band scales: use D3 scale's domain() for category strings (needed for positioning)
	const bandTicks = $derived(c.xScale?.domain ? c.xScale.domain() : []);

	// Unified formatter interface - all scale states have tickFormat()
	const tickFormatter = $derived(c.xScaleState?.tickFormat ? c.xScaleState.tickFormat() : String);
</script>

{#if c.isReady && c.scaleTypes}
	<g class="axis" transform="translate(0 , {c.innerHeight})">
		{#if (c.scaleTypes.x === 'linear' || c.scaleTypes.x === 'time') && c.xScale}
			<!-- Continuous scales: direct positioning -->
			{#each continuousTicks as tick, i (i)}
				<line x1={c.xScale(tick)} x2={c.xScale(tick)} y1={0} y2={5} />

				<text text-anchor="middle" x={c.xScale(tick)} y={16}>
					{tickFormatter(tick)}
				</text>
			{/each}

			<text text-anchor="middle" x={c.innerWidth / 2} y={28}>
				{c.xLabel}
			</text>
		{:else if c.scaleTypes.x === 'band' && c.xScale}
			<!-- Band scales: centered positioning -->
			{@const bandState = c.xScaleState as BandScaleState}
			{@const bandScale = c.xScale as D3BandScale}
			{#each bandTicks as tick (tick)}
				{@const tickX = c.xScale(tick)}
				<g class:tick-dimmed={bandState.activeValues != null && !bandState.isActive(tick as string)}>
					<line
						x1={tickX + bandScale.bandwidth() / 2}
						x2={tickX + bandScale.bandwidth() / 2}
						y1={0}
						y2={5}
					/>

					<text text-anchor="middle" x={tickX + bandScale.bandwidth() / 2} y={16}>
						{tick}
					</text>
				</g>
			{/each}

			<text text-anchor="middle" x={c.innerWidth / 2} y={28}>
				{c.xLabel}
			</text>
		{/if}
	</g>
{/if}

<style>
	line {
		stroke: var(--diveplot-text-secondary, #6b7280);
	}

	text {
		fill: var(--diveplot-text-secondary, #6b7280);
		font-family: var(--diveplot-font, system-ui, sans-serif);
		font-size: 10px;
	}

	.tick-dimmed {
		opacity: 0.25;
		transition: opacity 0.15s ease;
	}
</style>
