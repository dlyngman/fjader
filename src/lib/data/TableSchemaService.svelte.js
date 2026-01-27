// src/lib/data/TableSchemaService.svelte.js

/**
 * TableSchemaService caches table schemas from DuckDB.
 * Used for inferring column types (numeric vs categorical) for scale type detection.
 *
 * Pattern follows ViewManager:
 * - Singleton with lazy coordinator injection
 * - Reactive state for Svelte integration
 * - One DESCRIBE query per unique table
 */
class TableSchemaServiceImpl {
	#coordinator = null;
	#schemas = $state(new Map()); // Map<tableName, Map<columnName, { sqlType, jsType }>>
	#pending = new Set(); // Tables currently being fetched
	#deferredRequests = new Set(); // Tables requested before coordinator was available

	// Reactive version counter - external code reads this to establish dependency
	version = $state(0);

	/**
	 * Set the Mosaic coordinator. Called lazily when available.
	 * @param {Object} coordinator - Mosaic coordinator instance
	 */
	setCoordinator(coordinator) {
		if (this.#coordinator === coordinator) return;
		this.#coordinator = coordinator;

		// Fetch schemas for tables that were requested before coordinator was available
		for (const tableName of this.#deferredRequests) {
			this.#fetchSchema(tableName);
		}
		this.#deferredRequests.clear();
	}

	/**
	 * Get the Mosaic coordinator.
	 * @returns {Object|null}
	 */
	getCoordinator() {
		return this.#coordinator;
	}

	/**
	 * Request schema for a table. Triggers async fetch if not cached.
	 * Returns cached schema or null if not yet available.
	 * @param {string} tableName
	 * @returns {Map<string, {sqlType: string, jsType: string}>|null}
	 */
	getSchema(tableName) {
		if (this.#schemas.has(tableName)) {
			return this.#schemas.get(tableName);
		}

		// Trigger fetch if coordinator available, otherwise defer
		if (this.#coordinator) {
			if (!this.#pending.has(tableName)) {
				this.#fetchSchema(tableName);
			}
		} else {
			// Coordinator not yet available - remember this request for later
			this.#deferredRequests.add(tableName);
		}

		return null;
	}

	/**
	 * Get the JavaScript type for a specific column.
	 * Returns null if schema not yet available.
	 * @param {string} tableName
	 * @param {string} columnName
	 * @returns {'number'|'string'|'date'|'boolean'|null}
	 */
	getColumnType(tableName, columnName) {
		const schema = this.#schemas.get(tableName);
		return schema?.get(columnName)?.jsType ?? null;
	}

	/**
	 * Check if schema is ready for a table.
	 * @param {string} tableName
	 * @returns {boolean}
	 */
	isReady(tableName) {
		return this.#schemas.has(tableName);
	}

	/**
	 * Fetch schema from DuckDB using DESCRIBE query.
	 * @param {string} tableName
	 */
	async #fetchSchema(tableName) {
		if (this.#pending.has(tableName)) return;
		this.#pending.add(tableName);

		try {
			// DuckDB DESCRIBE returns: column_name, column_type, null, key, default, extra
			const result = await this.#coordinator.query(`DESCRIBE "${tableName}"`);

			const schema = new Map();
			for (const row of result) {
				schema.set(row.column_name, {
					sqlType: row.column_type,
					jsType: this.#mapSqlTypeToJs(row.column_type)
				});
			}

			this.#schemas.set(tableName, schema);
			this.version++; // Trigger reactive updates
		} catch (e) {
			console.warn(`[TableSchemaService] Failed to query schema for ${tableName}:`, e);
			// Mark as attempted with empty schema to avoid retry loops
			this.#schemas.set(tableName, new Map());
			this.version++;
		} finally {
			this.#pending.delete(tableName);
		}
	}

	/**
	 * Map DuckDB SQL type to simplified JavaScript type.
	 * @param {string} sqlType - DuckDB column type
	 * @returns {'number'|'string'|'date'|'boolean'}
	 */
	#mapSqlTypeToJs(sqlType) {
		const upper = (sqlType || '').toUpperCase();

		// Numeric types
		if (/INT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|BIGINT|SMALLINT|TINYINT|HUGEINT/.test(upper)) {
			return 'number';
		}

		// Temporal types
		if (/DATE|TIME|TIMESTAMP|INTERVAL/.test(upper)) {
			return 'date';
		}

		// Boolean
		if (/BOOL/.test(upper)) {
			return 'boolean';
		}

		// Default: string (VARCHAR, CHAR, BLOB, UUID, etc.)
		return 'string';
	}
}

export const tableSchemaService = new TableSchemaServiceImpl();
