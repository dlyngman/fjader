<script lang="ts">
	import PlotFromSpec from './PlotFromSpec.svelte';
	import type { DivePlotSpec } from './types';

	interface Props {
		spec: DivePlotSpec;
	}

	let { spec }: Props = $props();
</script>

{#if spec.hconcat?.length}
	<div class="diveplot-hconcat">
		{#each spec.hconcat as plotSpec, i (i)}
			<div class="diveplot-hconcat-item">
				<PlotFromSpec spec={plotSpec} />
			</div>
		{/each}
	</div>
{:else if spec.vconcat?.length}
	<div class="diveplot-vconcat">
		{#each spec.vconcat as plotSpec, i (i)}
			<PlotFromSpec spec={plotSpec} />
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
