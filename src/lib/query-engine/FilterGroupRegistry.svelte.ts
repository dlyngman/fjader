/**
 * FilterGroupRegistry — named FilterGroups with lazy creation.
 *
 * Marks and interactors specify which group to use via their `selection`
 * prop (e.g. selection="brush"). Groups are created on first access.
 * Routes that don't use named selections get the "default" group.
 */

import { FilterGroup } from './FilterGroup.svelte';

export class FilterGroupRegistry {
	#groups = new Map<string, FilterGroup>();

	/** Get or create a FilterGroup by name. Undefined/null → "default". */
	get(name?: string | null): FilterGroup {
		const key = name ?? 'default';
		let g = this.#groups.get(key);
		if (!g) {
			g = new FilterGroup();
			this.#groups.set(key, g);
		}
		return g;
	}

	/** Check if a named group exists (without creating it). */
	has(name: string): boolean {
		return this.#groups.has(name);
	}
}
