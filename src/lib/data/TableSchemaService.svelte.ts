// src/lib/data/TableSchemaService.svelte.ts

import type { QueryEngine, ColumnInfo } from '$lib/query-engine/QueryEngine';
import { mapSqlTypeToJs, type JsColumnType } from '$lib/query-engine/QueryEngine';

export type { JsColumnType };

export interface ColumnSchemaEntry {
	sqlType: string;
	jsType: JsColumnType;
}

/**
 * TableSchemaService caches table schemas with JS type mapping.
 * Uses QueryEngine.describe() for the raw DESCRIBE query (already cached/deduped).
 * Adds the jsType mapping layer needed by inferMarkScaleType, MarkColor, etc.
 */
class TableSchemaServiceImpl {
	#queryEngine: QueryEngine | null = null;
	#schemas = $state(new Map<string, Map<string, ColumnSchemaEntry>>());

	// Reactive version counter — read by $derived in inferMarkScaleType, MarkColor
	version = $state(0);

	setQueryEngine(queryEngine: QueryEngine): void {
		this.#queryEngine = queryEngine;
	}

	getSchema(tableName: string): Map<string, ColumnSchemaEntry> | null {
		if (this.#schemas.has(tableName)) {
			return this.#schemas.get(tableName)!;
		}

		// Trigger async fetch — reactive consumers re-derive when version bumps
		if (this.#queryEngine) {
			this.#fetchSchema(tableName);
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

	/**
	 * Ensure the schema for a table is loaded. Returns immediately if cached,
	 * otherwise awaits the fetch. Safe to call from multiple marks — deduplicates
	 * via QueryEngine's describe cache.
	 */
	async ensure(tableName: string): Promise<Map<string, ColumnSchemaEntry>> {
		if (this.#schemas.has(tableName)) {
			return this.#schemas.get(tableName)!;
		}
		if (this.#queryEngine) {
			await this.#fetchSchema(tableName);
		}
		return this.#schemas.get(tableName) ?? new Map();
	}

	async #fetchSchema(tableName: string): Promise<void> {
		if (!this.#queryEngine) return;

		try {
			const columns = await this.#queryEngine.describe(tableName);
			const schema = new Map<string, ColumnSchemaEntry>();
			for (const col of columns) {
				schema.set(col.name, {
					sqlType: col.type,
					jsType: mapSqlTypeToJs(col.type)
				});
			}
			this.#schemas.set(tableName, schema);
			this.version++;
		} catch (e) {
			console.warn(`[TableSchemaService] Failed to query schema for ${tableName}:`, e);
			this.#schemas.set(tableName, new Map());
			this.version++;
		}
	}
}

export const tableSchemaService = new TableSchemaServiceImpl();
