// src/lib/data/ViewManager.svelte.ts

import type { Coordinator } from '@uwdata/mosaic-core';

export interface ColumnDefinition {
	sql: string;
	source: string;
	scaleId: string;
}

interface TableState {
	viewName: string;
	version: number;
}

function escapeSql(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * ViewManager creates and manages DuckDB views that add computed index columns
 * for categorical data. This moves the category-to-integer indexing from JavaScript
 * into SQL, enabling zero-copy Float32 data flow to the GPU.
 *
 * Column naming conventions:
 * - Color index: __dplot_{field}_color_idx (1-based, 0 = null/unknown)
 * - Band index: __dplot_{field}_idx (0-based)
 *
 * View naming: {table}_derived_v{version}
 */
class ViewManagerService {
	// Map<sourceTable, Map<columnAlias, ColumnDefinition>>
	#tableDefinitions = new Map<string, Map<string, ColumnDefinition>>();

	// Mosaic coordinator (set lazily)
	#coordinator: Coordinator | null = null;

	// Map<sourceTable, Set<scaleId>> - tracks which scales use each table
	#referenceCount = new Map<string, Set<string>>();

	// Reactive map for table states
	#tableStates = $state(new Map<string, TableState>());

	// Track tables with pending view creation
	#pendingViews = $state(new Set<string>());

	// Global version counter - external code reads this to establish Svelte dependency
	version = $state(0);

	// Pending view updates (debounced via queueMicrotask)
	#pendingUpdates = new Set<string>();
	#updateScheduled = false;

	// Per-table async serialization: ensures only one CREATE VIEW is in-flight
	// per table. If new columns arrive during an exec(), the view is rebuilt
	// after the current one completes.
	#tableLocks = new Map<string, Promise<void>>();
	#dirtyDuringLock = new Set<string>();

	// Unique session ID to namespace views — prevents collisions when multiple
	// render contexts (e.g. Streamlit iframes) share the same DuckDB instance.
	#sessionId = Math.random().toString(36).slice(2, 8);

	// Cardinality warning threshold
	static CARDINALITY_WARNING = 50;

	setCoordinator(coordinator: Coordinator): void {
		if (this.#coordinator === coordinator) return;

		this.#coordinator = coordinator;
		console.log('[ViewManager] Coordinator set');

		// Rebuild any pending views now that we have a coordinator
		for (const table of this.#tableDefinitions.keys()) {
			this.#scheduleViewUpdate(table);
		}
	}

	getCoordinator(): Coordinator | null {
		return this.#coordinator;
	}

	registerColumn(
		sourceTable: string,
		alias: string,
		{ sql, source, scaleId }: ColumnDefinition
	): void {
		// Get or create table definition map
		if (!this.#tableDefinitions.has(sourceTable)) {
			this.#tableDefinitions.set(sourceTable, new Map());
			this.#referenceCount.set(sourceTable, new Set());
		}

		const columns = this.#tableDefinitions.get(sourceTable)!;
		const refs = this.#referenceCount.get(sourceTable)!;

		// Check if column already exists with same SQL
		const existing = columns.get(alias);
		if (existing && existing.sql === sql) {
			// Same definition, just add reference
			refs.add(scaleId);
			console.log(`[ViewManager] Column ${alias} already registered for ${sourceTable}`);
			return;
		}

		// Register the column
		columns.set(alias, { sql, source, scaleId });
		refs.add(scaleId);

		console.log(`[ViewManager] Registered column ${alias} for ${sourceTable}:`, {
			sql: sql.slice(0, 100) + (sql.length > 100 ? '...' : ''),
			source,
			scaleId
		});

		// Schedule view update
		this.#scheduleViewUpdate(sourceTable);
	}

	unregisterColumn(sourceTable: string, alias: string, scaleId: string): void {
		if (!this.#tableDefinitions.has(sourceTable)) return;

		const refs = this.#referenceCount.get(sourceTable)!;
		refs.delete(scaleId);

		// If no more references to this table's columns from this scale, check column
		const columns = this.#tableDefinitions.get(sourceTable)!;
		const column = columns.get(alias);

		if (column && column.scaleId === scaleId) {
			// Only remove if this scale owns the column
			columns.delete(alias);
			console.log(`[ViewManager] Unregistered column ${alias} for ${sourceTable}`);

			// If no columns left, could potentially drop the view
			// For now, just schedule an update (view will have no extra columns)
			this.#scheduleViewUpdate(sourceTable);
		}
	}

	getEffectiveTable(sourceTable: string): string {
		// Read version to establish reactive dependency for external callers
		void this.version;
		const state = this.#tableStates.get(sourceTable);
		return state ? state.viewName : sourceTable;
	}

	hasView(sourceTable: string): boolean {
		void this.version;
		return this.#tableStates.has(sourceTable);
	}

	isViewPending(sourceTable: string): boolean {
		void this.version;
		return this.#pendingViews.has(sourceTable);
	}

	isReadyForClient(sourceTable: string): boolean {
		void this.version;
		// If no columns registered, no view expected - safe to use source table
		if (!this.#tableDefinitions.has(sourceTable)) return true;
		// If view is pending, wait
		if (this.#pendingViews.has(sourceTable)) return false;
		// If view exists, it's ready
		return this.#tableStates.has(sourceTable);
	}

	getVersion(sourceTable: string): number {
		const state = this.#tableStates.get(sourceTable);
		return state?.version ?? 0;
	}

	getRegisteredColumns(sourceTable: string): string[] {
		const columns = this.#tableDefinitions.get(sourceTable);
		return columns ? [...columns.keys()] : [];
	}

	static buildCaseExpression(
		sourceColumn: string,
		domain: unknown[],
		{ oneBased = false } = {}
	): string {
		if (!domain || domain.length === 0) {
			// Return float literal for empty domain
			return oneBased ? 'CAST(0 AS REAL)' : 'CAST(-1 AS REAL)';
		}

		// Warn about high cardinality
		if (domain.length > ViewManagerService.CARDINALITY_WARNING) {
			console.warn(
				`[ViewManager] High cardinality warning: ${domain.length} categories for ${sourceColumn}. ` +
					`Consider using a continuous scale or binning.`
			);
		}

		const offset = oneBased ? 1 : 0;
		const defaultValue = oneBased ? 0 : -1;

		const whenClauses = domain
			.map((value, index) => `WHEN "${sourceColumn}" = ${escapeSql(value)} THEN ${index + offset}`)
			.join(' ');

		// CRITICAL: Cast to REAL (Float32) so Arrow returns Float32Array, not Int32Array
		return `CAST(CASE ${whenClauses} ELSE ${defaultValue} END AS REAL)`;
	}

	static colorIndexColumn(field: string): string {
		return `__dplot_${field}_color_idx`;
	}

	static bandIndexColumn(field: string): string {
		return `__dplot_${field}_idx`;
	}

	static timeOffsetColumn(field: string): string {
		return `__dplot_${field}_time_offset`;
	}

	// =========================================================================
	// PRIVATE METHODS
	// =========================================================================

	#scheduleViewUpdate(sourceTable: string): void {
		this.#pendingUpdates.add(sourceTable);

		// Mark as pending so clients know to wait
		this.#pendingViews.add(sourceTable);
		this.version++; // Trigger reactive updates

		if (!this.#updateScheduled) {
			this.#updateScheduled = true;
			queueMicrotask(() => this.#flushUpdates());
		}
	}

	async #flushUpdates(): Promise<void> {
		this.#updateScheduled = false;
		const tables = [...this.#pendingUpdates];
		this.#pendingUpdates.clear();

		for (const table of tables) {
			await this.#createOrUpdateView(table);
		}
	}

	async #createOrUpdateView(sourceTable: string): Promise<void> {
		if (!this.#coordinator) {
			console.log(`[ViewManager] No coordinator, deferring view creation for ${sourceTable}`);
			this.#pendingViews.delete(sourceTable);
			this.version++;
			return;
		}

		// Serialize: if a CREATE VIEW is already in-flight for this table,
		// mark it dirty so it rebuilds after the current one finishes.
		const existingLock = this.#tableLocks.get(sourceTable);
		if (existingLock) {
			this.#dirtyDuringLock.add(sourceTable);
			console.log(`[ViewManager] View creation in-flight for ${sourceTable}, will rebuild after`);
			return;
		}

		// Keep view pending through the entire create+rebuild cycle so marks
		// don't query a view that's missing columns still being registered.
		this.#pendingViews.add(sourceTable);

		let needsRebuild = true;
		while (needsRebuild) {
			this.#dirtyDuringLock.delete(sourceTable);
			const lockPromise = this.#doCreateView(sourceTable);
			this.#tableLocks.set(sourceTable, lockPromise);
			try {
				await lockPromise;
			} finally {
				this.#tableLocks.delete(sourceTable);
			}
			needsRebuild = this.#dirtyDuringLock.has(sourceTable);
			if (needsRebuild) {
				console.log(`[ViewManager] Rebuilding ${sourceTable} with columns added during lock`);
			}
		}

		// Only now mark the view as ready for queries
		this.#pendingViews.delete(sourceTable);
		this.version++;
	}

	async #doCreateView(sourceTable: string): Promise<void> {
		const columns = this.#tableDefinitions.get(sourceTable);
		if (!columns || columns.size === 0) {
			// No columns - remove from reactive state
			this.#tableStates.delete(sourceTable);
			console.log(`[ViewManager] No columns for ${sourceTable}, skipping view creation`);
			return;
		}

		// Version the view name — session ID prevents collisions across render contexts
		const currentVersion = (this.#tableStates.get(sourceTable)?.version ?? 0) + 1;
		const viewName = `${sourceTable}_s${this.#sessionId}_v${currentVersion}`;

		// Build SELECT clause: all original columns + computed columns
		const computedColumns = [...columns.entries()]
			.map(([alias, def]) => `${def.sql} AS "${alias}"`)
			.join(',\n  ');

		const sql = `CREATE OR REPLACE VIEW ${viewName} AS
SELECT *,
  ${computedColumns}
FROM ${sourceTable}`;

		console.log(`[ViewManager] Creating view ${viewName}:`, sql);

		try {
			await this.#coordinator!.exec(sql);

			// Update table state (view name + version) but DON'T clear pendingViews —
			// the caller (#createOrUpdateView) handles that after confirming no more
			// dirty columns arrived.
			this.#tableStates.set(sourceTable, { viewName, version: currentVersion });
			this.version++;

			console.log(`[ViewManager] View ${viewName} created (version ${currentVersion})`);
		} catch (error) {
			console.error(`[ViewManager] Failed to create view ${viewName}:`, error);
		}
	}

	// =========================================================================
	// DEBUG
	// =========================================================================

	getDebugInfo() {
		const tables: Record<string, unknown> = {};
		for (const [table, columns] of this.#tableDefinitions) {
			const state = this.#tableStates.get(table);
			tables[table] = {
				columns: Object.fromEntries(columns),
				references: [...(this.#referenceCount.get(table) || [])],
				version: state?.version ?? 0,
				viewName: state?.viewName ?? null,
				effectiveTable: this.getEffectiveTable(table)
			};
		}
		return {
			hasCoordinator: !!this.#coordinator,
			tables
		};
	}
}

// Singleton instance
export const viewManager = new ViewManagerService();

// Also export the class for testing
export { ViewManagerService };
