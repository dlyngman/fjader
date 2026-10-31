<script lang="ts">
	import PlotFromSpec from './PlotFromSpec.svelte';
	import type { FjaderSpec, LayoutItem } from './types';

	interface Props {
		spec: FjaderSpec;
	}

	let { spec }: Props = $props();

	function isPlot(item: LayoutItem): item is import('./types').PlotSpec {
		return 'marks' in item;
	}
</script>

{#if spec.hconcat?.length}
	<div class="fjader-hconcat">
		{#each spec.hconcat as item, i (i)}
			<div class="fjader-hconcat-item">
				{#if isPlot(item)}
					<PlotFromSpec spec={item} />
				{:else}
					<svelte:self spec={item} />
				{/if}
			</div>
		{/each}
	</div>
{:else if spec.vconcat?.length}
	<div class="fjader-vconcat">
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
	.fjader-hconcat {
		display: flex;
		gap: 8px;
	}

	.fjader-hconcat-item {
		flex: 1;
		min-width: 0;
	}

	.fjader-vconcat {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
</style>
