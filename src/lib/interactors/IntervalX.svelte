<script lang="ts">
	import Interval1D from './Interval1D.svelte';
	import type { FieldRef } from '$lib/types';

	interface Props {
		selection: string;
		field?: FieldRef;
	}

	let { selection, field }: Props = $props();
</script>

<Interval1D {selection} {field} axis="x" />
