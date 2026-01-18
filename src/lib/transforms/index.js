// src/lib/transforms/index.js

/**
 * Transform Pipeline for Mosaic-based visualizations
 * 
 * Transforms are divided into two stages:
 * - SQL: Modify the Query AST (WHERE, HAVING, LIMIT, ORDER BY)
 * - JS: Process Arrow table results (topN, stack, dodge, normalize)
 * 
 * SQL transforms must maintain flat queries (no CTEs) to preserve
 * Mosaic's PreAggregator optimization.
 */

import { and, or } from '@uwdata/mosaic-sql';
import * as d3 from 'd3-array';

// =============================================================================
// SQL TRANSFORMS (Query Modifiers)
// =============================================================================

/**
 * Add WHERE clause filter to query
 * @param {Expression} condition - Mosaic SQL expression
 * @example filter(gt('revenue', 0))
 */
export function filter(condition) {
  return {
    stage: 'sql',
    type: 'filter',
    apply(query) {
      return query.where(condition);
    },
    describe() {
      return `Filter: ${condition.toString()}`;
    }
  };
}

/**
 * Add HAVING clause (post-aggregation filter)
 * @param {Expression} condition - Mosaic SQL expression
 * @example having(gt(sum('revenue'), 10000))
 */
export function having(condition) {
  return {
    stage: 'sql',
    type: 'having',
    apply(query) {
      return query.having(condition);
    },
    describe() {
      return `Having: ${condition.toString()}`;
    }
  };
}

/**
 * Limit number of rows returned
 * @param {number} n - Maximum rows
 * @example limit(100)
 */
export function limit(n) {
  return {
    stage: 'sql',
    type: 'limit',
    apply(query) {
      return query.limit(n);
    },
    describe() {
      return `Limit: ${n}`;
    }
  };
}

/**
 * Order results by expression(s)
 * @param {...Expression} expressions - Mosaic SQL expressions
 * @example orderby(desc('revenue'))
 */
export function orderby(...expressions) {
  return {
    stage: 'sql',
    type: 'orderby',
    apply(query) {
      return query.orderby(...expressions);
    },
    describe() {
      return `Order by: ${expressions.map(e => e.toString()).join(', ')}`;
    }
  };
}

// =============================================================================
// JS TRANSFORMS (Data Processors)
// =============================================================================

/**
 * Take top N items by a field, optionally grouping rest as "Other"
 * @param {number} n - Number of top items to keep
 * @param {object} options - Configuration
 * @param {string} options.by - Field to sort by (defaults to y)
 * @param {boolean} options.includeOthers - Group remaining as "Other"
 * @example topN(10, { by: 'revenue', includeOthers: true })
 */
export function topN(n, options = {}) {
  return {
    stage: 'js',
    type: 'topN',
    apply(data, config) {
      if (!data || data.length === 0) return data;
      
      const by = options.by || config.y;
      
      // Sort descending
      const sorted = [...data].sort((a, b) => (b[by] || 0) - (a[by] || 0));
      
      if (sorted.length <= n) {
        return sorted;
      }
      
      const top = sorted.slice(0, n);
      
      if (options.includeOthers) {
        const others = sorted.slice(n);
        const otherRow = { [config.x]: 'Other' };
        
        // Sum all numeric fields
        for (const key of Object.keys(others[0])) {
          if (typeof others[0][key] === 'number') {
            otherRow[key] = others.reduce((sum, d) => sum + (d[key] || 0), 0);
          }
        }
        
        return [...top, otherRow];
      }
      
      return top;
    },
    describe() {
      return `Top ${n}${options.includeOthers ? ' (with Others)' : ''}`;
    }
  };
}

// src/lib/transforms/index.js

export function stack(options = {}) {
  const { direction = 'vertical' } = options; // 'vertical' or 'horizontal'
  
  return {
    stage: 'js',
    type: 'stack',
    apply(data, config) {
      if (!data || data.length === 0) return data;
      
      // Determine grouping and value fields based on direction
      const groupField = direction === 'vertical' ? config.x : config.y;
      const valueField = direction === 'vertical' ? config.y : config.x;
      
      // Group by category
      const groups = d3.group(data, d => d[groupField]);
      
      const stacked = [];
      for (const [category, items] of groups) {
        let offset = 0;
        for (const item of items) {
          const value = item[valueField] || 0;
          
          if (direction === 'vertical') {
            stacked.push({
              ...item,
              y0: offset,
              y1: offset + value
            });
          } else {
            stacked.push({
              ...item,
              x0: offset,
              x1: offset + value
            });
          }
          
          offset += value;
        }
      }
      
      return stacked;
    },
    channels: direction === 'vertical' ? ['y0', 'y1'] : ['x0', 'x1']
  };
}

/**
 * Normalize values to percentages within each x group
 * @param {object} options - Configuration
 * @example normalize()
 */
export function normalize(options = {}) {
  return {
    stage: 'js',
    type: 'normalize',
    apply(data, config) {
      if (!data || data.length === 0) return data;
      
      const xField = config.x;
      const yField = config.y;
      
      // Group by x dimension
      const groups = d3.group(data, d => d[xField]);
      
      const normalized = [];
      for (const [x, items] of groups) {
        const total = d3.sum(items, d => d[yField] || 0);
        
        for (const item of items) {
          const value = item[yField] || 0;
          normalized.push({
            ...item,
            [yField]: total > 0 ? (value / total) * 100 : 0,
            // Also normalize y0/y1 if they exist (from stacking)
            ...(item.y0 !== undefined && { y0: total > 0 ? (item.y0 / total) * 100 : 0 }),
            ...(item.y1 !== undefined && { y1: total > 0 ? (item.y1 / total) * 100 : 0 })
          });
        }
      }
      
      return normalized;
    },
    describe() {
      return 'Normalize to percentages';
    }
  };
}

/**
 * Dodge (offset) items horizontally for grouped bar charts
 * @param {object} options - Configuration
 * @param {number} options.bandwidth - Override bandwidth calculation
 * @example dodge()
 */
export function dodge(options = {}) {
  return {
    stage: 'js',
    type: 'dodge',
    apply(data, config, scales) {
      if (!data || data.length === 0) return data;
      
      const xField = config.x;
      
      // Get bandwidth from scale or options
      const bandwidth = scales?.x?.bandwidth?.() || options.bandwidth || 20;
      
      // Group by x dimension
      const groups = d3.group(data, d => d[xField]);
      
      const dodged = [];
      for (const [x, items] of groups) {
        const offset = bandwidth / items.length;
        
        items.forEach((item, i) => {
          dodged.push({
            ...item,
            x0: item[xField] + (i * offset),
            x1: item[xField] + ((i + 1) * offset)
          });
        });
      }
      
      return dodged;
    },
    channels: ['x0', 'x1'],
    describe() {
      return 'Dodge by group';
    }
  };
}

export { TransformCompiler } from './TransformCompiler'