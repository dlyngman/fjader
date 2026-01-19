// src/lib/data/ViewManager.svelte.js

/**
 * Escapes a value for use in SQL CASE expressions.
 * @param {*} value - The value to escape
 * @returns {string} SQL-safe string
 */
function escapeSql(value) {
	if (value === null || value === undefined) return 'NULL';
	return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * ViewManager creates and manages DuckDB views that add computed index columns
 * for categorical data. This moves the category-to-integer indexing from JavaScript
 * into SQL, enabling zero-copy Float32 data flow to the GPU.
 *
 * Key features:
 * - Lazy coordinator injection (setCoordinator)
 * - Reference counting for column cleanup
 * - Debounced view creation via queueMicrotask
 * - Global domain (ignores crossfilters)
 *
 * Column naming conventions:
 * - Color index: __dplot_{field}_color_idx (1-based, 0 = null/unknown)
 * - Band index: __dplot_{field}_idx (0-based)
 *
 * View naming: {table}_derived
 */
class ViewManagerService {
	// Map<sourceTable, Map<columnAlias, ColumnDefinition>>
	#tableDefinitions = new Map();

	// Mosaic coordinator (set lazily)
	#coordinator = null;

	// Map<sourceTable, Set<scaleId>> - tracks which scales use each table
	#referenceCount = new Map();

	// REACTIVITY FIX: Reactive map for table states
	// When view is created, this triggers derivations to re-run
	#tableStates = $state(new Map()); // Map<sourceTable, { viewName, version }>

	// Track tables with pending view creation - prevents eager client creation
	#pendingViews = $state(new Set());

	// Global version counter - external code reads this to establish Svelte dependency
	// Incremented whenever any view state changes (pending or ready)
	version = $state(0);

	// Pending view updates (debounced via queueMicrotask)
	#pendingUpdates = new Set();
	#updateScheduled = false;

	// Cardinality warning threshold
	static CARDINALITY_WARNING = 50;

	/**
	 * Set the Mosaic coordinator. Called lazily when coordinator becomes available.
	 * @param {Object} coordinator - Mosaic coordinator instance
	 */
	setCoordinator(coordinator) {
		if (this.#coordinator === coordinator) return;

		this.#coordinator = coordinator;
		console.log('[ViewManager] Coordinator set');

		// Rebuild any pending views now that we have a coordinator
		for (const table of this.#tableDefinitions.keys()) {
			this.#scheduleViewUpdate(table);
		}
	}

	/**
	 * Get the Mosaic coordinator.
	 * @returns {Object|null}
	 */
	getCoordinator() {
		return this.#coordinator;
	}

	/**
	 * Register a computed column for a source table.
	 *
	 * @param {string} sourceTable - The base table name
	 * @param {string} alias - Column alias (e.g., '__dplot_species_color_idx')
	 * @param {Object} definition - Column definition
	 * @param {string} definition.sql - SQL expression for the column
	 * @param {string} definition.source - Original source column name
	 * @param {string} definition.scaleId - ID of the scale registering this column
	 */
	registerColumn(sourceTable, alias, { sql, source, scaleId }) {
		// Get or create table definition map
		if (!this.#tableDefinitions.has(sourceTable)) {
			this.#tableDefinitions.set(sourceTable, new Map());
			this.#referenceCount.set(sourceTable, new Set());
		}

		const columns = this.#tableDefinitions.get(sourceTable);
		const refs = this.#referenceCount.get(sourceTable);

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

	/**
	 * Unregister a column when a scale is destroyed.
	 *
	 * @param {string} sourceTable - The base table name
	 * @param {string} alias - Column alias
	 * @param {string} scaleId - ID of the scale unregistering
	 */
	unregisterColumn(sourceTable, alias, scaleId) {
		if (!this.#tableDefinitions.has(sourceTable)) return;

		const refs = this.#referenceCount.get(sourceTable);
		refs.delete(scaleId);

		// If no more references to this table's columns from this scale, check column
		const columns = this.#tableDefinitions.get(sourceTable);
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

	/**
	 * Get the effective table name for queries.
	 * Returns the derived view name if view is ready, otherwise the source table.
	 * REACTIVITY: Reads version to establish Svelte dependency.
	 *
	 * @param {string} sourceTable - The base table name
	 * @returns {string} The table name to use in queries
	 */
	getEffectiveTable(sourceTable) {
		// Read version to establish reactive dependency for external callers
		void this.version;
		const state = this.#tableStates.get(sourceTable);
		return state ? state.viewName : sourceTable;
	}

	/**
	 * Check if a derived view exists and is ready for a table.
	 * REACTIVITY: Reads version to establish Svelte dependency.
	 *
	 * @param {string} sourceTable - The base table name
	 * @returns {boolean}
	 */
	hasView(sourceTable) {
		void this.version;
		return this.#tableStates.has(sourceTable);
	}

	/**
	 * Check if a view creation is pending/in-progress for a table.
	 * Used to prevent eager client creation before view is ready.
	 * REACTIVITY: Reads version to establish Svelte dependency.
	 *
	 * @param {string} sourceTable - The base table name
	 * @returns {boolean}
	 */
	isViewPending(sourceTable) {
		void this.version;
		return this.#pendingViews.has(sourceTable);
	}

	/**
	 * Check if it's safe to create a client for this table.
	 * Returns true if either: no view is expected, or view is ready.
	 * Returns false if view creation is pending.
	 *
	 * @param {string} sourceTable - The base table name
	 * @returns {boolean}
	 */
	isReadyForClient(sourceTable) {
		void this.version;
		// If no columns registered, no view expected - safe to use source table
		if (!this.#tableDefinitions.has(sourceTable)) return true;
		// If view is pending, wait
		if (this.#pendingViews.has(sourceTable)) return false;
		// If view exists, it's ready
		return this.#tableStates.has(sourceTable);
	}

	/**
	 * Get the reactive version for a table (for Svelte dependency tracking).
	 *
	 * @param {string} sourceTable - The base table name
	 * @returns {number}
	 */
	getVersion(sourceTable) {
		const state = this.#tableStates.get(sourceTable);
		return state?.version ?? 0;
	}

	/**
	 * Get registered column names for a table.
	 *
	 * @param {string} sourceTable - The base table name
	 * @returns {string[]} Array of column aliases
	 */
	getRegisteredColumns(sourceTable) {
		const columns = this.#tableDefinitions.get(sourceTable);
		return columns ? [...columns.keys()] : [];
	}

	/**
	 * Build a CASE expression for categorical indexing.
	 * Returns CAST(...AS REAL) to ensure Float32Array from Arrow/DuckDB.
	 *
	 * @param {string} sourceColumn - The source column name
	 * @param {Array} domain - Array of category values
	 * @param {Object} options
	 * @param {boolean} [options.oneBased=false] - Use 1-based indexing (for colors)
	 * @returns {string} SQL CASE expression wrapped in CAST to REAL
	 */
	static buildCaseExpression(sourceColumn, domain, { oneBased = false } = {}) {
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

	/**
	 * Build the column alias for a color index column.
	 * @param {string} field - The source field name
	 * @returns {string}
	 */
	static colorIndexColumn(field) {
		return `__dplot_${field}_color_idx`;
	}

	/**
	 * Build the column alias for a band index column.
	 * @param {string} field - The source field name
	 * @returns {string}
	 */
	static bandIndexColumn(field) {
		return `__dplot_${field}_idx`;
	}

	// =========================================================================
	// PRIVATE METHODS
	// =========================================================================

	/**
	 * Schedule a view update for the next microtask (debounced).
	 */
	#scheduleViewUpdate(sourceTable) {
		this.#pendingUpdates.add(sourceTable);

		// Mark as pending so clients know to wait
		this.#pendingViews.add(sourceTable);
		this.version++; // Trigger reactive updates

		if (!this.#updateScheduled) {
			this.#updateScheduled = true;
			queueMicrotask(() => this.#flushUpdates());
		}
	}

	/**
	 * Flush all pending view updates.
	 */
	async #flushUpdates() {
		this.#updateScheduled = false;
		const tables = [...this.#pendingUpdates];
		this.#pendingUpdates.clear();

		for (const table of tables) {
			await this.#createOrUpdateView(table);
		}
	}

	/**
	 * Create or update the derived view for a table.
	 */
	async #createOrUpdateView(sourceTable) {
		if (!this.#coordinator) {
			console.log(`[ViewManager] No coordinator, deferring view creation for ${sourceTable}`);
			this.#pendingViews.delete(sourceTable);
			this.version++;
			return;
		}

		const columns = this.#tableDefinitions.get(sourceTable);
		if (!columns || columns.size === 0) {
			// No columns - remove from reactive state
			this.#tableStates.delete(sourceTable);
			this.#pendingViews.delete(sourceTable);
			this.version++;
			console.log(`[ViewManager] No columns for ${sourceTable}, skipping view creation`);
			return;
		}

		// Version the view name to bust caches
		const currentVersion = (this.#tableStates.get(sourceTable)?.version ?? 0) + 1;
		const viewName = `${sourceTable}_derived_v${currentVersion}`;

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
			await this.#coordinator.exec(sql);

			// Update reactive state - view is now ready
			this.#tableStates.set(sourceTable, { viewName, version: currentVersion });
			this.#pendingViews.delete(sourceTable);
			this.version++; // Trigger reactive updates - clients can now be created

			console.log(`[ViewManager] View ${viewName} ready (version ${currentVersion})`);
		} catch (error) {
			console.error(`[ViewManager] Failed to create view ${viewName}:`, error);
			this.#pendingViews.delete(sourceTable);
			this.version++;
		}
	}

	// =========================================================================
	// DEBUG
	// =========================================================================

	/**
	 * Get debug information about the ViewManager state.
	 */
	getDebugInfo() {
		const tables = {};
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
