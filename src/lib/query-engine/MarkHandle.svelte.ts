/**
 * MarkHandle — reactive result channel between QueryEngine and mark lifecycle.
 *
 * The engine writes query results via _setResult(); the mark reads them via
 * $derived chains on arrowTable/dataVersion. This is the only reactive boundary
 * between engine and mark.
 */

import type { Table } from '@uwdata/flechette';
import type { BinWindow, NormalizedSortConfig } from '$lib/types';
import type { QueryParts } from '$lib/components/marks/lifecycle/query-builder';

export interface QueryParams {
	/**
	 * Not read by the engine. The rank transform reads the sort when the query
	 * is assembled; this is here so that a changed sort re-queries the mark.
	 */
	sort?: NormalizedSortConfig;
	limit?: number;
	/**
	 * A binned mark's window (MarkConfig.binWindow): `dense()` pads and returns
	 * only its bins. A parameter, not part of the parts: moving it re-queries
	 * without re-registering, and leaves preagg tables and the bin spec alone.
	 */
	binWindow?: BinWindow | null;
}

/**
 * Why a result was queried. `catchUp`: the mark came back into view stale (see
 * `active`), so the result brings it up to date with changes it missed, which
 * nobody just made; it lands without animating. `update`: anything else.
 */
export type ResultCause = 'update' | 'catchUp';

export class MarkHandle {
	arrowTable = $state<Table | null>(null);
	dataVersion = $state(0);
	/**
	 * The cause of the result `dataVersion` counts, set with it. Plain, not
	 * $state: read by whatever reacts to `dataVersion`, never on its own.
	 */
	resultCause: ResultCause = 'update';
	/**
	 * The query parts the result `dataVersion` counts was computed from, set
	 * with it. Not the registration's current parts: a re-registration lets
	 * queries in flight land, so a result can answer parts already replaced.
	 * Plain, like `resultCause`. A mark reads its bin spec from it (a rebin is
	 * a result of other bins).
	 */
	resultParts: QueryParts | null = null;
	/**
	 * The bin window the result `dataVersion` counts was computed over, set
	 * with it, as `resultParts`: a pan moves the window while a query is in
	 * flight, and the old result lands with the old window's rows. Null: the
	 * whole extent. Plain, like `resultParts`.
	 */
	resultWindow: BinWindow | null = null;
	/**
	 * The bin window the mark's last query went out with (or will, for an
	 * inactive mark's catch-up, which reads the params when it is sent). Set by
	 * the engine as it sends. A window in `params` that differs was never sent:
	 * the mark re-queries (MarkLifecycleV2.#onViewport), whatever path set it.
	 */
	sentWindow: BinWindow | null = null;
	error = $state<Error | null>(null);

	#params = $state<QueryParams>({ sort: undefined, limit: undefined });

	get params(): QueryParams {
		return this.#params;
	}

	/**
	 * Called by mark lifecycle when sort/limit change. Merges: a field left out
	 * keeps its value, so the sort and limit do not wipe the bin window.
	 */
	updateParams(params: QueryParams): void {
		this.#params = { ...this.#params, ...params };
		this._onParamsChange?.();
	}

	/**
	 * Move the bin window (QueryParams.binWindow). `requery`: query now, for a
	 * pan; false when a query is about to go out anyway and should carry it (a
	 * rebin re-registers the mark, and its first query reads the params as it
	 * is sent).
	 */
	setBinWindow(window: BinWindow | null, requery: boolean): void {
		this.#params = { ...this.#params, binWindow: window };
		if (requery) this._onParamsChange?.();
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
	_setResult(
		table: Table,
		cause: ResultCause = 'update',
		parts: QueryParts | null = null,
		window: BinWindow | null = null
	): void {
		this.error = null;
		if (table === this.arrowTable) return;
		this.resultCause = cause;
		this.resultParts = parts;
		this.resultWindow = window;
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
