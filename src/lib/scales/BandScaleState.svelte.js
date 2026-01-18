// src/lib/scales/BandScaleState.svelte.js

import { scaleBand } from 'd3-scale';

/**
 * BandScaleState manages categorical (band/point) scales.
 *
 * Key responsibilities:
 * - Domain management (unique categories from multiple marks)
 * - Category-to-index mapping for GPU rendering
 * - D3 scale creation for axes and SVG components
 * - Configuration for GPU band scale calculations
 *
 * Features:
 * - Freeze/debounce support for performance
 * - Extent tracking from multiple marks
 * - GPU-ready index mapping
 * - Full D3 compatibility
 */
export class BandScaleState {
	// =========================================================================
	// IDENTITY & TYPE
	// =========================================================================
	id = crypto.randomUUID();
	name = $state('');
	type = 'band';
	ready = $state(false);
	_version = $state(0);

	// =========================================================================
	// DOMAIN STATE
	// =========================================================================
	#domain = $state([]);
	#extents = new Map(); // Stores domains from different marks

	// =========================================================================
	// CONFIGURATION (D3 band scale parameters)
	// =========================================================================
	#padding = 0.1;
	#paddingInner = null;
	#paddingOuter = null;
	#align = 0.5;

	// =========================================================================
	// FREEZE/DEBOUNCE FUNCTIONALITY
	// =========================================================================
	#enableUpdates = $state(true);
	#frozenDomain = null;

	// =========================================================================
	// D3 SCALE INSTANCE (Reused for performance)
	// =========================================================================
	#sharedScale = scaleBand();

	// =========================================================================
	// DERIVED STATE
	// =========================================================================

	/**
	 * Category-to-index mapping (derived)
	 * Used by marks to convert category strings to GPU indices
	 */
	#categoryIndexMap = $derived.by(() => {
		const domain = this.#enableUpdates ? this.#domain : this.#frozenDomain || this.#domain;

		const map = new Map();
		domain.forEach((category, index) => {
			map.set(category, index);
		});
		return map;
	});

	/**
	 * GPU state (derived) - for compatibility with coordinator
	 */
	gpuState = $derived.by(() => {
		const categoryCount = this.#categoryIndexMap.size;

		return {
			domainMin: 0,
			domainMax: Math.max(0, categoryCount - 1),
			categoryCount: categoryCount,
			domainScale: 0
		};
	});

	// =========================================================================
	// CONSTRUCTOR
	// =========================================================================

	constructor(name, domain = [], config = {}) {
		this.name = name;
		this.#domain = [...domain];

		// Apply configuration with defaults
		this.#padding = config.padding ?? 0.1;
		this.#paddingInner = config.paddingInner ?? null;
		this.#paddingOuter = config.paddingOuter ?? null;
		this.#align = config.align ?? 0.5;

		console.log(`🏗️ BandScaleState "${name}" created:`, {
			initialDomain: domain.length,
			padding: this.#padding,
			paddingInner: this.#paddingInner,
			paddingOuter: this.#paddingOuter,
			align: this.#align
		});
	}

	// =========================================================================
	// LIFECYCLE
	// =========================================================================

	setReady() {
		this.ready = true;
		console.log(`✅ BandScaleState "${this.name}" marked as ready`);
	}

	destroy() {
		this.#frozenDomain = null;
		this.#extents.clear();
	}

	// =========================================================================
	// FREEZE/DEBOUNCE CONTROL
	// =========================================================================

	/**
	 * Enable or disable scale updates
	 * When disabled, domain is frozen at current state
	 */
	setUpdatesEnabled(enabled) {
		const wasEnabled = this.#enableUpdates;
		this.#enableUpdates = enabled;

		if (wasEnabled && !enabled) {
			// Freezing - capture current domain
			this.#frozenDomain = [...this.#domain];
			console.log(`❄️ BandScale "${this.name}" frozen at ${this.#frozenDomain.length} categories`);
		} else if (!wasEnabled && enabled) {
			// Unfreezing - restore updates
			this.#frozenDomain = null;
			this.updateDomainFromExtents();
			console.log(`🔥 BandScale "${this.name}" unfrozen`);
		}
	}

	get updatesEnabled() {
		return this.#enableUpdates;
	}

	get effectiveDomain() {
		return this.#enableUpdates ? this.#domain : this.#frozenDomain || this.#domain;
	}

	// =========================================================================
	// GPU READINESS
	// =========================================================================

	/**
	 * Check if the scale is ready for GPU processing
	 */
	get isReadyForGPU() {
		return (
			this.ready &&
			this.effectiveDomain.length > 0 &&
			this.#categoryIndexMap instanceof Map &&
			this.#extents.size > 0
		);
	}

	// =========================================================================
	// DOMAIN MANAGEMENT
	// =========================================================================

	/**
	 * Add categorical data from a mark
	 * @param {Array} categories - Array of category values
	 * @param {string} identifier - Mark identifier
	 */
	addMark(categories, identifier) {
		const uniqueCategories = [...new Set(categories.filter((c) => c != null))];

		this.#extents.set(identifier, uniqueCategories);

		if (this.#enableUpdates) {
			this.updateDomainFromExtents();
		}

		return this;
	}

	/**
	 * Remove a mark's categories from domain calculation
	 * @param {string} identifier - Mark identifier
	 */
	removeMark(identifier) {
		if (this.#extents.has(identifier)) {
			this.#extents.delete(identifier);

			if (this.#enableUpdates) {
				this.updateDomainFromExtents();
			}
		}
		return this;
	}

	/**
	 * Update domain based on all categories from all marks
	 * Preserves order of first appearance
	 */
	updateDomainFromExtents() {
		if (!this.#enableUpdates) {
			return;
		}
		if (this.#extents.size === 0) {
			this.#domain = [];
			this._version++;
			return;
		}
		const allCategories = [];
		const seen = new Set();
		for (const categories of this.#extents.values()) {
			for (const category of categories) {
				if (!seen.has(category)) {
					seen.add(category);
					allCategories.push(category);
				}
			}
		}
		this.#domain = allCategories;
		this._version++;
	}

	// =========================================================================
	// GPU DATA INTERFACE
	// =========================================================================

	/**
	 * Convert categorical data to indices for GPU processing
	 *
	 * @param {Array} categoryData - Array of category values from mark data
	 * @param {string} markId - Identifier for the mark (for debugging)
	 * @returns {Float32Array} Array of indices corresponding to categories
	 */
	processDataForGPU(categoryData, markId = 'unknown') {
		const categoryMap = this.#categoryIndexMap;

		// Safety check - ensure map is valid
		if (!(categoryMap instanceof Map)) {
			console.error(`🚨 BandScale "${this.name}": categoryMap is not a Map:`, categoryMap);
			const fallbackMap = new Map();
			this.effectiveDomain.forEach((category, index) => {
				fallbackMap.set(category, index);
			});
			return this.#processWithMap(categoryData, fallbackMap, markId);
		}

		return this.#processWithMap(categoryData, categoryMap, markId);
	}

	/**
	 * Helper method to process data with a given category map
	 * @private
	 */
	#processWithMap(categoryData, categoryMap, markId) {
		const unmappedCategories = new Set();

		const indices = new Float32Array(
			categoryData.map((category) => {
				const index = categoryMap.get(category);
				if (index !== undefined) {
					return index;
				} else {
					unmappedCategories.add(category);
					return 0; // Default to first category index
				}
			})
		);

		// Warn about unmapped categories in development
		if (unmappedCategories.size > 0) {
			console.warn(
				`🔶 BandScale "${this.name}": Unmapped categories for mark "${markId}":`,
				Array.from(unmappedCategories).slice(0, 5),
				unmappedCategories.size > 5 ? `... and ${unmappedCategories.size - 5} more` : '',
				`\nValid categories:`,
				this.effectiveDomain
			);
		}

		return indices;
	}

	/**
	 * Get configuration for GPU coordinator to write to SSBO
	 * This is called by GPUCoordinator.fillAllScales()
	 *
	 * @returns {Object} Configuration for GPU band scale calculations
	 */
	getConfig() {
		// Resolve effective padding values
		const paddingInner = this.#paddingInner !== null ? this.#paddingInner : this.#padding;

		const paddingOuter = this.#paddingOuter !== null ? this.#paddingOuter : this.#padding;

		return {
			categoryCount: this.effectiveDomain.length,
			paddingInner: paddingInner,
			paddingOuter: paddingOuter,
			align: this.#align
		};
	}

	// =========================================================================
	// D3-COMPATIBLE API (for axes, legends, etc.)
	// =========================================================================

	/**
	 * Get D3 band scale configured for rendering
	 * @param {string} axis - 'x' or 'y'
	 * @param {number} innerWidthOrHeight - Chart inner dimension
	 * @returns {Function} D3 band scale
	 */
	getBaseScale(axis, innerWidthOrHeight) {
		this.#sharedScale.range(axis === 'x' ? [0, innerWidthOrHeight] : [innerWidthOrHeight, 0]);

		if (this.#paddingInner !== null && this.#paddingOuter !== null) {
			this.#sharedScale.paddingInner(this.#paddingInner).paddingOuter(this.#paddingOuter);
		} else {
			this.#sharedScale.padding(this.#padding);
		}

		if (this.#align !== 0.5) {
			this.#sharedScale.align(this.#align);
		}

		return this.#sharedScale;
	}

	/**
	 * Update scale domain (for D3 scale)
	 * @param {Function} scale - D3 scale to update
	 */
	updateScaleDomain(scale) {
		this._version; // Register svelte dependency
		scale.domain(this.effectiveDomain);
		return scale; // Return the function itself
	}

	/**
	 * Get the current domain (array of categories)
	 */
	domain() {
		return [...this.effectiveDomain];
	}

	get domainForReactivity() {
		this._version;
		return this.effectiveDomain;
	}

	/**
	 * Calculate bandwidth for a given range size (CPU-side)
	 * Useful for axes, tooltips, etc.
	 */
	bandwidth(rangeSize) {
		const config = this.getConfig();
		const n = config.categoryCount;

		if (n === 0) return 0;

		const step = rangeSize / Math.max(1, n - config.paddingInner + config.paddingOuter * 2);
		return step * (1 - config.paddingInner);
	}

	/**
	 * Calculate step size for a given range size (CPU-side)
	 */
	step(rangeSize) {
		const config = this.getConfig();
		const n = config.categoryCount;

		if (n === 0) return 0;

		return rangeSize / Math.max(1, n - config.paddingInner + config.paddingOuter * 2);
	}

	// =========================================================================
	// LEGACY/COMPATIBILITY METHODS
	// =========================================================================

	/**
	 * Get positioning information for a category (for compatibility)
	 */
	getPosition(category) {
		const index = this.effectiveDomain.indexOf(category);
		if (index === -1) return { current: 0 };

		return {
			current: index / Math.max(1, this.effectiveDomain.length - 1)
		};
	}

	/**
	 * Get category index map (for debugging)
	 */
	getCategoryIndexMap() {
		return new Map(this.#categoryIndexMap);
	}

	/**
	 * Get all mark extents (for debugging)
	 */
	getExtents() {
		return Object.fromEntries(this.#extents);
	}

	// No-op methods for API consistency with LinearScaleState
	applyZoomDomain() {
		return;
	}
	applyPanDomain() {
		return;
	}
	resetZoom() {
		return;
	}

	// =========================================================================
	// DEBUGGING
	// =========================================================================

	/**
	 * Get comprehensive debug information
	 */
	getDebugInfo() {
		return {
			name: this.name,
			id: this.id,
			type: this.type,
			ready: this.ready,
			isReadyForGPU: this.isReadyForGPU,

			// Domain state
			updatesEnabled: this.#enableUpdates,
			currentDomain: [...this.#domain],
			frozenDomain: this.#frozenDomain ? [...this.#frozenDomain] : null,
			effectiveDomain: [...this.effectiveDomain],
			categoryCount: this.effectiveDomain.length,

			// Extent tracking
			extentsCount: this.#extents.size,
			extents: Object.fromEntries(this.#extents),

			// Configuration
			configuration: {
				padding: this.#padding,
				paddingInner: this.#paddingInner,
				paddingOuter: this.#paddingOuter,
				align: this.#align
			},

			// GPU config
			gpuConfig: this.getConfig(),

			// Category mapping
			categoryIndexMap: Object.fromEntries(this.#categoryIndexMap),

			// GPU state
			gpuState: this.gpuState
		};
	}
}
