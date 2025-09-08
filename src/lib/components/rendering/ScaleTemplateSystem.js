// src/lib/rendering/ScaleTemplateSystem.js

/**
 * Template-based shader generation for scale combinations
 * Step 1: Foundation with linear scale only
 */

/**
 * Scale fragment definitions
 * Each scale type provides: declaration, function call, and implementation
 */
const SCALE_FRAGMENTS = {
  linear: {
    // Buffer declaration for this scale type
    declaration: (bindingIndex) => `
      struct LinearScaleParams {
        domainMin: f32,
        domainMax: f32,
        rangeMin: f32,
        rangeMax: f32,
        domainScale: f32,  // Precomputed 1.0 / (domainMax - domainMin)
      };
      @group(2) @binding(${bindingIndex}) var<uniform> linearParams: LinearScaleParams;
    `,
    
    // Function call template - how to invoke this scale
    functionCall: (value) => `scaleLinear(${value}, linearParams)`,
    
    // Function implementation
    implementation: `
      fn scaleLinear(value: f32, params: LinearScaleParams) -> f32 {
        let normalized = (value - params.domainMin) * params.domainScale;
        return params.rangeMin + normalized * (params.rangeMax - params.rangeMin);
      }
    `,
    
    // Buffer layout information for GPUCoordinator
    bufferLayout: {
      size: 5 * 4, // 5 f32 values = 20 bytes
      fields: ['domainMin', 'domainMax', 'rangeMin', 'rangeMax', 'domainScale']
    }
  }
  
  // Future scale types will be added here:
  // band: { ... },
  // log: { ... },
  // time: { ... }
};

/**
 * Main template system class
 */
export class ScaleTemplateSystem {
  constructor() {
    this.shaderCache = new Map(); // Cache generated shaders by combination key
    this.bufferLayoutCache = new Map(); // Cache buffer layouts by combination
  }
  
  /**
   * Generate shader code for a specific scale combination
   * @param {Object} scaleTypes - { x: 'linear', y: 'linear' }
   * @param {string} markShaderCode - Mark-specific shader code (dots, rects, etc.)
   * @returns {Object} { shaderCode: string, bufferLayouts: Object }
   */
  generateShader(scaleTypes, markShaderCode) {
    const cacheKey = `${scaleTypes.x}-${scaleTypes.y}`;
    
    // Return cached version if available
    if (this.shaderCache.has(cacheKey)) {
      return this.shaderCache.get(cacheKey);
    }
    
    // Generate new shader
    const result = this._buildShader(scaleTypes, markShaderCode);
    
    // Cache and return
    this.shaderCache.set(cacheKey, result);
    return result;
  }
  
  /**
   * Build shader from scale combination
   * @private
   */
  _buildShader(scaleTypes, markShaderCode) {
    // Validate scale types exist
    this._validateScaleTypes(scaleTypes);
    
    // Get scale fragments
    const xFragment = SCALE_FRAGMENTS[scaleTypes.x];
    const yFragment = SCALE_FRAGMENTS[scaleTypes.y];
    
    // Build shader sections
    const declarations = this._buildDeclarations(scaleTypes, xFragment, yFragment);
    const implementations = this._buildImplementations(xFragment, yFragment);
    const scaleFunctions = this._buildScaleFunctions();
    
    // Generate complete shader
    const shaderCode = `
      // Generated shader for scales: ${scaleTypes.x}-x, ${scaleTypes.y}-y
      // Auto-generated - do not edit directly
      
      ${declarations}
      
      // Per-frame uniforms (@group(0))
      @group(0) @binding(0) var<uniform> resolution: vec2<f32>;
      @group(0) @binding(2) var<uniform> devicePixelRatio: f32;
      
      ${scaleFunctions}
      ${implementations}
      
      ${markShaderCode}
    `;
    
    // Build buffer layout information
    const bufferLayouts = this._buildBufferLayouts(scaleTypes, xFragment, yFragment);
    
    return {
      shaderCode: shaderCode.trim(),
      bufferLayouts,
      cacheKey: `${scaleTypes.x}-${scaleTypes.y}`
    };
  }
  
  /**
   * Build @group(2) declarations section
   * @private
   */
  _buildDeclarations(scaleTypes, xFragment, yFragment) {
    let bindingIndex = 0;
    let declarations = '';
    
    // X scale declaration
    declarations += xFragment.declaration(bindingIndex++);
    
    // Y scale declaration (only if different from X)
    if (scaleTypes.x !== scaleTypes.y) {
      declarations += yFragment.declaration(bindingIndex++);
    }
    
    return declarations;
  }
  
  /**
   * Build scale function implementations
   * @private
   */
  _buildImplementations(xFragment, yFragment) {
    let implementations = xFragment.implementation;
    
    // Only add Y implementation if it's different from X
    if (xFragment !== yFragment) {
      implementations += '\n' + yFragment.implementation;
    }
    
    return implementations;
  }
  
  /**
   * Build convenience scale functions (scaleX, scaleY)
   * @private
   */
  _buildScaleFunctions() {
    return `
      // Convenience functions for X and Y scaling
      fn scaleX(value: f32) -> f32 {
        return ${SCALE_FRAGMENTS.linear.functionCall('value')};
      }
      
      fn scaleY(value: f32) -> f32 {
        return ${SCALE_FRAGMENTS.linear.functionCall('value')};
      }
    `;
  }
  
  /**
   * Build buffer layout specifications for GPUCoordinator
   * @private
   */
  _buildBufferLayouts(scaleTypes, xFragment, yFragment) {
    const layouts = {
      x: {
        type: scaleTypes.x,
        ...xFragment.bufferLayout
      },
      y: {
        type: scaleTypes.y,
        ...yFragment.bufferLayout
      }
    };
    
    return layouts;
  }
  
  /**
   * Validate that scale types are supported
   * @private
   */
  _validateScaleTypes(scaleTypes) {
    const supportedTypes = Object.keys(SCALE_FRAGMENTS);
    
    if (!supportedTypes.includes(scaleTypes.x)) {
      throw new Error(`Unsupported X scale type: ${scaleTypes.x}. Supported: ${supportedTypes.join(', ')}`);
    }
    
    if (!supportedTypes.includes(scaleTypes.y)) {
      throw new Error(`Unsupported Y scale type: ${scaleTypes.y}. Supported: ${supportedTypes.join(', ')}`);
    }
  }
  
  /**
   * Get supported scale types
   */
  getSupportedScaleTypes() {
    return Object.keys(SCALE_FRAGMENTS);
  }
  
  /**
   * Clear shader cache (useful for development)
   */
  clearCache() {
    this.shaderCache.clear();
    this.bufferLayoutCache.clear();
  }
}

// Export singleton instance
export const scaleTemplateSystem = new ScaleTemplateSystem();