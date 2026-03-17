<script lang="ts">
	import DerivedInterval1D from './DerivedInterval1D.svelte';

	interface Props {
		sourceSelection: string;
		selection?: string;
		offset: string;
	}

	let { sourceSelection, selection, offset }: Props = $props();
</script>

<DerivedInterval1D {sourceSelection} {selection} {offset} axis="x" />
