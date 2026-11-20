<script lang="ts">
	import { setContext } from 'svelte';
	import DeclarationScope from '$lib/components/charts/DeclarationScope.svelte';
	import ScopeProbe from './ScopeProbe.svelte';
	import {
		DECLARATION_REGISTRY,
		type DeclarationRegistry
	} from '$lib/components/charts/declarations.svelte';

	/**
	 * Test fixture (declaration-scope.test.ts), outside src/lib so it is not
	 * packaged: a registry, and a probe placed bare, inside a cell's scope, and
	 * directly in the chart's children.
	 */
	let { registry }: { registry: DeclarationRegistry } = $props();
	setContext(DECLARATION_REGISTRY, registry);
</script>

<ScopeProbe id="bare" />
<DeclarationScope cellId="cell-a"><ScopeProbe id="in-cell-a" /></DeclarationScope>
<DeclarationScope cellId={null} inChildren><ScopeProbe id="in-children" /></DeclarationScope>
