<script lang="ts">
	import Interval1D from './Interval1D.svelte';
	import type { FilterBridge } from '$lib/selection/filter-bridge.svelte';
	import type { FieldRef } from '$lib/types';

	interface Props {
		bridge?: FilterBridge | null;
		field?: FieldRef;
	}

	let { bridge = null, field }: Props = $props();
</script>

<Interval1D {bridge} {field} axis="y" />
