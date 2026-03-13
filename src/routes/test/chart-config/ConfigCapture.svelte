<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import type { ChartContext } from '$lib/types';
	import type { ChartConfig } from '$lib/config';

	interface Props {
		onConfig: (config: ChartConfig) => void;
		onMounted: () => void;
	}

	let { onConfig, onMounted }: Props = $props();

	const chartContext = getContext<ChartContext>('chart');

	onMount(() => {
		onConfig(chartContext.config);
		onMounted();
	});
</script>
