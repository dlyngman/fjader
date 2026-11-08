import type { Clause } from '$lib/query-engine/CrossfilterSelection.svelte';
import type { FilterGroup } from '$lib/query-engine/FilterGroup.svelte';

/**
 * Mirrors one group's clauses into another, for DerivedInterval1D: every
 * clause but the range brush on the derived axis, which the interactor
 * replaces with its shifted copy.
 *
 * `sync` runs on every change in the source group, which is every brush frame
 * there. It relays the source's clause objects themselves, so an unchanged
 * one is the object the target already holds, which it ignores: a brush in the
 * source re-queries nothing in the target for the clauses it did not touch.
 */
export class ClauseRelay {
	#source: FilterGroup;
	#target: FilterGroup;

	#relayed = new Set<string>();
	/** Reused as the next pass's key set, swapped with #relayed after each. */
	#current = new Set<string>();
	#axisColumn = '';

	constructor(source: FilterGroup, target: FilterGroup) {
		this.#source = source;
		this.#target = target;
	}

	/**
	 * Relay the source's clauses (all of them but the range on `axisColumn`),
	 * and remove relayed clauses the source no longer has. With `relay` false,
	 * only the removal. Call untracked: it reads the target group it writes.
	 */
	sync(relay: boolean, axisColumn: string): void {
		this.#current.clear();
		if (relay) {
			this.#axisColumn = axisColumn;
			this.#source.selection.forEach(this.#visit);
		}
		for (const key of this.#relayed) {
			if (!this.#current.has(key)) this.#target.removeManual(key);
		}
		const done = this.#relayed;
		this.#relayed = this.#current;
		this.#current = done;
	}

	/** Remove every relayed clause, for an interactor going away. */
	clear(): void {
		for (const key of this.#relayed) this.#target.removeManual(key);
		this.#relayed.clear();
	}

	#visit = (clause: Clause, sourceId: string): void => {
		const { schema } = clause;
		if (schema?.kind === 'range' && schema.column === this.#axisColumn) return;
		if (!clause.predicate) return;
		const key = `relay:${sourceId}`;
		this.#current.add(key);
		// The clause itself: nothing in it depends on its group, so a relayed
		// toggle routes and dims in the target as a native one would, and an
		// unchanged clause is the same object, which the target ignores.
		this.#target.relayClause(key, clause);
	};
}
