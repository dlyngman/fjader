// src/lib/scales/ScalePriorities.js

import { SCALE_CONFIG_SCHEMAS, validateConfigValue } from './ScaleConfigurationSchemas.js';

/**
 * Scale type priority levels for resolving conflicts between marks
 */
export const SCALE_PRIORITIES = {
  MANDATE: 3,    // Mark absolutely requires this type (e.g., barY needs band)
  PREFER: 2,     // Mark works best with this type (e.g., dot prefers linear)
  ACCEPT: 1,     // Mark can work with this type (fallback compatibility)
  DEFAULT: 0     // System fallback when no specific requirements
};

/**
 * Resolve scale type conflicts using priority system
 * @param {Array} requirements - Array of {type, priority, markType} objects
 * @returns {string} - Resolved scale type
 */
export function resolveScaleType(requirements) {
  if (!requirements || requirements.length === 0) {
    return 'linear'; // Default fallback
  }
  
  // Group by priority level (highest first)
  const byPriority = requirements.reduce((acc, req) => {
    const priority = req.priority || SCALE_PRIORITIES.DEFAULT;
    if (!acc[priority]) acc[priority] = [];
    acc[priority].push(req);
    return acc;
  }, {});
  
  // Get highest priority level
  const priorities = Object.keys(byPriority)
    .map(p => parseInt(p))
    .sort((a, b) => b - a); // Descending
    
  const highestPriority = priorities[0];
  const topRequirements = byPriority[highestPriority];
  
  // Check for conflicts at highest priority level
  const uniqueTypes = [...new Set(topRequirements.map(req => req.type))];
  
  if (uniqueTypes.length > 1) {
    const markTypes = topRequirements.map(req => req.markId).join(', ');
    const conflictTypes = uniqueTypes.join(' vs ');
    
    throw new Error(
      `Scale type conflict: marks [${markTypes}] require incompatible scale types [${conflictTypes}]. ` +
      `Consider using separate ChartContainers or different mark types.`
    );
  }
  
  return uniqueTypes[0];
}

/**
 * Resolve complete scale configuration (type + config) using priority system
 * @param {Array} requirements - Array of {type, priority, markId, config} objects
 * @returns {Object} - {type: string, config: Object}
 */
export function resolveScaleConfiguration(requirements) {
  if (!requirements || requirements.length === 0) {
    return { type: 'linear', config: {}, columnName: null };
  }

  // First resolve type using existing logic
  const resolvedType = resolveScaleType(requirements);

  // Then resolve configuration for that type
  const typeRequirements = requirements.filter(req => req.type === resolvedType);
  const resolvedConfig = resolveConfigurationForType(typeRequirements, resolvedType);

  // Extract columnName from highest-priority requirement
  // Sort by priority descending, take first columnName found
  const sorted = [...typeRequirements].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const columnName = sorted.find(req => req.columnName)?.columnName || null;

  console.log(`🎯 Resolved scale configuration:`, {
    type: resolvedType,
    config: resolvedConfig,
    columnName,
    fromRequirements: typeRequirements.length
  });

  return { type: resolvedType, config: resolvedConfig, columnName };
}

/**
 * Generic configuration resolver using schema-driven approach
 * @param {Array} requirements - Requirements for a specific scale type
 * @param {string} scaleType - Scale type to resolve configuration for
 * @returns {Object} - Resolved configuration object
 */
function resolveConfigurationForType(requirements, scaleType) {
  const schema = SCALE_CONFIG_SCHEMAS[scaleType];
  if (!schema) {
    console.warn(`⚠️ No configuration schema found for scale type: ${scaleType}`);
    return {};
  }
  
  const configs = requirements.map(req => req.config || {});
  const resolvedConfig = {};
  
  // Process each property defined in schema
  for (const [propName, propSchema] of Object.entries(schema)) {
    const values = configs
      .map(config => config[propName])
      .filter(val => val != null);
      
    if (values.length === 0) continue;
    
    // Validate all values
    const validValues = [];
    for (const value of values) {
      if (validateConfigValue(value, propSchema)) {
        validValues.push(value);
      } else {
        console.warn(`❌ Invalid ${propName} value for ${scaleType} scale:`, {
          value,
          expected: propSchema.type,
          range: propSchema.range,
          description: propSchema.description
        });
      }
    }
    
    if (validValues.length === 0) continue;
    
    // Apply resolution strategy
    try {
      resolvedConfig[propName] = propSchema.strategy(validValues);
      console.log(`🔧 Resolved ${scaleType}.${propName}: ${resolvedConfig[propName]}`, {
        strategy: propSchema.strategy.name || 'custom',
        fromValues: validValues,
        description: propSchema.description
      });
    } catch (error) {
      console.error(`❌ Failed to resolve ${scaleType}.${propName}:`, error.message);
      throw new Error(`Configuration resolution failed for ${scaleType}.${propName}: ${error.message}`);
    }
  }
  
  return resolvedConfig;
}