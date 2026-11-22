<script lang="ts">
	import Interval1D from './Interval1D.svelte';
	import type { FieldRef } from '$lib/types';

	interface Props {
		/** Filter group it writes. Default: the default group, which every mark naming none reads. */
		selection?: string;
		/**
		 * The column it selects on. Default: the first column the chart's marks
		 * draw on this axis; on a range, its start (x1 or y1), so ranges are
		 * selected by where they start. A mark drawing another column on the
		 * same axis is not selected by what lies under the brush: name its
		 * column here.
		 */
		field?: FieldRef;
	}

	let { selection, field }: Props = $props();
</script>

<Interval1D {selection} {field} axis="y" />
