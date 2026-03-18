<script lang="ts">
	import DerivedInterval1D from './DerivedInterval1D.svelte';

	interface Props {
		sourceSelection: string;
		selection?: string;
		offset: string;
		relayClauses?: boolean;
	}

	let { sourceSelection, selection, offset, relayClauses }: Props = $props();
</script>

<DerivedInterval1D {sourceSelection} {selection} {offset} axis="x" {relayClauses} />
