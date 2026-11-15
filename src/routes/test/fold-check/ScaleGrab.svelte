<script>
	// Hands the page this chart's y scale state, read through the chart context.
	import { getContext } from 'svelte';

	let { onScale } = $props();
	const c = getContext('chart');
	onScale(() => c.yScaleState);
</script>
