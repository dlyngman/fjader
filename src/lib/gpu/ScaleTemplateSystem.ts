// src/lib/gpu/ScaleTemplateSystem.ts

/**
 * Template-based shader generation for scale combinations
 * Supports linear, band, and color scales
 */

interface BufferLayout {
	size: number;
	fields: string[];
}

interface ScaleFragment {
	declaration: () => string;
	functionCall: (value: string, suffix: string) => string;
	implementation: (suffix: string, axis: string) => string;
	bufferLayout: BufferLayout;
}

export interface AxisDefinition {
	concept: string;
	channels: string[];
}

export interface RendererDefinition {
	x?: AxisDefinition;
	y?: AxisDefinition;
	placeholders?: { x?: string; y?: string };
}

interface SemanticLogicDef {
	inputs: number;
	generate: (axis: string, ...channels: string[]) => string;
}

interface ShaderResult {
	shaderCode: string;
	bufferLayouts: Record<string, BufferLayout & { type: string }>;
	cacheKey: string;
}

import {
	COLOR_SCALE_STRUCTS,
	COLOR_SCALE_BINDINGS,
	COLOR_SCALE_FUNCTIONS
} from './ColorScaleShaderLib';

import {
	SIZE_SCALE_STRUCTS,
	SIZE_SCALE_BINDINGS,
	SIZE_SCALE_FUNCTIONS
} from './SizeScaleShaderLib';

/**
 * Scale fragment definitions
 * Each scale type provides: declaration, function call, and implementation
 */
// Time scales use identical GPU math to linear (data is float offsets from t0)
const TIME_SCALE_ALIAS = 'linear';

const SCALE_FRAGMENTS: Record<string, ScaleFragment> = {
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

	log: {
		declaration: () => {
			return `
        struct ScaleParam {
          p1: f32, // logDomainMin (pre-computed)
          p2: f32, // logDomainMax (pre-computed)
          p3: f32, // logDomainScale = 1/(logMax - logMin)
          p4: f32, // unused
        };
      `;
		},

		functionCall: (value, suffix) => `scaleLog${suffix}(${value})`,

		implementation: (suffix, axis) => `
      fn scaleLog${suffix}(value: f32, scaleIndex: u32) -> f32 {
        let scale = scaleParams[scaleIndex];

        let logDomainMin = scale.p1;
        let logDomainScale = scale.p3;

        let logValue = log(max(value, 1e-38));
        let normalized = (logValue - logDomainMin) * logDomainScale;

        let rangeMin = frameUniforms.rangeMin.${axis};
        let rangeMax = frameUniforms.rangeMax.${axis};
        let rangeSize = rangeMax - rangeMin;

				${
					axis === 'y'
						? `return rangeMax - normalized * rangeSize;`
						: `return rangeMin + normalized * rangeSize;`
				}
      }
    `,

		bufferLayout: {
			size: 4 * 4,
			fields: ['logDomainMin', 'logDomainMax', 'logDomainScale', '_pad']
		}
	},

	symlog: {
		declaration: () => {
			return `
        struct ScaleParam {
          p1: f32, // symlogDomainMin (pre-computed)
          p2: f32, // symlogDomainMax (pre-computed)
          p3: f32, // symlogDomainScale = 1/(symlogMax - symlogMin)
          p4: f32, // constant C
        };
      `;
		},

		functionCall: (value, suffix) => `scaleSymlog${suffix}(${value})`,

		implementation: (suffix, axis) => `
      fn symlogTransform${suffix}(value: f32, constant: f32) -> f32 {
        return sign(value) * log(1.0 + abs(value / constant));
      }

      fn scaleSymlog${suffix}(value: f32, scaleIndex: u32) -> f32 {
        let scale = scaleParams[scaleIndex];

        let symlogMin = scale.p1;
        let symlogScale = scale.p3;
        let constant = scale.p4;

        let transformed = symlogTransform${suffix}(value, constant);
        let normalized = (transformed - symlogMin) * symlogScale;

        let rangeMin = frameUniforms.rangeMin.${axis};
        let rangeMax = frameUniforms.rangeMax.${axis};
        let rangeSize = rangeMax - rangeMin;

				${
					axis === 'y'
						? `return rangeMax - normalized * rangeSize;`
						: `return rangeMin + normalized * rangeSize;`
				}
      }
    `,

		bufferLayout: {
			size: 4 * 4,
			fields: ['symlogDomainMin', 'symlogDomainMax', 'symlogDomainScale', 'constant']
		}
	},

	band: {
		declaration: () => {
			return `
        struct ScaleParam {
          p1: f32, // categoryCount
          p2: f32, // paddingInner
          p3: f32, // paddingOuter
          p4: f32, // base offset of this scale's block in bandSlots
        };
      `;
		},

		functionCall: (value, suffix) => `scaleBand${suffix}(${value})`,

		implementation: (suffix, axis) => `
			fn scaleBand${suffix}(value: f32, scaleIndex: u32) -> f32 {
				let scale = scaleParams[scaleIndex];

				// -1 = no identity (unmapped category), matching
				// buildCaseExpression's ELSE -1 and the value < 0.0 check in
				// getColorFromScale. Must be rejected before the cast below:
				// u32() of a negative f32 is an indeterminate value in WGSL, so
				// an unmapped row would otherwise land at an arbitrary band.
				// Off-screen rather than a true discard — a per-instance discard
				// belongs in each mark's vertex shader, alongside FACET_DISCARD.
				if (value < 0.0) {
					return -1.0e6;
				}

				// The value is an identity id from the dim, not a position. Resolve
				// it to a display slot; -1 means this id is not currently shown —
				// filtered out by a category-reducing transform, or belonging to
				// another table on a shared scale. Both must be discarded, and
				// leaving it to the scissor rect is not safe: a slot of -1 sits one
				// step outside the range only until padding, alignment or an
				// animating categoryCount moves the band layout.
				let slot = bandSlot(u32(scale.p4), u32(value));
				if (slot < 0.0) {
					return -1.0e6;
				}

				let categoryCount = scale.p1;
				let paddingInner = scale.p2;
				let paddingOuter = scale.p3;
				
				let rangeMin = frameUniforms.rangeMin.${axis};
				let rangeMax = frameUniforms.rangeMax.${axis};
				
				// Compute band layout - ranges are always normalized (min < max)
				let bandLayout = computeBandLayout(
					slot,
					categoryCount,
					paddingInner,
					paddingOuter,
					rangeMin,
					rangeMax
				);
				
				// Return center of band
				// X: left to right (index 0 at left)
				// Y: bottom to top (index 0 at bottom, matching D3 convention)
				${axis === 'y' ? 'return rangeMax - bandLayout.x - bandLayout.y * 0.5;' : 'return rangeMin + bandLayout.x + bandLayout.y * 0.5;'}
			}
  	`,

		bufferLayout: {
			size: 4 * 4, // 4 f32 values = 16 bytes
			fields: ['categoryCount', 'paddingInner', 'paddingOuter', '_pad']
		}
	}
};

// Time scales reuse linear GPU math — offsets from t0 are plain floats
SCALE_FRAGMENTS.time = SCALE_FRAGMENTS[TIME_SCALE_ALIAS];

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
const SEMANTIC_LOGIC_MAP: Record<string, Record<string, SemanticLogicDef>> = {
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
		},
		symlog: {
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
		time: {
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
		},
		log: {
			inputs: 2,
			generate: (axis, channel0, channel1) => `
      let scaled${axis.toUpperCase()}0 = scale${axis.toUpperCase()}(${channel0});
      let scaled${axis.toUpperCase()}1 = scale${axis.toUpperCase()}(${channel1});`
		},
		symlog: {
			inputs: 2,
			generate: (axis, channel0, channel1) => `
      let scaled${axis.toUpperCase()}0 = scale${axis.toUpperCase()}(${channel0});
      let scaled${axis.toUpperCase()}1 = scale${axis.toUpperCase()}(${channel1});`
		}
	}
};

/** Map scale type → WGSL function base name */
const SCALE_FUNCTION_BASES: Record<string, string> = {
	linear: 'scaleLinear',
	time: 'scaleLinear',
	band: 'scaleBand',
	point: 'scaleBand',
	log: 'scaleLog',
	symlog: 'scaleSymlog'
};

function _scaleFunctionName(scaleType: string, axis: string): string {
	return `${SCALE_FUNCTION_BASES[scaleType] || 'scaleLinear'}${axis}`;
}

/**
 * Main template system class
 */
export class ScaleTemplateSystem {
	shaderCache = new Map<string, ShaderResult>();
	bufferLayoutCache = new Map<string, unknown>();

	constructor() {}

	/**
	 * Generate shader code for a specific scale combination
	 * @param {Object} scaleTypes - { x: 'linear', y: 'linear' } or { x: 'linear', y: 'band' }
	 * @param {string} markShaderCode - Mark-specific shader code (dots, rects, etc.)
	 * @param {Object} [rendererDefinition] - Optional declarative renderer definition
	 * @param {string} [markType] - Mark type identifier (dots, rects, rule, etc.)
	 * @returns {Object} { shaderCode: string, bufferLayouts: Object }
	 */
	generateShader(
		scaleTypes: { x: string; y: string },
		markShaderCode: string,
		rendererDefinition: RendererDefinition,
		markType: string = 'unknown'
	): ShaderResult {
		if (!rendererDefinition) {
			throw new Error(
				'generateShader requires a rendererDefinition. ' +
					"Define the renderer's semantic concepts (position/extent) and placeholders."
			);
		}

		const defKey = `-${rendererDefinition.x?.concept || 'none'}-${rendererDefinition.y?.concept || 'none'}`;
		const cacheKey = `${markType}-${scaleTypes.x}-${scaleTypes.y}${defKey}`;

		// Return cached version if available
		if (this.shaderCache.has(cacheKey)) {
			return this.shaderCache.get(cacheKey)!;
		}

		// Generate new shader
		const result = this._buildShader(scaleTypes, markShaderCode, rendererDefinition);

		// Cache and return
		this.shaderCache.set(cacheKey, result);
		return result;
	}

	_buildShader(
		scaleTypes: { x: string; y: string },
		markShaderCode: string,
		rendererDefinition: RendererDefinition
	): ShaderResult {
		// Validate scale types exist
		this._validateScaleTypes(scaleTypes);

		// Get scale fragments
		const xFragment = SCALE_FRAGMENTS[scaleTypes.x];
		const yFragment = SCALE_FRAGMENTS[scaleTypes.y];

		// Build shader sections
		const declarations = this._buildDeclarations(xFragment, yFragment);
		const bandHelpers = this._buildBandHelpers(scaleTypes);
		const implementations = this._buildImplementations(scaleTypes, xFragment, yFragment);
		const scaleFunctions = this._buildScaleFunctions(
			scaleTypes,
			xFragment,
			yFragment,
			rendererDefinition
		);

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

      // Size scale structs
      ${SIZE_SCALE_STRUCTS}

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
      //   activeFacetIdx: u32,           // Facet cell index for shader filtering
      //   _pad1: u32,                    // Pad struct size to 48 bytes
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
				activeFacetIdx: u32,          // bytes 40-44 (facet cell index for shader filtering)
				_pad1: u32,                   // bytes 44-48
				nullColor: vec4<f32>,         // bytes 48-64
			};
			@group(0) @binding(0) var<uniform> frameUniforms: FrameUniforms;
      
      // Color scale bindings (@group(2) bindings 1-3)
      ${COLOR_SCALE_BINDINGS}

      // Size scale bindings (@group(2) binding 4)
      ${SIZE_SCALE_BINDINGS}
      
      // ===== 3. HELPER FUNCTIONS =====
      
      ${this._buildSlotTableHelpers()}
      ${bandHelpers}
      ${implementations}
      ${scaleFunctions}
      ${this._buildProjectHelpers(rendererDefinition)}

      // Color scale helper functions
      ${COLOR_SCALE_FUNCTIONS}

      // Size scale helper functions
      ${SIZE_SCALE_FUNCTIONS}
      
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
	_buildDeclarations(xFragment: ScaleFragment, yFragment: ScaleFragment): string {
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
	/**
	 * The shared slot table, and the lookup into it.
	 *
	 * Emitted ALWAYS, not only for band axes. It started band-only because band
	 * axes were the only channel carrying identity ids; ordinal colour carries
	 * them too now, and resolves in the FRAGMENT stage, so the declaration has
	 * to be present even in a shader with no band scale at all.
	 *
	 * A uniform rather than storage, which is what makes the fragment stage
	 * affordable: the vertex stage is at the default maxStorageBuffersPerShaderStage
	 * of 8, while uniform buffers are nowhere near the default 12 in either stage.
	 *
	 * WGSL requires a 16-byte stride for uniform arrays, so f32s are packed into
	 * vec4s and indexed with a shift and a mask. 4096 vec4s is 64 KB — the
	 * default maxUniformBufferBindingSize — giving 16384 floats GLOBALLY across
	 * every scale that needs one, at the per-scale base that scale carries.
	 *
	 * Each scale's block is [count, slot0, slot1, ...]. The count is what makes
	 * the lookup safe: ids and the slot table can disagree for a moment while a
	 * dim appends, and without a per-scale bound an id past this scale's end
	 * reads the NEXT scale's slots — a plausible wrong answer rather than a
	 * visible failure. Index 0 is a permanent zero-length block, which is where
	 * a scale that did not fit in the buffer points.
	 */
	_buildSlotTableHelpers(): string {
		return `
    // ===== SHARED SLOT TABLE (identity id -> display slot) =====
    @group(2) @binding(5) var<uniform> bandSlots: array<vec4<f32>, 4096>;

    fn bandSlotAt(i: u32) -> f32 {
      return bandSlots[i >> 2u][i & 3u];
    }

    fn bandSlot(base: u32, id: u32) -> f32 {
      let count = u32(bandSlotAt(base));
      if (id >= count) {
        return -1.0;
      }
      return bandSlotAt(base + 1u + id);
    }
    `;
	}

	_buildBandHelpers(scaleTypes: { x: string; y: string }): string {
		const needsBandHelpers = scaleTypes.x === 'band' || scaleTypes.y === 'band';

		if (!needsBandHelpers) {
			return '';
		}

		return `
    // ===== BAND SCALE HELPERS =====

    // Takes the DISPLAY SLOT, not the identity id. Band step 3a split the two:
    // the id is stable and comes from the dim, the slot says where that id
    // currently sits and changes on every reorder. scaleBand resolves one to
    // the other through bandSlots before calling this.
    fn computeBandLayout(
      slot: f32,
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
      let offset = paddingOuter * step + slot * step;

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
	_processMarkShader(
		markShaderCode: string,
		scaleTypes: { x: string; y: string },
		rendererDefinition: RendererDefinition
	): string {
		let processedCode = markShaderCode;

		for (const axis of ['x', 'y']) {
			const axisDef = rendererDefinition[axis];
			if (!axisDef) continue;

			const concept = axisDef.concept;
			const scaleType = scaleTypes[axis];
			const availableChannels = axisDef.channels;
			const placeholder = rendererDefinition.placeholders?.[axis];

			if (!placeholder) {
				// No placeholder defined - this is valid for renderers that handle
				// scaling manually (e.g., Lines uses projectToPixels directly)
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
	_buildImplementations(
		scaleTypes: { x: string; y: string },
		xFragment: ScaleFragment,
		yFragment: ScaleFragment
	): string {
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
	 * Conditionally generates only the functions needed by the renderer definition.
	 * @private
	 */
	_buildScaleFunctions(
		scaleTypes: { x: string; y: string },
		xFragment: ScaleFragment,
		yFragment: ScaleFragment,
		rendererDefinition: RendererDefinition
	): string {
		const functions = [];

		// Only generate scaleX if the renderer uses X axis
		if (rendererDefinition?.x) {
			const xFunctionName = _scaleFunctionName(scaleTypes.x, 'X');
			functions.push(`
      fn scaleX(value: f32) -> f32 {
        return ${xFunctionName}(value, frameUniforms.xScaleIndex);
      }`);
		}

		// Only generate scaleY if the renderer uses Y axis
		if (rendererDefinition?.y) {
			const yFunctionName = _scaleFunctionName(scaleTypes.y, 'Y');
			functions.push(`
      fn scaleY(value: f32) -> f32 {
        return ${yFunctionName}(value, frameUniforms.yScaleIndex);
      }`);
		}

		// Fallback: if no renderer definition, generate both (backward compatibility)
		if (functions.length === 0) {
			const xFunctionName = _scaleFunctionName(scaleTypes.x, 'X');
			const yFunctionName = _scaleFunctionName(scaleTypes.y, 'Y');
			functions.push(`
      fn scaleX(value: f32) -> f32 {
        return ${xFunctionName}(value, frameUniforms.xScaleIndex);
      }
      fn scaleY(value: f32) -> f32 {
        return ${yFunctionName}(value, frameUniforms.yScaleIndex);
      }`);
		}

		return `// Convenience functions - specialized at compile time${functions.join('\n')}`;
	}

	/**
	 * Build projection helper functions for connected topology marks (lines, areas).
	 * These helpers work in screen-space pixels for proper geometry expansion.
	 * @param {Object} rendererDefinition - Renderer definition to check if helpers are needed
	 * @private
	 */
	_buildProjectHelpers(rendererDefinition: RendererDefinition): string {
		// Only include if both X and Y axes are defined (connected marks need both)
		if (!rendererDefinition?.x || !rendererDefinition?.y) {
			return '';
		}

		return `
      // ===== PROJECTION HELPERS (for connected topology) =====

      // Project raw data values to screen pixels using axis scales
      fn projectToPixels(val: vec2<f32>) -> vec2<f32> {
        return vec2<f32>(scaleX(val.x), scaleY(val.y));
      }

      // Convert screen pixels to clip space for vertex output
      // WebGPU clip space: X [-1, 1] left-to-right, Y [-1, 1] bottom-to-top
      fn pixelsToClip(pixels: vec2<f32>) -> vec4<f32> {
        let ndc = (pixels / frameUniforms.resolution) * 2.0 - 1.0;
        // Flip Y: screen Y increases downward, clip Y increases upward
        return vec4<f32>(ndc.x, -ndc.y, 0.0, 1.0);
      }
    `;
	}

	/**
	 * Build buffer layout specifications for GPUCoordinator
	 * @private
	 */
	_buildBufferLayouts(
		scaleTypes: { x: string; y: string },
		xFragment: ScaleFragment,
		yFragment: ScaleFragment
	): Record<string, BufferLayout & { type: string }> {
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
	_validateScaleTypes(scaleTypes: { x: string; y: string }): void {
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
	getSupportedScaleTypes(): string[] {
		return Object.keys(SCALE_FRAGMENTS);
	}

	/**
	 * Clear shader cache (useful for development)
	 */
	clearCache(): void {
		this.shaderCache.clear();
		this.bufferLayoutCache.clear();
	}
}

// Export singleton instance
export const scaleTemplateSystem = new ScaleTemplateSystem();
