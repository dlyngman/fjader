// src/lib/data/DataAccessor.js

export class ArrowDataAccessor {
  constructor(arrowTable) {
    this.arrowTable = arrowTable;
    this.type = 'arrow';
  }

  get length() {
    return this.arrowTable.numRows;
  }

  get columnNames() {
    return this.arrowTable.schema.fields.map(f => f.name);
  }

  getColumn(name) {
    const col = this.arrowTable.getChild(name);
    if (!col) return null;

    // FAST PATH: Single chunk - try to return underlying buffer directly
    if (col.data.length === 1) {
      const raw = col.data[0].values;

      // Already Float32Array - zero copy!
      if (raw instanceof Float32Array) {
        return raw;
      }

      // Numeric typed array - convert to Float32
      if (ArrayBuffer.isView(raw) && typeof raw[0] === 'number') {
        return new Float32Array(raw);
      }
    }

    // SLOW PATH: Multi-chunk or non-numeric - use toArray()
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
    if (arr instanceof Int8Array || arr instanceof Int16Array ||
        arr instanceof Int32Array || arr instanceof Uint8Array ||
        arr instanceof Uint16Array || arr instanceof Uint32Array ||
        arr instanceof BigInt64Array || arr instanceof BigUint64Array) {
      return new Float32Array(arr);
    }

    // Non-numeric (strings, dates) - return as-is
    return arr;
  }

  toString() {
    return `ArrowDataAccessor(${this.length} rows)`;
  }
}

export class ObjectDataAccessor {
  constructor(data) {
    this.data = data;
    this.type = 'objects';
    this._columnTypes = new Map();
  }

  get length() {
    return this.data.length;
  }

  get columnNames() {
    if (!this.data || this.data.length === 0) return [];
    return Object.keys(this.data[0]);
  }
  
  getColumn(name) {
    if (!this.data || this.data.length === 0) return null;
    
    // Infer type from first non-null value
    let columnType = this._columnTypes.get(name);
    
    if (!columnType) {
      const firstValue = this.data.find(d => d[name] != null)?.[name];
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
    return this.data.map(d => d?.[name] ?? null);
  }
  
  toString() {
    return `ObjectDataAccessor(${this.length} rows)`;
  }
}