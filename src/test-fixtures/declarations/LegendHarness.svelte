<script lang="ts">
	import { setContext } from 'svelte';
	import Legend from '$lib/components/guides/legend/Legend.svelte';
	import {
		DECLARATION_REGISTRY,
		type DeclarationRegistry
	} from '$lib/components/charts/declarations.svelte';

	/**
	 * Test fixture (declarations.harness.test.ts), outside src/lib so it is not
	 * packaged: Legends in a chart (a registry in context) or outside one.
	 */
	let {
		registry,
		scaleRegistry
	}: { registry: DeclarationRegistry | null; scaleRegistry: unknown } = $props();
	if (registry) setContext(DECLARATION_REGISTRY, registry);
	setContext('scale-registry', scaleRegistry);
</script>

<Legend color="island" />
<Legend color="species" position="right" />
