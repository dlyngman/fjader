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
		// MODIFIED: Accepts groupIndex and a suffix for unique variable/struct names
		declaration: (groupIndex, bindingIndex, suffix) => `
      struct LinearScaleParams${suffix} {
        domainMin: f32,
        domainMax: f32,
        domainScale: f32,  // Precomputed 1.0 / (domainMax - domainMin)
      };
      @group(${groupIndex}) @binding(${bindingIndex}) var<uniform> linearParams${suffix}: LinearScaleParams${suffix};
    `,

		// MODIFIED: Uses the suffix to call the correct uniform variable
		functionCall: (value, suffix) => `scaleLinear${suffix}(${value}, linearParams${suffix})`,

		// MODIFIED: Becomes a function to generate the implementation with the correct types
    implementation: (suffix, axis) => `
      fn scaleLinear${suffix}(value: f32, params: LinearScaleParams${suffix}) -> f32 {
        let normalized = (value - params.domainMin) * params.domainScale;
        
        // Use correct range values from frameUniforms instead of params
        let rangeMin = frameUniforms.rangeMin.${axis};
        let rangeMax = frameUniforms.rangeMax.${axis};
        
        return rangeMin + normalized * (rangeMax - rangeMin);
      }
    `,

		// Buffer layout information for GPUCoordinator (this remains unchanged)
		bufferLayout: {
			size: 3 * 4, // 3 f32 values = 12 bytes
			fields: ['domainMin', 'domainMax', 'domainScale']
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
        padding: f32,                 // Alignment padding
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
		// MODIFIED: X scale is now hardcoded to @group(2)
		const xDeclaration = xFragment.declaration(2, 0, 'X');

		// MODIFIED: Y scale is now hardcoded to @group(3) to match the pipeline layout
		const yDeclaration = yFragment.declaration(3, 0, 'Y');

		return `${xDeclaration}\n${yDeclaration}`;
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
		// MODIFIED: Call the uniquely named scale functions with their corresponding suffixes
		return `
      // Convenience functions for X and Y scaling
      fn scaleX(value: f32) -> f32 {
        return ${xFragment.functionCall('value', 'X')};
      }
      
      fn scaleY(value: f32) -> f32 {
        return ${yFragment.functionCall('value', 'Y')};
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