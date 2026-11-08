/**
 * CrossfilterSelection — Svelte 5-native crossfilter predicate engine.
 *
 * Replaces Mosaic's Selection.intersect({ cross: true }) with a reactive
 * $state Map. Marks derive their filter via predicate(markId), which
 * returns all active predicates except those that exclude that mark.
 *
 * Cross-filtering is chart-level: interactors pass excludeMarkIds (the set
 * of all marks in the source chart). When a brush in chart A fires, all
 * marks in chart A skip that clause. All other marks receive it.
 */

import { SvelteMap } from 'svelte/reactivity';
import type { ExprNode } from '@uwdata/mosaic-sql';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FilterExpr = ExprNode | string | boolean;

export interface FilterSchema {
	kind?: string;
	column?: string;
	label?: string;
	values?: unknown[];
	[key: string]: unknown;
}

/** A clause stored in the selection. */
export interface Clause {
	predicate: FilterExpr;
	excludeMarkIds: Set<string>;
	value: unknown;
	schema?: FilterSchema;
}

/** A clause with its source identifier, for external consumers. */
export interface ClauseEntry extends Clause {
	sourceId: string;
}

// ---------------------------------------------------------------------------
// CrossfilterSelection
// ---------------------------------------------------------------------------

export class CrossfilterSelection {
	#clauses: SvelteMap<string, Clause> = new SvelteMap();

	/**
	 * Compute the filter predicate for a given mark.
	 * Returns all active predicates except those whose excludeMarkIds
	 * contains the given markId.
	 */
	predicate(markId: string): FilterExpr[] {
		const result: FilterExpr[] = [];
		for (const clause of this.#clauses.values()) {
			if (CrossfilterSelection.applies(clause, markId)) {
				result.push(clause.predicate);
			}
		}
		return result;
	}

	/**
	 * Update or remove a clause.
	 * Pass null to remove (clear) the clause for the given source.
	 *
	 * Returns the clause it replaced or removed, so the caller can re-query the
	 * marks either one applies to: a clause's exclusions belong to whichever
	 * control wrote it, so the old and the new one can apply to different marks.
	 */
	update(sourceId: string, clause: Clause | null): Clause | undefined {
		const prev = this.#clauses.get(sourceId);
		if (clause) {
			this.#clauses.set(sourceId, clause);
		} else {
			this.#clauses.delete(sourceId);
		}
		return prev;
	}

	/** Whether a clause filters a mark: it has a predicate and does not exclude it. */
	static applies(clause: Clause, markId: string): boolean {
		return !!clause.predicate && !clause.excludeMarkIds.has(markId);
	}

	/** Whether a given source has an active (non-null) clause. */
	isActive(sourceId: string): boolean {
		return this.#clauses.has(sourceId);
	}

	/** O(1) lookup of a clause by source ID. */
	get(sourceId: string): Clause | undefined {
		return this.#clauses.get(sourceId);
	}

	/** Reactive list of all active clauses with their source IDs. */
	get items(): ClauseEntry[] {
		const result: ClauseEntry[] = [];
		for (const [sourceId, clause] of this.#clauses) {
			result.push({ sourceId, ...clause });
		}
		return result;
	}

	/**
	 * Whether a clause is baked into a mark's preagg table: every clause that
	 * filters the mark, except the active brush, which the table bins instead.
	 */
	#isBaked(sourceId: string, clause: Clause, markId: string, activeSourceId: string): boolean {
		return sourceId !== activeSourceId && CrossfilterSelection.applies(clause, markId);
	}

	/**
	 * The clause objects a preagg table bakes in, in map insertion order.
	 * Stored at build time so bakedClausesMatch() can compare by reference.
	 */
	bakedClauses(markId: string, activeSourceId: string): Clause[] {
		const result: Clause[] = [];
		for (const [sourceId, clause] of this.#clauses) {
			if (this.#isBaked(sourceId, clause, markId, activeSourceId)) result.push(clause);
		}
		return result;
	}

	/**
	 * The baked predicates sorted by source ID, so the same filters always
	 * produce the same preagg SQL whatever order their clauses were added in.
	 */
	bakedPredicates(markId: string, activeSourceId: string): FilterExpr[] {
		const entries: [string, FilterExpr][] = [];
		for (const [sourceId, clause] of this.#clauses) {
			if (this.#isBaked(sourceId, clause, markId, activeSourceId)) {
				entries.push([sourceId, clause.predicate]);
			}
		}
		entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
		return entries.map((e) => e[1]);
	}

	/**
	 * Whether the clauses baked into a preagg table are still the ones in force.
	 * Every filter change replaces its Clause object, so an unchanged filter
	 * keeps its reference. Runs every brush frame, so it allocates nothing.
	 */
	bakedClausesMatch(markId: string, activeSourceId: string, then: Clause[]): boolean {
		let i = 0;
		for (const [sourceId, clause] of this.#clauses) {
			if (!this.#isBaked(sourceId, clause, markId, activeSourceId)) continue;
			if (i >= then.length || clause !== then[i++]) return false;
		}
		return i === then.length;
	}

	/** Number of active clauses. */
	get activeCount(): number {
		return this.#clauses.size;
	}

	/** Remove all clauses. */
	clear(): void {
		this.#clauses.clear();
	}
}
