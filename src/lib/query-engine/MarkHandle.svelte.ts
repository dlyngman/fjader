/**
 * MarkHandle — reactive result channel between QueryEngine and mark lifecycle.
 *
 * The engine writes query results via _setResult(); the mark reads them via
 * $derived chains on arrowTable/dataVersion. This is the only reactive boundary
 * between engine and mark.
 */

import type { Table } from '@uwdata/flechette';
import type { NormalizedSortConfig } from '$lib/types';

export interface QueryParams {
	/**
	 * Not read by the engine. The rank transform reads the sort when the query
	 * is assembled; this is here so that a changed sort re-queries the mark.
	 */
	sort?: NormalizedSortConfig;
	limit?: number;
}

export class MarkHandle {
	arrowTable = $state<Table | null>(null);
	dataVersion = $state(0);
	error = $state<Error | null>(null);

	#params = $state<QueryParams>({ sort: undefined, limit: undefined });

	get params(): QueryParams {
		return this.#params;
	}

	/** Called by mark lifecycle when sort/limit change. */
	updateParams(params: QueryParams): void {
		this.#params = params;
		this._onParamsChange?.();
	}

	// Engine sets this callback during registration.
	// Conventional underscore — engine needs external access.
	_onParamsChange: (() => void) | null = null;

	/**
	 * Whether the mark is on screen (or about to be). The engine does not
	 * re-query an inactive mark that has its first result: a filter or params
	 * change only marks it stale, and it queries once, with whatever is current,
	 * when it becomes active again. Its first query always runs, since the
	 * first result can feed domains other charts share. Not reactive: the
	 * engine reads it when it would send.
	 */
	get active(): boolean {
		return this.#active;
	}

	/**
	 * Returns whether this call sent a catch-up query: the mark came back
	 * stale. A return with no query means the data it holds is current, so
	 * the caller can act on its return now rather than after a result.
	 */
	setActive(active: boolean): boolean {
		if (active === this.#active) return false;
		this.#active = active;
		return active ? (this._onActivate?.() ?? false) : false;
	}

	#active = true;

	// Engine sets this during registration: query a mark that went stale, and
	// say whether it did.
	_onActivate: (() => boolean) | null = null;

	/**
	 * Engine-internal: called to deliver query results.
	 *
	 * The table it already holds changes nothing, so it bumps nothing: a cache
	 * hit hands back the same object, and bumping `dataVersion` for it reran
	 * every effect that reads it (the tooltip table, data-following domains).
	 * The error is cleared either way, so a success after a failure still
	 * clears it.
	 */
	_setResult(table: Table): void {
		this.error = null;
		if (table === this.arrowTable) return;
		this.arrowTable = table;
		this.dataVersion++;
	}

	/** Engine-internal: called on query error. */
	_setError(error: Error): void {
		this.error = error;
	}

	/** Clean up registration. Set by engine during registerMark. */
	destroy: () => void = () => {};
}
