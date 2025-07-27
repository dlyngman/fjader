/**
 * Determine the data source type for processing strategy
 * @param {*} value - The value to classify
 * @returns {string} Type: 'constant', 'array', 'float32array', or 'sql'
 */
export function getSourceType(value) {
  if (typeof value === 'number') return 'constant';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Float32Array) return 'float32array';
  return 'sql';  // Everything else goes to database
}

/**
 * Data processors for converting various sources to GPU-ready Float32Arrays
 */
const processors = {
  constant: (value, instanceCount) => new Float32Array(instanceCount).fill(value),
  array: (value) => new Float32Array(value),
  float32array: (value) => value,  // Pass through - already optimized
  sql: (column) => {
    if (!column) return null;
    const rawArray = column.toArray();
    return rawArray instanceof Float32Array ? rawArray : new Float32Array(rawArray);
  }
};

/**
 * Process data from various sources into GPU-ready Float32Arrays
 * @param {*} value - The data source (number, array, Float32Array, or SQL expression)
 * @param {*} column - Arrow column (for SQL sources)
 * @param {number} instanceCount - Expected number of data points (for constants)
 * @returns {Float32Array|null} Processed data ready for GPU
 */
export function processData(value, column, instanceCount) {
  const type = getSourceType(value);
  if (!type) return null;
  
  if (type === 'constant') return processors.constant(value, instanceCount);
  if (type === 'sql') return processors.sql(column);
  return processors[type](value);
}

/**
 * Helper for building select object with only SQL expressions that need database queries
 * @param {Object} channels - Object with channel names and values
 * @returns {Object} Select object for DataClient
 */
export function buildSelectFromChannels(channels) {
  const select = {};
  
  for (const [key, value] of Object.entries(channels)) {
    if (value !== undefined && getSourceType(value) === 'sql') {
      select[key] = value;
    }
  }
  
  return select;
}