/**
 * CrossfilterSelection — Svelte 5-native crossfilter predicate engine.
 *
 * Replaces Mosaic's Selection.intersect({ cross: true }) with a reactive
 * $state Map of clauses, plus the registrations of the sources that write
 * them. Marks derive their filter via predicate(route): every clause that
 * filters the mark.
 *
 * WHICH CLAUSES FILTER A MARK. The mark decides, not the control that wrote
 * the clause. A clause filters a mark unless:
 * - it is a categorical selection on a field the mark reads selection
 *   activity for (the mark dims by it instead), or
 * - the mark's chart holds a registration of the clause's source that opted
 *   into skipping its chart (crossfilter: a brush does not filter its own
 *   chart).
 * Both are computed when asked, from the clause, the mark's route and the
 * live registrations: nothing is cached, so nothing goes stale.
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

/**
 * A single-field categorical selection, as a clause states it: the field's
 * identity key and the selected values. Brushes, tuples and manual clauses have
 * none.
 */
export interface CategoricalSelection {
	key: string;
	values: ReadonlySet<unknown>;
}

/** A clause stored in the selection. Nothing in it depends on its group. */
export interface Clause {
	predicate: FilterExpr;
	value: unknown;
	schema?: FilterSchema;
	/** Set when the clause selects categories of one field; written with the clause. */
	categorical?: CategoricalSelection | null;
}

/**
 * What routing needs to know about a mark: the identity keys of the
 * categorical fields its renderer reads selection activity for, its chart, and
 * its selectionResponse. One object per mark, owned by its lifecycle and
 * handed around by reference.
 *
 * A categorical selection on a field in `reads` dims the mark instead of
 * filtering it. `chart` is the chart's ChartConfig, compared by reference: a
 * faceted chart's cells have ids of their own, but share one config.
 * `response` 'filter' makes every selection filter the mark, and a click
 * control's (a discrete registration's) in its own chart too; brushes still
 * skip their own chart.
 */
export interface MarkRoute {
	readonly reads: readonly string[];
	readonly chart: object | null;
	readonly response?: 'auto' | 'filter';
}

/**
 * What routing reads from one registration of a source: the chart it skips,
 * if it opted into skipping one. Compared by reference with a mark's route.
 */
export interface SourceRegistration {
	readonly chart?: object | null;
	/**
	 * The source writes its clauses on a click (a Toggle, a legend, a band
	 * label), not under a dragged pointer. A 'filter' mark in the chart it
	 * skips is filtered by it all the same.
	 */
	readonly discrete?: boolean;
}

/** A mark with no route: it reads no activity and is in no chart. */
export const NO_ROUTE: MarkRoute = { reads: [], chart: null };

/** A clause with its source identifier, for external consumers. */
export interface ClauseEntry extends Clause {
	sourceId: string;
}

// ---------------------------------------------------------------------------
// CrossfilterSelection
// ---------------------------------------------------------------------------

export class CrossfilterSelection {
	#clauses: SvelteMap<string, Clause> = new SvelteMap();

	/** Registrations per source id. Several under one id are one source. Not reactive. */
	#sources = new Map<string, Set<SourceRegistration>>();

	/** Add a registration of `sourceId`. */
	addRegistration(sourceId: string, registration: SourceRegistration): void {
		let registrations = this.#sources.get(sourceId);
		if (!registrations) {
			registrations = new Set();
			this.#sources.set(sourceId, registrations);
		}
		registrations.add(registration);
	}

	/** Remove a registration of `sourceId`; the last one removes the source. */
	removeRegistration(sourceId: string, registration: SourceRegistration): void {
		const registrations = this.#sources.get(sourceId);
		if (!registrations?.delete(registration)) return;
		if (registrations.size === 0) this.#sources.delete(sourceId);
	}

	/** The live registrations of `sourceId`, or undefined when it has none. */
	registrationsOf(sourceId: string): ReadonlySet<SourceRegistration> | undefined {
		return this.#sources.get(sourceId);
	}

	/**
	 * Whether a clause of `sourceId` filters the mark with `route`. `key` is
	 * the clause's categorical field (its identity key), or null for a brush,
	 * a tuple or a manual clause; before the source has written a clause, its
	 * registrations' key, which preagg activation needs on hover.
	 *
	 * A plain loop over the registrations, which are one to three: no closure,
	 * no allocation, as it runs per mark per clause on every brush frame.
	 */
	filters(route: MarkRoute, sourceId: string, key: string | null): boolean {
		if (key !== null && route.reads.includes(key)) return false;
		const chart = route.chart;
		if (chart) {
			// Every chart with a Toggle or legend on the same fields registers
			// their one source, so a chart skip would let a 'filter' mark ignore
			// those fields wherever it has such a control. A click does not move
			// under the pointer, so filtering the own chart is safe for it.
			const filterMark = route.response === 'filter';
			const registrations = this.#sources.get(sourceId);
			if (registrations) {
				for (const registration of registrations) {
					if (registration.chart === chart && !(filterMark && registration.discrete)) {
						return false;
					}
				}
			}
		}
		return true;
	}

	/** Whether `clause`, written by `sourceId`, filters the mark with `route`. */
	applies(sourceId: string, clause: Clause, route: MarkRoute): boolean {
		return !!clause.predicate && this.filters(route, sourceId, clause.categorical?.key ?? null);
	}

	/** Every predicate that filters the mark with `route`. */
	predicate(route: MarkRoute): FilterExpr[] {
		const result: FilterExpr[] = [];
		for (const [sourceId, clause] of this.#clauses) {
			if (this.applies(sourceId, clause, route)) result.push(clause.predicate);
		}
		return result;
	}

	/**
	 * Update or remove a clause.
	 * Pass null to remove (clear) the clause for the given source.
	 *
	 * Returns the clause it replaced or removed, so the caller can re-query the
	 * marks either one applies to.
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

	/** Whether a given source has an active (non-null) clause. */
	isActive(sourceId: string): boolean {
		return this.#clauses.has(sourceId);
	}

	/** O(1) lookup of a clause by source ID. */
	get(sourceId: string): Clause | undefined {
		return this.#clauses.get(sourceId);
	}

	/**
	 * Visit every active clause: the stored objects themselves, not copies, so a
	 * caller can tell an unchanged clause by reference. Reactive like `items`,
	 * without building an entry object per clause.
	 */
	forEach(visit: (clause: Clause, sourceId: string) => void): void {
		this.#clauses.forEach(visit);
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
	#isBaked(sourceId: string, clause: Clause, route: MarkRoute, activeSourceId: string): boolean {
		return sourceId !== activeSourceId && this.applies(sourceId, clause, route);
	}

	/**
	 * The clause objects a preagg table bakes in, in map insertion order.
	 * Stored at build time so bakedClausesMatch() can compare by reference.
	 */
	bakedClauses(route: MarkRoute, activeSourceId: string): Clause[] {
		const result: Clause[] = [];
		for (const [sourceId, clause] of this.#clauses) {
			if (this.#isBaked(sourceId, clause, route, activeSourceId)) result.push(clause);
		}
		return result;
	}

	/**
	 * The baked predicates sorted by source ID, so the same filters always
	 * produce the same preagg SQL whatever order their clauses were added in.
	 */
	bakedPredicates(route: MarkRoute, activeSourceId: string): FilterExpr[] {
		const entries: [string, FilterExpr][] = [];
		for (const [sourceId, clause] of this.#clauses) {
			if (this.#isBaked(sourceId, clause, route, activeSourceId)) {
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
	bakedClausesMatch(route: MarkRoute, activeSourceId: string, then: Clause[]): boolean {
		let i = 0;
		for (const [sourceId, clause] of this.#clauses) {
			if (!this.#isBaked(sourceId, clause, route, activeSourceId)) continue;
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
