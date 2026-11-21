<script lang="ts">
	import { declareInChart } from '$lib/components/charts/declarations.svelte';

	/** Test fixture: a component that declares a frame. */
	let { id }: { id: string } = $props();
	declareInChart('frame', { id });
</script>
