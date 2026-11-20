<script lang="ts">
	import { declareInChart, warnIfInChildren } from '$lib/components/charts/declarations.svelte';

	/** Test fixture: a component that declares a frame and is an overlay too. */
	let { id }: { id: string } = $props();
	declareInChart('frame', { id });
	warnIfInChildren('ScopeProbe', 'foreground');
</script>
