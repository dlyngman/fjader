/**
 * FilterGroupRegistry — named FilterGroups with lazy creation.
 *
 * Marks and interactors specify which group to use via their `selection`
 * prop (e.g. selection="brush"). Groups are created on first access.
 * Routes that don't use named selections get the "default" group.
 */

import { FilterGroup } from './FilterGroup.svelte';
import type { QueryEngine } from './QueryEngine';

export class FilterGroupRegistry {
	#groups = new Map<string, FilterGroup>();
	#engine: QueryEngine | null = null;

	/** Wire the engine to all existing and future groups. */
	setEngine(engine: QueryEngine): void {
		this.#engine = engine;
		for (const group of this.#groups.values()) {
			group.setEngine(engine);
		}
	}

	/** Get or create a FilterGroup by name. Undefined/null → "default". */
	get(name?: string | null): FilterGroup {
		const key = name ?? 'default';
		let g = this.#groups.get(key);
		if (!g) {
			g = new FilterGroup();
			if (this.#engine) g.setEngine(this.#engine);
			this.#groups.set(key, g);
		}
		return g;
	}

	/** Check if a named group exists (without creating it). */
	has(name: string): boolean {
		return this.#groups.has(name);
	}
}
