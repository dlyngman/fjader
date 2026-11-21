<script lang="ts">
	import { setContext, type Snippet } from 'svelte';
	import { DECLARATION_SCOPE, type DeclarationScopeContext } from './declarations.svelte';

	/**
	 * The cell the declarations placed inside it are for (`declareInChart`).
	 * Context belongs to a component, not to a place a snippet is rendered, so
	 * `ChartCell` renders each per-cell snippet inside one of these. Renders no
	 * DOM of its own.
	 */
	interface Props {
		/** The cell, or null: every cell of the chart. */
		cellId: string | null;
		children?: Snippet;
	}

	let { cellId, children }: Props = $props();

	const scope: DeclarationScopeContext = {
		get cellId() {
			return cellId;
		}
	};
	setContext(DECLARATION_SCOPE, scope);
</script>

{@render children?.()}
