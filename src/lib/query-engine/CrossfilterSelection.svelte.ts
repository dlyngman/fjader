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
			if (!clause.excludeMarkIds.has(markId) && clause.predicate) {
				result.push(clause.predicate);
			}
		}
		return result;
	}

	/**
	 * Update or remove a clause.
	 * Pass null to remove (clear) the clause for the given source.
	 */
	update(sourceId: string, clause: Clause | null): void {
		if (clause) {
			this.#clauses.set(sourceId, clause);
		} else {
			this.#clauses.delete(sourceId);
		}
	}

	/** Whether a given source has an active (non-null) clause. */
	isActive(sourceId: string): boolean {
		return this.#clauses.has(sourceId);
	}

	/** Reactive list of all active clauses with their source IDs. */
	get items(): ClauseEntry[] {
		const result: ClauseEntry[] = [];
		for (const [sourceId, clause] of this.#clauses) {
			result.push({ sourceId, ...clause });
		}
		return result;
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
