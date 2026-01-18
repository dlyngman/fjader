// src/lib/sql/bin.js

import { binDate, binHistogram, sql, column } from '@uwdata/mosaic-sql';

/**
 * Bin numeric or temporal data into discrete intervals
 * 
 * Three modes:
 * 1. Explicit numeric: bin('age', { step: 5 })
 * 2. Explicit temporal: bin('date', { interval: 'day' })
 * 3. Auto: bin('age') - uses field statistics
 * 
 * @param {string|Expression} field - Field to bin
 * @param {object} options - Configuration
 * @param {number} options.step - Explicit bin size (numeric)
 * @param {string} options.interval - Explicit interval (temporal: day, week, month, year)
 * @param {number} options.offset - Offset for bin boundaries
 * @param {number} options.thresholds - Target number of bins (auto mode)
 * @param {boolean} options.nice - Use nice round numbers (auto mode)
 * @returns {Expression|AutoBinNode}
 */
export function bin(field, options = {}) {
  const { step, interval, offset = 0 } = options;
  
  // Explicit numeric binning
  if (step !== undefined) {
    const col = typeof field === 'string' ? column(field) : field;
    return sql`FLOOR((${col} - ${offset}) / ${step}) * ${step} + ${offset}`;
  }
  
  // Explicit temporal binning
  if (interval !== undefined) {
    const col = typeof field === 'string' ? column(field) : field;
    // Use Mosaic's binDate helper
    return binDate(col, null, options);
  }
  
  // Auto mode - defer resolution until we have field statistics
  return new AutoBinNode(field, options);
}

/**
 * Auto-binning node that defers SQL generation until field statistics are available
 * This allows optimal bin sizing based on actual data range
 */
export class AutoBinNode {
  constructor(field, options = {}) {
    this.field = field;
    this.options = options;
    this.isAutoBinNode = true; // Marker for detection
  }
  
  /**
   * Get field statistics needed for this bin
   * Called by BaseMarkSetup to build field info requests
   */
  get stats() {
    const fieldName = typeof this.field === 'string' ? this.field : this.field.toString();
    return {
      column: fieldName,
      stats: ['min', 'max']
    };
  }
  
  /**
   * Resolve to concrete SQL expression once field statistics are available
   * @param {object} fieldInfo - Field statistics from DataClient
   * @param {string} scaleType - Scale type (linear, time, etc.)
   * @returns {Expression} Mosaic SQL expression
   */
  resolve(fieldInfo, scaleType) {
    const fieldName = typeof this.field === 'string' ? this.field : this.field.toString();
    const info = fieldInfo[fieldName] || {};
    const { min, max, type } = info;
    
    if (min === undefined || max === undefined) {
      throw new Error(
        `Cannot auto-bin field "${fieldName}": missing min/max statistics. ` +
        `This may happen if the field contains only NULL values or doesn't exist in the table.`
      );
    }
    
    const col = typeof this.field === 'string' ? column(this.field) : this.field;
    
    // Detect if temporal
    const isTemporal = 
      this.options.interval !== undefined ||
      type === 'date' ||
      scaleType === 'time' ||
      scaleType === 'utc';
    
    if (isTemporal) {
      // Use Mosaic's binDate helper
      return binDate(col, [min, max], this.options);
    } else {
      // Use Mosaic's binHistogram helper
      return binHistogram(col, [min, max], this.options);
    }
  }
  
  /**
   * For extent marks (rect, rule), create offset version
   * @param {number} offset - Bin offset
   * @returns {AutoBinNode}
   */
  withOffset(offset) {
    return new AutoBinNode(this.field, {
      ...this.options,
      offset
    });
  }
}

/**
 * Helper to check if an expression is a bin
 * @param {*} expr
 * @returns {boolean}
 */
export function isBinExpression(expr) {
  if (!expr) return false;
  
  // Check for AutoBinNode
  if (expr.isAutoBinNode) return true;
  
  // Check for explicit bin SQL (contains FLOOR)
  const sql = expr.toString?.() || '';
  return /FLOOR\s*\(/i.test(sql);
}

/**
 * Expand bin to extent (x1/x2 or y1/y2) for rect/rule marks
 * @param {Expression|AutoBinNode} binExpr
 * @param {string} channel - 'x' or 'y'
 * @param {string} markType - 'rect', 'rule', etc.
 * @returns {object} Map of channels
 */
export function expandBinForExtent(binExpr, channel, markType) {
  if (!isBinExpression(binExpr)) {
    return { [channel]: binExpr };
  }
  
  // Check if mark needs extent
  const needsExtent = ['rect', 'rectX', 'rectY', 'rule', 'ruleX', 'ruleY'].includes(markType);
  
  if (!needsExtent) {
    return { [channel]: binExpr };
  }
  
  // Auto bin - create offset version
  if (binExpr.isAutoBinNode) {
    return {
      [`${channel}1`]: binExpr,
      [`${channel}2`]: binExpr.withOffset(1)
    };
  }
  
  // Explicit bin - add offset to SQL
  return {
    [`${channel}1`]: binExpr,
    [`${channel}2`]: sql`${binExpr} + 1`
  };
}