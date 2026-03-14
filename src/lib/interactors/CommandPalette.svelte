<script lang="ts">
	import PaletteContent from './PaletteContent.svelte';

	interface Props {
		open: boolean;
	}

	let { open = $bindable() }: Props = $props();
</script>

{#if open}
	<PaletteContent onclose={() => { open = false; }} />
{/if}
