<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { FilterGroup, ToggleHandle } from '$lib/query-engine/FilterGroup.svelte';

	/**
	 * A Toggle's registration for one band axis field, so label clicks toggle
	 * the axis's own field. Renders nothing: it exists for its lifecycle.
	 *
	 * Toggle keys one of these per band field, so the registration lives exactly
	 * as long as the field is on an axis. Mounting registers it and adds its
	 * activator to the toggle's list (its cells call it), so the field activates
	 * before its first click; unmounting (the band channel reassigned) destroys
	 * it, which clears its selection unless a legend still holds it. A transpose
	 * keeps the set of fields, so nothing remounts. Lives in the Toggle
	 * declaration, once per chart, not in a cell.
	 */
	interface Props {
		filterGroup: FilterGroup;
		field: string;
		/** The chart its toggle skips (see Toggle). */
		chart: object;
		/** Where the toggle's cells find this field's toggle, for clicks. */
		handles: Map<string, ToggleHandle>;
		/** Where the toggle's cells find its activator (ToggleShared.activators). */
		activators: Set<() => void>;
	}

	// Keyed by field in the parent, so none of these change for an instance.
	const { filterGroup, field, chart: skips, handles, activators }: Props = $props();

	const toggle = filterGroup.registerToggle(field, { chart: skips });

	handles.set(field, toggle);
	activators.add(toggle.activate);

	onDestroy(() => {
		handles.delete(field);
		activators.delete(toggle.activate);
		toggle.destroy();
	});
</script>
