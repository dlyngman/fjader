<script lang="ts">
	import { declareInChart, getDeclarationChart } from '$lib/components/charts/declarations.svelte';

	/** Test fixture: declares a frame, or asks for its chart, as a declaration does. */
	let { probe, id }: { probe: 'declare' | 'chart'; id: string } = $props();
	if (probe === 'declare') declareInChart('frame', { id });
	else getDeclarationChart(`Probe ${id}`);
</script>
