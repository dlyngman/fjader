/**
 * Query engine barrel — setup function + re-exports.
 *
 * Usage in route pages:
 *   import { setQueryContext } from '$lib/query-engine';
 *   setQueryContext(wasm.getConnection());  // Promise OK — resolves lazily
 *
 * Usage outside a component (the spec renderer), passing contexts to mount():
 *   const { filterGroups } = createQueryServices(queryEngine);
 *   context.set('query-engine', queryEngine);
 *   context.set('filter-groups', filterGroups);
 */

import { setContext, getContext } from 'svelte';
import { QueryEngine } from './QueryEngine';
import type { DuckDBConnection } from './QueryEngine';
import { FilterGroupRegistry } from './FilterGroupRegistry.svelte';
import { tableSchemaService } from '$lib/data/TableSchemaService.svelte';

/**
 * Create the FilterGroupRegistry for an engine and wire both to the schema
 * service. Brushes and toggles reach the engine only through this wiring:
 * a FilterGroup without an engine updates its selection but never re-queries.
 */
export function createQueryServices(queryEngine: QueryEngine) {
	const filterGroups = new FilterGroupRegistry();
	filterGroups.setEngine(queryEngine);
	tableSchemaService.setQueryEngine(queryEngine);
	return { queryEngine, filterGroups };
}

/**
 * Create QueryEngine + FilterGroupRegistry and set Svelte contexts.
 * Call this synchronously in a component's <script> block.
 * Accepts a Promise<DuckDBConnection> — queries defer until it resolves.
 */
export function setQueryContext(connection: DuckDBConnection | Promise<DuckDBConnection>) {
	const { queryEngine, filterGroups } = createQueryServices(new QueryEngine(connection));
	setContext('query-engine', queryEngine);
	setContext('filter-groups', filterGroups);
	return { queryEngine, filterGroups };
}

/** Get the FilterGroupRegistry from context. */
export function getFilterGroups(): FilterGroupRegistry {
	return getContext<FilterGroupRegistry>('filter-groups');
}

// Re-exports
export { initDuckDB, connectionFrom } from './duckdb';
export type { InitDuckDBOptions } from './duckdb';
export { QueryEngine } from './QueryEngine';
export type {
	DuckDBConnection,
	QueryOpts,
	ColumnInfo,
	ColumnSchema,
	JsColumnType,
	QueryDescriptor,
	ActiveDim,
	ActivationSource,
	QueryEngineOptions
} from './QueryEngine';
export { mapSqlTypeToJs, buildSchemaMap } from './QueryEngine';
export { MarkHandle } from './MarkHandle.svelte';
export type { QueryParams } from './MarkHandle.svelte';
export { FilterGroupRegistry } from './FilterGroupRegistry.svelte';
export { FilterGroup } from './FilterGroup.svelte';
export type { SourceOpts, SourceHandle, ToggleHandle, FilterItem } from './FilterGroup.svelte';
export { FieldActivity } from './FieldActivity.svelte';
export { CrossfilterSelection } from './CrossfilterSelection.svelte';
export type { FilterExpr, FilterSchema, Clause, ClauseEntry } from './CrossfilterSelection.svelte';
