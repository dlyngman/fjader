// src/lib/scales/ScalePriorities.js

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
    const markTypes = topRequirements.map(req => req.markType).join(', ');
    const conflictTypes = uniqueTypes.join(' vs ');
    
    throw new Error(
      `Scale type conflict: marks [${markTypes}] require incompatible scale types [${conflictTypes}]. ` +
      `Consider using separate ChartContainers or different mark types.`
    );
  }
  
  return uniqueTypes[0];
}