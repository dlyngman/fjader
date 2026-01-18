// src/lib/gpu/ScaleTemplateSystem.js

/**
 * Template-based shader generation for scale combinations
 * Supports linear, band, and color scales
 */

import {
	COLOR_SCALE_STRUCTS,
	COLOR_SCALE_BINDINGS,
	COLOR_SCALE_FUNCTIONS
} from './ColorScaleShaderLib.js';

/**
 * Scale fragment definitions
 * Each scale type provides: declaration, function call, and implementation
 */
const SCALE_FRAGMENTS = {
	linear: {
		declaration: () => {
			return `
        struct ScaleParam {
          p1: f32, // domainMin
          p2: f32, // domainMax
          p3: f32, // domainScale
          p4: f32, // padding
        };
      `;
		},

		functionCall: (value, suffix) => `scaleLinear${suffix}(${value})`,

		implementation: (suffix, axis) => `
      fn scaleLinear${suffix}(value: f32, scaleIndex: u32) -> f32 {
        let scale = scaleParams[scaleIndex];
        
        // ★ Use generic field names
        let domainMin = scale.p1;
        let domainScale = scale.p3;
        
        let normalized = (value - domainMin) * domainScale;
        
        let rangeMin = frameUniforms.rangeMin.${axis};
        let rangeMax = frameUniforms.rangeMax.${axis};
        let rangeSize = rangeMax - rangeMin;

				${
					axis === 'y'
						? `// Y axis: values increase upward (domain max at top)
						// normalized=0 (domain min) → rangeMax (bottom of screen)
						// normalized=1 (domain max) → rangeMin (top of screen)
						return rangeMax - normalized * rangeSize;`
						: `// X axis: values increase rightward (normal screen direction)
						// normalized=0 (domain min) → rangeMin (left)
						// normalized=1 (domain max) → rangeMax (right)
						return rangeMin + normalized * rangeSize;`
				}
      }
    `,

		bufferLayout: {
			size: 4 * 4, // 4 f32 values = 16 bytes
			fields: ['domainMin', 'domainMax', 'domainScale', '_pad']
		}
	},

	band: {
		declaration: () => {
			return `
        struct ScaleParam {
          p1: f32, // categoryCount
          p2: f32, // paddingInner
          p3: f32, // paddingOuter
          p4: f32, // padding
        };
      `;
		},

		functionCall: (value, suffix) => `scaleBand${suffix}(${value})`,

		implementation: (suffix, axis) => `
			fn scaleBand${suffix}(value: f32, scaleIndex: u32) -> f32 {
				let scale = scaleParams[scaleIndex];
				
				let categoryIndex = u32(value);
				let categoryCount = scale.p1;
				let paddingInner = scale.p2;
				let paddingOuter = scale.p3;
				
				let rangeMin = frameUniforms.rangeMin.${axis};
				let rangeMax = frameUniforms.rangeMax.${axis};
				
				// Compute band layout - ranges are always normalized (min < max)
				let bandLayout = computeBandLayout(
					categoryIndex,
					categoryCount,
					paddingInner,
					paddingOuter,
					rangeMin,
					rangeMax
				);
				
				// Return center of band
				// Categories flow in natural screen direction:
				// X: left to right, Y: top to bottom
				return rangeMin + bandLayout.x + bandLayout.y * 0.5;
			}
  	`,

		bufferLayout: {
			size: 4 * 4, // 4 f32 values = 16 bytes
			fields: ['categoryCount', 'paddingInner', 'paddingOuter', '_pad']
		}
	}
};

/**
 * Semantic logic generators for mark rendering.
 * Maps [concept][scaleType] → { inputs, generate }
 *
 * Concepts:
 * - position: Single point coordinate (dots, text, rule endpoints)
 * - extent: Start and end coordinates (bars, rects, areas)
 *
 * Output variable naming contract:
 * - position: scaledX or scaledY
 * - extent: scaledX0, scaledX1 or scaledY0, scaledY1
 */
const SEMANTIC_LOGIC_MAP = {
	position: {
		linear: {
			inputs: 1,
			generate: (axis, channel) =>
				`let scaled${axis.toUpperCase()} = scale${axis.toUpperCase()}(${channel});`
		},
		band: {
			inputs: 1,
			generate: (axis, channel) =>
				`let scaled${axis.toUpperCase()} = scale${axis.toUpperCase()}(${channel});`
		},
		point: {
			inputs: 1,
			generate: (axis, channel) =>
				`let scaled${axis.toUpperCase()}= scale${axis.toUpperCase()}(${channel});`
		},
		time: {
			inputs: 1,
			generate: (axis, channel) =>
				`let scaled${axis.toUpperCase()} = scale${axis.toUpperCase()}(${channel});`
		},
		log: {
			inputs: 1,
			generate: (axis, channel) =>
				`let scaled${axis.toUpperCase()} = scale${axis.toUpperCase()}(${channel});`
		}
	},

	extent: {
		linear: {
			inputs: 2,
			generate: (axis, channel0, channel1) => `
      let scaled${axis.toUpperCase()}0 = scale${axis.toUpperCase()}(${channel0});
      let scaled${axis.toUpperCase()}1 = scale${axis.toUpperCase()}(${channel1});`
		},
		band: {
			inputs: 1,
			generate: (axis, channel) => `
      let bandCenter${axis.toUpperCase()} = scale${axis.toUpperCase()}(${channel});
      let bandWidth${axis.toUpperCase()} = getBandwidth${axis.toUpperCase()}();
      let scaled${axis.toUpperCase()}0 = bandCenter${axis.toUpperCase()} - bandWidth${axis.toUpperCase()} * 0.5;
      let scaled${axis.toUpperCase()}1 = bandCenter${axis.toUpperCase()} + bandWidth${axis.toUpperCase()} * 0.5;`
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
	 * @param {Object} scaleTypes - { x: 'linear', y: 'linear' } or { x: 'linear', y: 'band' }
	 * @param {string} markShaderCode - Mark-specific shader code (dots, rects, etc.)
	 * @param {Object} [rendererDefinition] - Optional declarative renderer definition
	 * @returns {Object} { shaderCode: string, bufferLayouts: Object }
	 */
	generateShader(scaleTypes, markShaderCode, rendererDefinition) {
		if (!rendererDefinition) {
			throw new Error(
				'generateShader requires a rendererDefinition. ' +
					"Define the renderer's semantic concepts (position/extent) and placeholders."
			);
		}

		const defKey = `-${rendererDefinition.x?.concept || 'none'}-${rendererDefinition.y?.concept || 'none'}`;
		const cacheKey = `${scaleTypes.x}-${scaleTypes.y}${defKey}`;

		// Return cached version if available
		if (this.shaderCache.has(cacheKey)) {
			return this.shaderCache.get(cacheKey);
		}

		// Generate new shader
		const result = this._buildShader(scaleTypes, markShaderCode, rendererDefinition);

		// Cache and return
		this.shaderCache.set(cacheKey, result);
		return result;
	}

	_buildShader(scaleTypes, markShaderCode, rendererDefinition) {
		// Validate scale types exist
		this._validateScaleTypes(scaleTypes);

		// Get scale fragments
		const xFragment = SCALE_FRAGMENTS[scaleTypes.x];
		const yFragment = SCALE_FRAGMENTS[scaleTypes.y];

		// Build shader sections
		const declarations = this._buildDeclarations(xFragment, yFragment);
		const bandHelpers = this._buildBandHelpers(scaleTypes);
		const implementations = this._buildImplementations(scaleTypes, xFragment, yFragment);
		const scaleFunctions = this._buildScaleFunctions(scaleTypes, xFragment, yFragment);

		// Process mark shader using declarative renderer definition
		const processedMarkShader = this._processMarkShader(
			markShaderCode,
			scaleTypes,
			rendererDefinition
		);

		// Generate complete shader
		// WGSL ordering: structs → bindings → functions → entry points
		const shaderCode = `
      // Generated shader for scales: ${scaleTypes.x}-x, ${scaleTypes.y}-y
      // Auto-generated - do not edit directly
      
      // ===== 1. STRUCT DEFINITIONS =====
      ${declarations}
      
      // Color scale structs
      ${COLOR_SCALE_STRUCTS}
      
      // ===== 2. UNIFORM & STORAGE BINDINGS =====
      
      // Per-frame uniforms (@group(0))
      // struct FrameUniforms {
      //   resolution: vec2<f32>,        // Canvas dimensions (physical pixels)
      //   rangeMin: vec2<f32>,          // Chart range minimums  
      //   rangeMax: vec2<f32>,          // Chart range maximums
      //   devicePixelRatio: f32,        // Device pixel ratio
      //   _pad0: f32,                   // Alignment padding
      //   xScaleIndex: u32,             // Index into scale SSBO
      //   yScaleIndex: u32,             // Index into scale SSBO
      //   _pad1: vec2<u32>,             // Pad struct size to 48 bytes
      // };
      // @group(0) @binding(0) var<uniform> frameUniforms: FrameUniforms;

			// Per-frame uniforms (@group(0))
			struct FrameUniforms {
				resolution: vec2<f32>,        // bytes 0-8
				rangeMin: vec2<f32>,          // bytes 8-16
				rangeMax: vec2<f32>,          // bytes 16-24
				devicePixelRatio: f32,        // bytes 24-28
				_pad0: f32,                   // bytes 28-32
				xScaleIndex: u32,             // bytes 32-36
				yScaleIndex: u32,             // bytes 36-40
				_pad1: vec2<u32>,             // bytes 40-48
				nullColor: vec4<f32>,         // bytes 48-64
			};
			@group(0) @binding(0) var<uniform> frameUniforms: FrameUniforms;
      
      // Color scale bindings (@group(2) bindings 1-3)
      ${COLOR_SCALE_BINDINGS}
      
      // ===== 3. HELPER FUNCTIONS =====
      
      ${bandHelpers}
      ${implementations}
      ${scaleFunctions}
      
      // Color scale helper functions
      ${COLOR_SCALE_FUNCTIONS}
      
      // ===== 4. MARK-SPECIFIC CODE =====
      ${processedMarkShader}
    `;

		// Build buffer layout information
		const bufferLayouts = this._buildBufferLayouts(scaleTypes, xFragment, yFragment);

		return {
			shaderCode: shaderCode.trim(),
			bufferLayouts,
			cacheKey: `${scaleTypes.x}-${scaleTypes.y}-${rendererDefinition.x?.concept || 'none'}-${rendererDefinition.y?.concept || 'none'}`
		};
	}

	/**
	 * Build declarations section for scale uniforms
	 * @private
	 */
	_buildDeclarations(xFragment, yFragment) {
		// We can just use the one from xFragment since they are identical.
		const structDef = xFragment.declaration();

		// Global SSBO declaration
		const globalSSBODeclaration = `
      // Global scale storage buffer
      @group(2) @binding(0) var<storage, read> scaleParams: array<ScaleParam>;
    `;

		return `${structDef}\n${globalSSBODeclaration}`;
	}

	/**
	 * Build band scale helper functions (only if needed)
	 * @private
	 */
	_buildBandHelpers(scaleTypes) {
		const needsBandHelpers = scaleTypes.x === 'band' || scaleTypes.y === 'band';

		if (!needsBandHelpers) {
			return '';
		}

		return `
    // ===== BAND SCALE HELPERS =====
    
    fn computeBandLayout(
      categoryIndex: u32,
      categoryCount: f32,
      paddingInner: f32,
      paddingOuter: f32,
      rangeMin: f32,
      rangeMax: f32
    ) -> vec2<f32> {
      // Returns (offset from rangeMin, bandwidth)
      // Ranges are always normalized: rangeMin < rangeMax
      let rangeSize = rangeMax - rangeMin;
      let n = categoryCount;

      let step = rangeSize / max(1.0, n - paddingInner + paddingOuter * 2.0);
      let bandwidth = step * (1.0 - paddingInner);
      let offset = paddingOuter * step + f32(categoryIndex) * step;

      return vec2<f32>(offset, bandwidth);
    }
    
    fn getBandwidthX() -> f32 {
      let scale = scaleParams[frameUniforms.xScaleIndex];
      let rangeMin = frameUniforms.rangeMin.x;
      let rangeMax = frameUniforms.rangeMax.x;
      let rangeSize = rangeMax - rangeMin;  // Simple: always positive now
      
      let n = scale.p1;
      let paddingInner = scale.p2;
      let paddingOuter = scale.p3;
      
      let step = rangeSize / max(1.0, n - paddingInner + paddingOuter * 2.0);
      return step * (1.0 - paddingInner);
    }
    
    fn getBandwidthY() -> f32 {
      let scale = scaleParams[frameUniforms.yScaleIndex];
      let rangeMin = frameUniforms.rangeMin.y;
      let rangeMax = frameUniforms.rangeMax.y;
      let rangeSize = rangeMax - rangeMin;  // Simple: always positive now
      
      let n = scale.p1;
      let paddingInner = scale.p2;
      let paddingOuter = scale.p3;
      
      let step = rangeSize / max(1.0, n - paddingInner + paddingOuter * 2.0);
      return step * (1.0 - paddingInner);
    }
  `;
	}

	/**
	 * Process mark shader using declarative renderer definition.
	 * This is the new composable system that replaces scale-specific logic generation.
	 *
	 * @param {string} markShaderCode - Shader template with placeholders
	 * @param {object} scaleTypes - { x: 'linear'|'band'|etc, y: 'linear'|'band'|etc }
	 * @param {object} rendererDefinition - Declarative definition from renderer
	 * @param {object} rendererDefinition.x - X axis config { concept, channels }
	 * @param {object} rendererDefinition.y - Y axis config { concept, channels }
	 * @param {object} rendererDefinition.placeholders - { x: '{{X_...}}', y: '{{Y_...}}' }
	 * @returns {string} Processed shader code with placeholders replaced
	 * @private
	 */
	_processMarkShader(markShaderCode, scaleTypes, rendererDefinition) {
		let processedCode = markShaderCode;

		for (const axis of ['x', 'y']) {
			const axisDef = rendererDefinition[axis];
			if (!axisDef) continue;

			const concept = axisDef.concept;
			const scaleType = scaleTypes[axis];
			const availableChannels = axisDef.channels;
			const placeholder = rendererDefinition.placeholders?.[axis];

			if (!placeholder) {
				console.warn(`No placeholder defined for axis '${axis}' in renderer definition`);
				continue;
			}

			// Look up the generator from the semantic logic map
			const logicDef = SEMANTIC_LOGIC_MAP[concept]?.[scaleType];

			if (!logicDef) {
				console.warn(
					`No logic generator found for concept: '${concept}', scale: '${scaleType}'. ` +
						`Available concepts: ${Object.keys(SEMANTIC_LOGIC_MAP).join(', ')}`
				);
				continue;
			}

			// Select channels based on what the generator needs
			const channelsToUse = availableChannels.slice(0, logicDef.inputs);

			if (channelsToUse.length < logicDef.inputs) {
				console.error(
					`Insufficient channels for ${axis} axis: need ${logicDef.inputs}, ` +
						`got ${channelsToUse.length} (${availableChannels.join(', ')})`
				);
				continue;
			}

			// Generate the WGSL snippet
			const snippet = logicDef.generate(axis, ...channelsToUse);

			// Replace placeholder in shader code
			processedCode = processedCode.replace(placeholder, snippet);
		}

		return processedCode;
	}

	/**
	 * Build scale function implementations
	 * Only generates the implementations needed for this scale combination
	 * @private
	 */
	_buildImplementations(scaleTypes, xFragment, yFragment) {
		const implementations = [];

		// Generate X axis implementation
		const xImpl = SCALE_FRAGMENTS[scaleTypes.x].implementation('X', 'x');
		implementations.push(xImpl);

		// Generate Y axis implementation (only if different from X)
		// This prevents duplicate function definitions
		if (scaleTypes.y !== scaleTypes.x) {
			const yImpl = SCALE_FRAGMENTS[scaleTypes.y].implementation('Y', 'y');
			implementations.push(yImpl);
		} else {
			// Same scale type for both axes, but need Y version
			const yImpl = SCALE_FRAGMENTS[scaleTypes.y].implementation('Y', 'y');
			implementations.push(yImpl);
		}

		return implementations.join('\n');
	}

	/**
	 * Build convenience scale functions (scaleX, scaleY)
	 * Directly calls the correct scale type function - no runtime branching!
	 * @private
	 */
	_buildScaleFunctions(scaleTypes, xFragment, yFragment) {
		// At compile time, we know which scale type to use
		// So we directly call the right function
		const xFunctionName = scaleTypes.x === 'band' ? 'scaleBandX' : 'scaleLinearX';
		const yFunctionName = scaleTypes.y === 'band' ? 'scaleBandY' : 'scaleLinearY';

		return `
      // Convenience functions - specialized at compile time
      fn scaleX(value: f32) -> f32 {
        return ${xFunctionName}(value, frameUniforms.xScaleIndex);
      }
      
      fn scaleY(value: f32) -> f32 {
        return ${yFunctionName}(value, frameUniforms.yScaleIndex);
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
			throw new Error(
				`Unsupported X scale type: ${scaleTypes.x}. Supported: ${supportedTypes.join(', ')}`
			);
		}

		if (!supportedTypes.includes(scaleTypes.y)) {
			throw new Error(
				`Unsupported Y scale type: ${scaleTypes.y}. Supported: ${supportedTypes.join(', ')}`
			);
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