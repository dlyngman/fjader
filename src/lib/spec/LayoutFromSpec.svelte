<script lang="ts">
	import PlotFromSpec from './PlotFromSpec.svelte';
	import type { DivePlotSpec, LayoutItem } from './types';

	interface Props {
		spec: DivePlotSpec;
	}

	let { spec }: Props = $props();

	function isPlot(item: LayoutItem): item is import('./types').PlotSpec {
		return 'marks' in item;
	}
</script>

{#if spec.hconcat?.length}
	<div class="diveplot-hconcat">
		{#each spec.hconcat as item, i (i)}
			<div class="diveplot-hconcat-item">
				{#if isPlot(item)}
					<PlotFromSpec spec={item} />
				{:else}
					<svelte:self spec={item} />
				{/if}
			</div>
		{/each}
	</div>
{:else if spec.vconcat?.length}
	<div class="diveplot-vconcat">
		{#each spec.vconcat as item, i (i)}
			{#if isPlot(item)}
				<PlotFromSpec spec={item} />
			{:else}
				<svelte:self spec={item} />
			{/if}
		{/each}
	</div>
{:else if spec.plot}
	<PlotFromSpec spec={spec.plot} />
{/if}

<style>
	.diveplot-hconcat {
		display: flex;
		gap: 8px;
	}

	.diveplot-hconcat-item {
		flex: 1;
		min-width: 0;
	}

	.diveplot-vconcat {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
</style>
