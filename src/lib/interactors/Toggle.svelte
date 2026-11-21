<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { declareOverlay, getDeclarationChart } from '$lib/components/charts/declarations.svelte';
	import type { ToggleHandle } from '$lib/query-engine/FilterGroup.svelte';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
	import BandLabelToggle from './BandLabelToggle.svelte';
	import ToggleCell from './ToggleCell.svelte';
	import { bandFieldsOf } from './band-fields';
	import type { ToggleShared } from './toggle-shared';

	/**
	 * Click-to-filter for categorical fields: click a mark to toggle its value
	 * of `field`, or a band axis label to toggle the axis's own field.
	 *
	 * A declaration, split by responsibility: this registers the toggles once
	 * for the chart (the declared field's, and one per band axis field), from
	 * what every cell shares (DeclarationChart); each cell (ToggleCell) only
	 * calls their activators when hovered and turns its clicks into toggles. In a
	 * facet grid every cell toggles the same registrations. Once per chart as a
	 * chart's child; in a per-cell snippet (an `interactors` snippet, until the
	 * snippets go) the declaration itself is per cell, so it registers once per
	 * cell, as before.
	 *
	 * Toggles on different fields AND together. The chart skips its own toggles
	 * (crossfilter): its marks that read the toggled field dim, the rest keep
	 * their data. Elsewhere in the group, marks that read the field dim and the
	 * rest filter.
	 */
	interface Props {
		/** Filter group name: which FilterGroup this toggle writes to. */
		selection?: string;
		field: string | string[];
	}

	let { selection, field }: Props = $props();

	const chart = getDeclarationChart('Toggle');
	const filterGroup = getContext<FilterGroupRegistry>('filter-groups').get(
		untrack(() => selection)
	);

	// Read once, as the registration is made once.
	const fields = untrack(() => (Array.isArray(field) ? field : [field]));
	const declaredField = fields.length === 1 ? fields[0] : null;

	/** The chart skips its own toggles: its config is what a registration names. */
	const declared = filterGroup.registerToggle(fields, { chart: chart.config });

	const shared: ToggleShared = {
		fields,
		declaredField,
		declared,
		bandToggles: new Map<string, ToggleHandle>(),
		activators: new Set([declared.activate]),
		toggleFor(toggleField) {
			return toggleField === declaredField ? declared : (this.bandToggles.get(toggleField) ?? null);
		}
	};

	/** One BandLabelToggle per band axis field (see bandFieldsOf), from the shared scales. */
	const bandFields = $derived(bandFieldsOf([chart.xScaleState, chart.yScaleState], declaredField));

	// Destroying the declared registration clears its selection when it was the
	// last control for it; a selection a legend still shows stays. The band
	// label registrations destroy their own.
	onDestroy(() => {
		// Out of the list first: a cell unmounting a flush later must not
		// activate a destroyed registration.
		shared.activators.delete(declared.activate);
		declared.destroy();
	});

	declareOverlay(cell, { slot: 'interactors' });
</script>

{#each bandFields as bandField (bandField)}
	<BandLabelToggle
		{filterGroup}
		field={bandField}
		chart={chart.config}
		handles={shared.bandToggles}
		activators={shared.activators}
	/>
{/each}

{#snippet cell()}
	<ToggleCell {shared} />
{/snippet}
