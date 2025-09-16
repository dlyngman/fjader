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
    // UPDATED: Generate SSBO declaration instead of individual uniforms
    declaration: (groupIndex, bindingIndex, suffix) => {
      // For SSBO approach, we only need the struct definition
      // The actual storage buffer is declared once globally
      return `
        struct ScaleParam {
          domainMin: f32,
          domainMax: f32,
          domainScale: f32,
          _pad: f32,
        };
      `;
    },

    // UPDATED: Use array indexing into global SSBO
    functionCall: (value, suffix) => `scaleLinear${suffix}(${value})`,

    // UPDATED: Read from global storage array using indices
    implementation: (suffix, axis) => `
      fn scaleLinear${suffix}(value: f32, scaleIndex: u32) -> f32 {
        let scale = scaleParams[scaleIndex];
        let normalized = (value - scale.domainMin) * scale.domainScale;
        
        let rangeMin = frameUniforms.rangeMin.${axis};
        let rangeMax = frameUniforms.rangeMax.${axis};
        
        return rangeMin + normalized * (rangeMax - rangeMin);
      }
    `,

    bufferLayout: {
      size: 4 * 4, // Now 4 f32 values = 16 bytes (added padding)
      fields: ['domainMin', 'domainMax', 'domainScale', '_pad']
    }
  }
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
		const declarations = this._buildDeclarations(xFragment, yFragment);
		const implementations = this._buildImplementations(xFragment, yFragment);
		const scaleFunctions = this._buildScaleFunctions(xFragment, yFragment);

		// Generate complete shader
		const shaderCode = `
      // Generated shader for scales: ${scaleTypes.x}-x, ${scaleTypes.y}-y
      // Auto-generated - do not edit directly
      
      ${declarations}
      
      // Per-frame uniforms (@group(0)) - consolidated into single buffer
      struct FrameUniforms {
        resolution: vec2<f32>,        // Canvas dimensions (physical pixels)
        rangeMin: vec2<f32>,          // Chart range minimums  
        rangeMax: vec2<f32>,          // Chart range maximums
        devicePixelRatio: f32,        // Device pixel ratio
        _pad0: f32,                   // Alignment padding
        xScaleIndex: u32,             // Shared by the chart
        yScaleIndex: u32,             // Shared by the chart
        _pad1: vec2<u32>,             // Pad struct size to 48 bytes
      };
      @group(0) @binding(0) var<uniform> frameUniforms: FrameUniforms;
      
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
	 * Build declarations section for scale uniforms
	 * @private
	 */
  _buildDeclarations(xFragment, yFragment) {
    // Generate struct definitions
    const structDef = xFragment.declaration(2, 0, 'X');
    
    // Global SSBO declaration - don't declare layerParams here
    const globalSSBODeclaration = `
      // Global scale storage buffer
      @group(2) @binding(0) var<storage, read> scaleParams: array<ScaleParam>;
    `;
    
    return `${structDef}\n${globalSSBODeclaration}`;
  }

	/**
	 * Build scale function implementations
	 * @private
	 */
	_buildImplementations(xFragment, yFragment) {
		// MODIFIED: Generate implementations with unique names to prevent redefinition errors
		const xImplementation = xFragment.implementation('X', 'x');
		const yImplementation = yFragment.implementation('Y', 'y');

		// Even if the types are the same (e.g., linear-linear), we need both function
		// implementations because they operate on different struct types (LinearScaleParamsX vs LinearScaleParamsY).
		return `${xImplementation}\n${yImplementation}`;
	}

	/**
	 * Build convenience scale functions (scaleX, scaleY)
	 * @private
	 */
  _buildScaleFunctions(xFragment, yFragment) {
    return `
      // Convenience functions - indices will be passed from mark-specific code
      fn scaleX(value: f32) -> f32 {
        return scaleLinear${xFragment.suffix || 'X'}(value, frameUniforms.xScaleIndex);
      }
      
      fn scaleY(value: f32) -> f32 {
        return scaleLinear${yFragment.suffix || 'Y'}(value, frameUniforms.yScaleIndex);
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