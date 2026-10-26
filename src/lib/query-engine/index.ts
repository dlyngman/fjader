/**
 * Query engine barrel — setup function + re-exports.
 *
 * Usage in route pages:
 *   import { setQueryContext } from '$lib/query-engine';
 *   setQueryContext(wasm.getConnection());  // Promise OK — resolves lazily
 *
 * Usage in spec renderer:
 *   context.set('query-engine', new QueryEngine(connection));
 *   context.set('filter-groups', new FilterGroupRegistry());
 */

import { setContext, getContext } from 'svelte';
import { QueryEngine } from './QueryEngine';
import type { DuckDBConnection } from './QueryEngine';
import { FilterGroupRegistry } from './FilterGroupRegistry.svelte';
import { tableSchemaService } from '$lib/data/TableSchemaService.svelte';

/**
 * Create QueryEngine + FilterGroupRegistry and set Svelte contexts.
 * Call this synchronously in a component's <script> block.
 * Accepts a Promise<DuckDBConnection> — queries defer until it resolves.
 */
export function setQueryContext(connection: DuckDBConnection | Promise<DuckDBConnection>) {
	const queryEngine = new QueryEngine(connection);
	const filterGroups = new FilterGroupRegistry();
	filterGroups.setEngine(queryEngine);
	tableSchemaService.setQueryEngine(queryEngine);
	setContext('query-engine', queryEngine);
	setContext('filter-groups', filterGroups);
	return { queryEngine, filterGroups };
}

/** Get the FilterGroupRegistry from context. */
export function getFilterGroups(): FilterGroupRegistry {
	return getContext<FilterGroupRegistry>('filter-groups');
}

// Re-exports
export { initDuckDB } from './duckdb';
export { QueryEngine } from './QueryEngine';
export type {
	DuckDBConnection,
	QueryOpts,
	ColumnInfo,
	ColumnSchema,
	JsColumnType,
	QueryDescriptor,
	ActiveDim,
	ActivationSource
} from './QueryEngine';
export { mapSqlTypeToJs, buildSchemaMap } from './QueryEngine';
export { MarkHandle } from './MarkHandle.svelte';
export type { QueryParams } from './MarkHandle.svelte';
export { FilterGroupRegistry } from './FilterGroupRegistry.svelte';
export { FilterGroup } from './FilterGroup.svelte';
export type {
	SourceOpts,
	SourceHandle,
	ToggleHandle,
	FilterItem,
	ActiveValueScale
} from './FilterGroup.svelte';
export { CrossfilterSelection } from './CrossfilterSelection.svelte';
export type { FilterExpr, FilterSchema, Clause, ClauseEntry } from './CrossfilterSelection.svelte';
