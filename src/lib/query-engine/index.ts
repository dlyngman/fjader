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

/**
 * Create QueryEngine + FilterGroupRegistry and set Svelte contexts.
 * Call this synchronously in a component's <script> block.
 * Accepts a Promise<DuckDBConnection> — queries defer until it resolves.
 */
export function setQueryContext(connection: DuckDBConnection | Promise<DuckDBConnection>) {
	const queryEngine = new QueryEngine(connection);
	const filterGroups = new FilterGroupRegistry();
	setContext('query-engine', queryEngine);
	setContext('filter-groups', filterGroups);
	return { queryEngine, filterGroups };
}

/** Get the FilterGroupRegistry from context. */
export function getFilterGroups(): FilterGroupRegistry {
	return getContext<FilterGroupRegistry>('filter-groups');
}

// Re-exports
export { QueryEngine } from './QueryEngine';
export type { DuckDBConnection, QueryOpts, ColumnInfo } from './QueryEngine';
export { FilterGroupRegistry } from './FilterGroupRegistry.svelte';
export { FilterGroup } from './FilterGroup.svelte';
export type { BrushOpts, BrushHandle, FilterItem, ActiveValueScale } from './FilterGroup.svelte';
export { CrossfilterSelection } from './CrossfilterSelection.svelte';
export type { FilterExpr, FilterSchema, Clause, ClauseEntry } from './CrossfilterSelection.svelte';
