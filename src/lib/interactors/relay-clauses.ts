import type { Clause } from '$lib/query-engine/CrossfilterSelection.svelte';
import type { FilterGroup } from '$lib/query-engine/FilterGroup.svelte';

/** No exclusions in the target group: they name marks of the source chart. */
const NO_EXCLUSIONS: Set<string> = new Set();

/**
 * Mirrors one group's clauses into another, for DerivedInterval1D: every
 * clause but the range brush on the derived axis, which the interactor
 * replaces with its shifted copy.
 *
 * `sync` runs on every change in the source group, which is every brush frame
 * there. An unchanged source clause relays the same copy, which the target
 * group recognises and ignores, so a brush in the source re-queries nothing
 * in the target for the clauses it did not touch.
 */
export class ClauseRelay {
	#source: FilterGroup;
	#target: FilterGroup;

	/**
	 * The relayed copy of each source clause. A copy rather than the clause
	 * itself because it drops the source's exclusions: passed on as they are, a
	 * target-group mark in the source chart would stop being filtered.
	 */
	#copies = new WeakMap<Clause, Clause>();

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
		this.#target.relayClause(key, this.#copyOf(clause));
	};

	#copyOf(clause: Clause): Clause {
		let copy = this.#copies.get(clause);
		if (!copy) {
			copy = {
				predicate: clause.predicate,
				excludeMarkIds: NO_EXCLUSIONS,
				value: clause.value,
				schema: clause.schema
			};
			this.#copies.set(clause, copy);
		}
		return copy;
	}
}
