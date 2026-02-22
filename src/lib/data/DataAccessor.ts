import type { Table } from '@uwdata/flechette';

export class ArrowDataAccessor {
	arrowTable: Table;
	type = 'arrow' as const;

	constructor(arrowTable: Table) {
		this.arrowTable = arrowTable;
	}

	get length(): number {
		return this.arrowTable.numRows;
	}

	get columnNames(): string[] {
		return this.arrowTable.schema.fields.map((f) => f.name);
	}

	getColumn(name: string): Float32Array | ArrayLike<unknown> | null {
		const col = this.arrowTable.getChild(name);
		if (!col) return null;

		// Check if this is a string/dictionary column - must use toArray() for proper decoding
		const dtype = col.type;
		const isStringType =
			dtype?.typeId === 5 || // Utf8
			dtype?.typeId === 6 || // Binary
			dtype?.typeId === 13 || // Dictionary (often used for categorical strings)
			dtype?.toString?.().includes('Utf8') ||
			dtype?.toString?.().includes('Dictionary');

		// FAST PATH: Single chunk numeric - try to return underlying buffer directly
		if (!isStringType && col.data.length === 1) {
			const raw = col.data[0].values;

			// Already Float32Array - zero copy!
			if (raw instanceof Float32Array) {
				return raw;
			}

			// Numeric typed array - convert to Float32
			if (
				raw instanceof Float64Array ||
				raw instanceof Int8Array ||
				raw instanceof Int16Array ||
				raw instanceof Int32Array ||
				raw instanceof Uint8Array ||
				raw instanceof Uint16Array ||
				raw instanceof Uint32Array
			) {
				return new Float32Array(raw);
			}
		}

		// SLOW PATH: Multi-chunk, string columns, or non-numeric - use toArray()
		const arr = col.toArray();
		if (!arr) return null;

		// Ensure Float32Array for numeric types
		if (arr instanceof Float32Array) {
			return arr;
		}

		if (arr instanceof Float64Array) {
			return new Float32Array(arr);
		}

		// Integer types → Float32
		if (
			arr instanceof Int8Array ||
			arr instanceof Int16Array ||
			arr instanceof Int32Array ||
			arr instanceof Uint8Array ||
			arr instanceof Uint16Array ||
			arr instanceof Uint32Array
		) {
			return new Float32Array(arr);
		}

		// Non-numeric (strings, dates) - return as-is
		return arr;
	}

	withOverlays(overlays: Record<string, Float32Array>): OverlayDataAccessor {
		return new OverlayDataAccessor(this, new Map(Object.entries(overlays)));
	}

	toString(): string {
		return `ArrowDataAccessor(${this.length} rows)`;
	}
}

export class OverlayDataAccessor {
	#base: DataAccessor;
	#overlays: Map<string, Float32Array>;
	type = 'overlay' as const;

	constructor(base: DataAccessor, overlays: Map<string, Float32Array>) {
		this.#base = base;
		this.#overlays = overlays;
	}

	get length(): number {
		return this.#base.length;
	}

	get columnNames(): string[] {
		const baseNames = this.#base.columnNames;
		const overlayNames = [...this.#overlays.keys()].filter((n) => !baseNames.includes(n));
		return [...baseNames, ...overlayNames];
	}

	getColumn(name: string): Float32Array | ArrayLike<unknown> | null {
		return this.#overlays.get(name) ?? this.#base.getColumn(name);
	}

	/** Merge new overlays with existing ones, keeping the same base. */
	withOverlays(overlays: Record<string, Float32Array>): OverlayDataAccessor {
		const merged = new Map(this.#overlays);
		for (const [k, v] of Object.entries(overlays)) {
			merged.set(k, v);
		}
		return new OverlayDataAccessor(this.#base, merged);
	}

	/** Access to underlying base accessor (for tooltip or other introspection). */
	get base(): DataAccessor {
		return this.#base;
	}

	toString(): string {
		return `OverlayDataAccessor(${this.length} rows, ${this.#overlays.size} overlays)`;
	}
}

export type DataAccessor = ArrowDataAccessor | ObjectDataAccessor | OverlayDataAccessor;

export class ObjectDataAccessor {
	data: Record<string, unknown>[];
	type = 'objects' as const;
	_columnTypes: Map<string, string> = new Map();

	constructor(data: Record<string, unknown>[]) {
		this.data = data;
	}

	get length(): number {
		return this.data.length;
	}

	get columnNames(): string[] {
		if (!this.data || this.data.length === 0) return [];
		return Object.keys(this.data[0]);
	}

	getColumn(name: string): Float32Array | unknown[] | null {
		if (!this.data || this.data.length === 0) return null;

		// Infer type from first non-null value
		let columnType = this._columnTypes.get(name);

		if (!columnType) {
			const firstValue = this.data.find((d) => d[name] != null)?.[name];
			if (firstValue === undefined) {
				// All values are null/undefined
				return new Float32Array(this.data.length); // Return zeros
			}
			columnType = typeof firstValue;
			this._columnTypes.set(name, columnType);
		}

		// Numeric columns → Float32Array
		if (columnType === 'number') {
			const arr = new Float32Array(this.data.length);
			for (let i = 0; i < this.data.length; i++) {
				const value = this.data[i]?.[name];
				arr[i] = typeof value === 'number' ? value : 0;
			}
			return arr;
		}

		// Non-numeric → plain array
		return this.data.map((d) => d?.[name] ?? null);
	}

	withOverlays(overlays: Record<string, Float32Array>): OverlayDataAccessor {
		return new OverlayDataAccessor(this, new Map(Object.entries(overlays)));
	}

	toString(): string {
		return `ObjectDataAccessor(${this.length} rows)`;
	}
}
