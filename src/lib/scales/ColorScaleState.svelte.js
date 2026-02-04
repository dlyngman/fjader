// src/lib/scales/ColorScaleState.svelte.js
import {
	createD3Scale,
	bakeGradient,
	bakePalette,
	getSchemeType,
	parseColorToRGBA
} from './color-utils.js';
import { viewManager, ViewManagerService } from '$lib/data/ViewManager.svelte.js';

/**
 * Reactive state for a GPU-backed color scale.
 *
 * Handles both continuous (sequential, diverging, cyclical) and discrete (ordinal) scales.
 * Manages GPU slot allocation and buffer uploads.
 */
export class ColorScaleState {
	// Identity
	#field;
	#registry;
	#gpuCoordinator;
	#scaleId = crypto.randomUUID(); // Unique ID for ViewManager registration

	// GPU slot indices (allocated from registry)
	#configSlot = -1;
	#rampSlot = -1; // Used by continuous scales
	#paletteSlot = -1; // Used by ordinal scales

	// Scale configuration
	#scheme;
	#scaleType; // 'ordinal' | 'sequential' | 'diverging' | 'cyclical'
	#reverse;
	#midpoint; // For diverging scales

	// Reactive state
	domain = $state([]);
	ready = $state(false);

	// D3 scale instance (for legends and CPU lookups)
	#d3Scale = null;

	// Ordinal category mapping (string -> 1-based index)
	#categoryMap = new Map();

	// ViewManager integration - tracks tables this scale has registered columns for
	#registeredTables = new Set();
	#viewsCreated = new Set(); // Tables that have had their view column created (one-shot)

	/**
	 * @param {Object} config - Scale configuration
	 * @param {string} config.field - Field name this scale maps
	 * @param {string} config.scheme - D3 color scheme name (e.g., 'viridis', 'tableau10')
	 * @param {string} [config.type] - Explicit scale type ('ordinal', 'sequential', 'diverging', 'cyclical')
	 * @param {Array} config.domain - Domain values
	 * @param {boolean} [config.reverse=false] - Reverse the color direction
	 * @param {number} [config.midpoint] - Explicit midpoint for diverging scales
	 * @param {Object} registry - ScaleRegistry instance (for slot allocation)
	 * @param {Object} gpuCoordinator - GPUCoordinator instance (for buffer writes)
	 */
	constructor(config, registry, gpuCoordinator) {
		this.#field = config.field;
		this.#scheme = config.scheme || 'viridis';
		this.#reverse = config.reverse ?? false;
		this.#midpoint = config.midpoint;
		this.#registry = registry;
		this.#gpuCoordinator = gpuCoordinator;

		// Explicit type wins, fallback to inference from scheme
		this.#scaleType = config.type || getSchemeType(this.#scheme) || 'sequential';

		console.log(
			`[ColorScaleState] Created for ${this.#field}: type=${this.#scaleType}, scheme=${this.#scheme}`
		);

		// Set initial domain
		this.domain = config.domain || [];

		// Allocate GPU slots
		this.#allocateSlots();

		// Initial GPU upload (if domain is ready)
		if (this.domain.length > 0) {
			this.#uploadToGPU();
		}
	}

	// ============================================================
	// GETTERS
	// ============================================================

	get field() {
		return this.#field;
	}

	get scheme() {
		return this.#scheme;
	}

	get scaleType() {
		return this.#scaleType;
	}

	get isOrdinal() {
		return this.#scaleType === 'ordinal';
	}

	get isContinuous() {
		return this.#scaleType !== 'ordinal';
	}

	/**
	 * GPU slot information for registry cleanup.
	 */
	get gpuSlots() {
		return {
			configSlot: this.#configSlot,
			rampSlot: this.#rampSlot,
			paletteSlot: this.#paletteSlot
		};
	}

	/**
	 * The config slot index (used by marks for colorScaleIndex).
	 */
	get gpuIndex() {
		return this.#configSlot;
	}

	/**
	 * D3 scale for legends and CPU-side color lookups.
	 */
	get d3Scale() {
		return this.#d3Scale;
	}

	/**
	 * The column name used in derived views for this scale's index.
	 * Format: __dplot_{field}_idx (shared with band scales)
	 */
	get indexColumnName() {
		return ViewManagerService.bandIndexColumn(this.#field);
	}

	/**
	 * Unique scale ID for ViewManager registration.
	 */
	get scaleId() {
		return this.#scaleId;
	}

	// ============================================================
	// SLOT ALLOCATION
	// ============================================================

	#allocateSlots() {
		// Always need a config slot
		this.#configSlot = this.#registry.allocateColorSlot();

		// Allocate type-specific slot
		if (this.isOrdinal) {
			this.#paletteSlot = this.#registry.allocatePaletteSlot();
		} else {
			this.#rampSlot = this.#registry.allocateRampSlot();
		}
	}

	/**
	 * Swap slots when changing between ordinal and continuous.
	 */
	#swapSlots(newTypeIsOrdinal) {
		if (newTypeIsOrdinal) {
			this.#registry.releaseRampSlot(this.#rampSlot);
			this.#rampSlot = -1;
			this.#paletteSlot = this.#registry.allocatePaletteSlot();
		} else {
			this.#registry.releasePaletteSlot(this.#paletteSlot);
			this.#paletteSlot = -1;
			this.#rampSlot = this.#registry.allocateRampSlot();
		}
	}

	// ============================================================
	// DATA PROCESSING (Required by Marks)
	// ============================================================

	/**
	 * Converts raw data into GPU-ready values.
	 * - Ordinal: string -> u32 index (1-based, 0 = null/unknown)
	 * - Continuous: number -> f32 value (pass-through)
	 *
	 * Fast path: If data is already a Float32Array (from ViewManager-derived view),
	 * returns it directly without processing.
	 *
	 * @param {Array|Float32Array} data - Raw data values
	 * @returns {Float32Array} GPU-ready values
	 */
	processDataForGPU(data) {
		// Fast path: already Float32Array from derived view (zero-copy)
		if (data instanceof Float32Array) {
			// console.log(`[ColorScale:${this.#field}] ✅ FAST PATH - Float32Array indices:`, {
			// 	length: data.length,
			// 	sample: Array.from(data.slice(0, 5)),
			// 	isIndices: true
			// });
			return data;
		}

		if (this.isOrdinal) {
			// console.log(`[ColorScale:${this.#field}] 🐢 JS PATH - Converting strings to indices:`, {
			// 	length: data.length,
			// 	sample: data.slice(0, 5),
			// 	isStrings: typeof data[0] === 'string'
			// });
			const indices = new Float32Array(data.length);
			for (let i = 0; i < data.length; i++) {
				const val = data[i];
				// 0 = null/fallback, 1..N = valid categories
				indices[i] = val == null ? 0 : (this.#categoryMap.get(val) ?? 0);
			}
			return indices;
		}

		// Continuous: convert to Float32Array
		return new Float32Array(data);
	}

	// ============================================================
	// GPU UPLOAD
	// ============================================================

	#uploadToGPU() {
		if (!this.#gpuCoordinator) {
			console.warn('[ColorScaleState] No GPU coordinator, skipping upload');
			return;
		}

		if (this.domain.length === 0) {
			return;
		}

		// Create D3 scale with current domain (for CPU/legend use)
		this.#d3Scale = createD3Scale(this.#scheme, this.domain, {
			reverse: this.#reverse,
			midpoint: this.#midpoint
		});

		if (this.isOrdinal) {
			this.#uploadOrdinal();
		} else {
			this.#uploadContinuous();
		}

		this.ready = true;
	}

	#uploadContinuous() {
		// Bake gradient from configured D3 scale
		const rampData = bakeGradient(this.#d3Scale, 256);
		this.#gpuCoordinator.writeColorRamp(this.#rampSlot, rampData);

		// Build and upload config struct
		const config = this.#buildColorConfig({
			type: this.#getScaleTypeInt(),
			rampOffset: this.#rampSlot * 256,
			domainMin: this.domain[0],
			domainMax: this.domain[this.domain.length - 1]
		});
		this.#gpuCoordinator.writeColorConfig(this.#configSlot, config);
	}

	#uploadOrdinal() {
		// Rebuild category map (string -> 1-based index)
		this.#categoryMap.clear();
		this.domain.forEach((cat, i) => this.#categoryMap.set(cat, i + 1));

		// Bake and upload palette
		const paletteData = bakePalette(this.#scheme, { reverse: this.#reverse });
		this.#gpuCoordinator.writeColorPalette(this.#paletteSlot, paletteData);

		// Build and upload config struct
		const config = this.#buildColorConfig({
			type: 0, // ORDINAL
			paletteOffset: this.#paletteSlot * 32,
			paletteSize: Math.min(this.domain.length, 32)
		});
		this.#gpuCoordinator.writeColorConfig(this.#configSlot, config);
	}

	/**
	 * Get integer type code for scale type.
	 */
	#getScaleTypeInt() {
		switch (this.#scaleType) {
			case 'ordinal':
				return 0;
			case 'sequential':
				return 1;
			case 'diverging':
				return 2;
			case 'cyclical':
				return 3;
			default:
				return 1;
		}
	}

	/**
	 * Build the ColorConfig struct as ArrayBuffer.
	 * Uses DataView for correct binary layout (mixed f32/u32).
	 *
	 * MUST MATCH WGSL LAYOUT:
	 * struct ColorConfig {
	 *   domainMin: f32,      // byte 0
	 *   domainMax: f32,      // byte 4
	 *   rampOffset: u32,     // byte 8
	 *   paletteOffset: u32,  // byte 12
	 *   paletteSize: u32,    // byte 16
	 *   scaleType: u32,      // byte 20
	 *   _pad: vec2<u32>,     // byte 24, 28
	 * }; // 32 bytes total
	 */
	#buildColorConfig(params) {
		const buffer = new ArrayBuffer(32);
		const view = new DataView(buffer);
		const LE = true; // Little Endian (WebGPU standard)

		// f32 fields
		view.setFloat32(0, params.domainMin ?? 0, LE);
		view.setFloat32(4, params.domainMax ?? 0, LE);

		// u32 fields
		view.setUint32(8, params.rampOffset ?? 0, LE);
		view.setUint32(12, params.paletteOffset ?? 0, LE);
		view.setUint32(16, params.paletteSize ?? 0, LE);
		view.setUint32(20, params.type ?? 0, LE);

		// bytes 24-31 are padding (left as 0)

		return buffer;
	}

	// ============================================================
	// VIEWMANAGER INTEGRATION
	// ============================================================

	/**
	 * Register this scale for a source table. After domain is set,
	 * the view will be created with the index column (one-shot).
	 *
	 * @param {string} sourceTable - The database table to register for
	 */
	registerTable(sourceTable) {
		this.#registeredTables.add(sourceTable);
		this.#maybeCreateView(sourceTable);
	}

	/**
	 * Create view for a table if both table is registered and domain is known.
	 * Only creates once per table (one-shot).
	 */
	#maybeCreateView(sourceTable) {
		// Only create once per table
		if (this.#viewsCreated.has(sourceTable)) {
			return;
		}

		// Need domain to be ready
		if (!this.isOrdinal || this.domain.length === 0) {
			return;
		}

		this.#viewsCreated.add(sourceTable);

		const alias = this.indexColumnName;
		const sql = ViewManagerService.buildCaseExpression(this.#field, this.domain, {
			oneBased: false // 0-based indices (shared with band scales, -1 = null/unknown)
		});

		viewManager.registerColumn(sourceTable, alias, {
			sql,
			source: this.#field,
			scaleId: this.#scaleId
		});

		console.log(`[ColorScaleState] Created view column ${alias} for table ${sourceTable}`);
	}

	/**
	 * Unregister this scale's columns from ViewManager.
	 * Called during destroy().
	 */
	#unregisterFromViewManager() {
		const alias = this.indexColumnName;

		for (const table of this.#registeredTables) {
			viewManager.unregisterColumn(table, alias, this.#scaleId);
		}

		this.#registeredTables.clear();
		this.#viewsCreated.clear();
	}

	// ============================================================
	// DOMAIN UPDATES
	// ============================================================

	/**
	 * Update the domain. Triggers GPU re-upload.
	 * Also triggers one-shot view creation for registered tables.
	 * @param {Array} newDomain - New domain values
	 */
	setDomain(newDomain) {
		if (!newDomain || newDomain.length === 0) return;

		// Check if domain actually changed
		const domainChanged =
			newDomain.length !== this.domain.length || newDomain.some((v, i) => v !== this.domain[i]);

		if (!domainChanged) return;

		this.domain = [...newDomain];
		this.#uploadToGPU();

		// Try to create views for registered tables (one-shot, will skip if already created)
		for (const table of this.#registeredTables) {
			this.#maybeCreateView(table);
		}
	}

	/**
	 * Update the scheme. Triggers GPU re-upload.
	 * @param {string} newScheme - New scheme name
	 */
	setScheme(newScheme) {
		if (newScheme === this.#scheme) return;

		const newType = getSchemeType(newScheme);
		const wasOrdinal = this.isOrdinal;
		const nowOrdinal = newType === 'ordinal';

		// Swap slots if changing between ordinal and continuous
		if (wasOrdinal !== nowOrdinal) {
			this.#swapSlots(nowOrdinal);
		}

		this.#scheme = newScheme;
		this.#scaleType = newType || 'sequential';

		if (this.domain.length > 0) {
			this.#uploadToGPU();
			// Trigger re-render - registry will invalidate charts using this scale
			this.#registry.invalidateChartsForScale(this.#field);
		}
	}

	// ============================================================
	// MARK REGISTRATION (for domain aggregation)
	// ============================================================

	/**
	 * Register a mark's data extent with this scale.
	 * @param {Array} extent - [min, max] for continuous, or category array for ordinal
	 * @param {string} markId - Unique mark identifier
	 */
	addMark(extent, markId) {
		// For now, simple domain overwrite
		// TODO: Aggregate across multiple marks if needed
		this.setDomain(extent);
	}

	/**
	 * Unregister a mark from this scale.
	 * @param {string} markId - Unique mark identifier
	 */
	removeMark(markId) {
		// TODO: Remove mark's contribution to domain
	}

	// ============================================================
	// CPU-SIDE COLOR LOOKUP
	// ============================================================

	/**
	 * Get color for a value (CPU-side lookup).
	 * @param {*} value - Domain value
	 * @returns {string} CSS color string
	 */
	getColor(value) {
		if (!this.#d3Scale) return '#000000';
		return this.#d3Scale(value);
	}

	/**
	 * Get color as RGBA array (0-1 range).
	 * @param {*} value - Domain value
	 * @returns {[number, number, number, number]} RGBA array
	 */
	getColorRGBA(value) {
		const cssColor = this.getColor(value);
		return parseColorToRGBA(cssColor);
	}

	// ============================================================
	// CLEANUP
	// ============================================================

	destroy() {
		// Unregister from ViewManager
		this.#unregisterFromViewManager();

		// Slots are released by registry via gpuSlots getter
		this.#d3Scale = null;
		this.#categoryMap.clear();
		this.ready = false;
	}
}
