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
	sort?: NormalizedSortConfig;
	limit?: number;
	filterNulls?: unknown[] | null;
}

export class MarkHandle {
	arrowTable = $state<Table | null>(null);
	dataVersion = $state(0);
	error = $state<Error | null>(null);

	#params = $state<QueryParams>({ sort: undefined, limit: undefined, filterNulls: null });

	get params(): QueryParams {
		return this.#params;
	}

	/** Called by mark lifecycle when sort/limit/filterNulls change. */
	updateParams(params: QueryParams): void {
		this.#params = params;
		this._onParamsChange?.();
	}

	// Engine sets this callback during registration.
	// Conventional underscore — engine needs external access.
	_onParamsChange: (() => void) | null = null;

	/** Engine-internal: called to deliver query results. */
	_setResult(table: Table): void {
		this.arrowTable = table;
		this.dataVersion++;
		this.error = null;
	}

	/** Engine-internal: called on query error. */
	_setError(error: Error): void {
		this.error = error;
	}

	/** Clean up registration. Set by engine during registerMark. */
	destroy: () => void = () => {};
}
