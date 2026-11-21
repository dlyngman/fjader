import type { ToggleHandle } from '$lib/query-engine/FilterGroup.svelte';

/**
 * What a Toggle declaration registers once for its chart and hands to each of
 * its cells (ToggleCell): the toggles themselves, and the activators the cells
 * call when hovered. The cells keep only what needs a cell: its activator hook
 * and its clicks.
 */
export interface ToggleShared {
	/** The declared field(s), as the declaration normalized them. */
	readonly fields: readonly string[];
	/** The one declared field, or null for a multi-field toggle. */
	readonly declaredField: string | null;
	/** The toggle on the declared field(s). */
	readonly declared: ToggleHandle;
	/** Band-axis label toggles, by field (registered by BandLabelToggle). */
	readonly bandToggles: Map<string, ToggleHandle>;
	/** Every registration's activator: read on each call, so fields may come and go. */
	readonly activators: Set<() => void>;
	/** The toggle for a field: the declared one, or a band label's. */
	toggleFor(field: string): ToggleHandle | null;
}
