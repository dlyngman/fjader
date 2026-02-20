// src/lib/data/TableSchemaService.svelte.ts

import type { Coordinator } from '@uwdata/mosaic-core';

export type JsColumnType = 'number' | 'string' | 'date' | 'boolean';

export interface ColumnSchemaEntry {
	sqlType: string;
	jsType: JsColumnType;
}

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
	#coordinator: Coordinator | null = null;
	#schemas = $state(new Map<string, Map<string, ColumnSchemaEntry>>());
	#pending = new Set<string>(); // Tables currently being fetched
	#deferredRequests = new Set<string>(); // Tables requested before coordinator was available

	// Reactive version counter - external code reads this to establish dependency
	version = $state(0);

	setCoordinator(coordinator: Coordinator): void {
		if (this.#coordinator === coordinator) return;
		this.#coordinator = coordinator;

		// Fetch schemas for tables that were requested before coordinator was available
		for (const tableName of this.#deferredRequests) {
			this.#fetchSchema(tableName);
		}
		this.#deferredRequests.clear();
	}

	getCoordinator(): Coordinator | null {
		return this.#coordinator;
	}

	getSchema(tableName: string): Map<string, ColumnSchemaEntry> | null {
		if (this.#schemas.has(tableName)) {
			return this.#schemas.get(tableName)!;
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

	getColumnType(tableName: string, columnName: string): JsColumnType | null {
		const schema = this.#schemas.get(tableName);
		return schema?.get(columnName)?.jsType ?? null;
	}

	isReady(tableName: string): boolean {
		return this.#schemas.has(tableName);
	}

	async #fetchSchema(tableName: string): Promise<void> {
		if (this.#pending.has(tableName)) return;
		this.#pending.add(tableName);

		try {
			// DuckDB DESCRIBE returns: column_name, column_type, null, key, default, extra
			const result = await (this.#coordinator as any).query(`DESCRIBE "${tableName}"`);

			const schema = new Map<string, ColumnSchemaEntry>();
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

	#mapSqlTypeToJs(sqlType: string): JsColumnType {
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
