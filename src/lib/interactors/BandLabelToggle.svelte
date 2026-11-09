<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import type { ChartContext } from '$lib/types';
	import type { FilterGroup, ToggleHandle } from '$lib/query-engine/FilterGroup.svelte';

	/**
	 * A Toggle's registration for one band axis field, so label clicks toggle
	 * the axis's own field. Renders nothing: it exists for its lifecycle.
	 *
	 * Toggle keys one of these per band field, so the registration lives exactly
	 * as long as the field is on an axis. Mounting registers it and adds its
	 * activator, so the field activates before its first click; unmounting (the
	 * band channel reassigned) destroys it, which clears its selection unless a
	 * legend still holds it. A transpose keeps the set of fields, so nothing
	 * remounts.
	 */

	interface Props {
		filterGroup: FilterGroup;
		field: string;
		/** The chart its toggle skips (see Toggle). */
		chart: object;
		/** Where the parent's click handler finds this field's toggle. */
		handles: Map<string, ToggleHandle>;
	}

	// Keyed by field in the parent, so none of these change for an instance.
	const { filterGroup, field, chart: skips, handles }: Props = $props();

	const chart = getContext<ChartContext>('chart');
	const toggle = filterGroup.registerToggle(field, { chart: skips });

	handles.set(field, toggle);
	chart.activators.add(toggle.activate);

	onDestroy(() => {
		handles.delete(field);
		chart.activators.delete(toggle.activate);
		toggle.destroy();
	});
</script>
