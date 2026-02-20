// src/lib/scales/ColorScaleState.svelte.ts
import {
	createD3Scale,
	bakeGradient,
	bakePalette,
	getSchemeType,
	parseColorToRGBA
} from './color-utils';
import type { RGBA, D3ColorScale } from './color-utils';
import { viewManager, ViewManagerService } from '$lib/data/ViewManager.svelte';
import type { ColorScaleType } from '$lib/types';
import type { ScaleRegistry } from './ScaleRegistry.svelte';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';

interface ColorScaleConfig {
	field: string;
	scheme?: string;
	type?: ColorScaleType;
	domain?: (string | number)[];
	reverse?: boolean;
	midpoint?: number;
}

interface ColorConfigParams {
	type: number;
	rampOffset?: number;
	paletteOffset?: number;
	paletteSize?: number;
	domainMin?: number;
	domainMax?: number;
}

/**
 * Reactive state for a GPU-backed color scale.
 *
 * Handles both continuous (sequential, diverging, cyclical) and discrete (ordinal) scales.
 * Manages GPU slot allocation and buffer uploads.
 */
export class ColorScaleState {
	// Identity
	#field: string;
	#registry: ScaleRegistry;
	#gpuCoordinator: GPUCoordinator | null;
	#scaleId: string = crypto.randomUUID(); // Unique ID for ViewManager registration

	// GPU slot indices (allocated from registry)
	#configSlot: number = -1;
	#rampSlot: number = -1; // Used by continuous scales
	#paletteSlot: number = -1; // Used by ordinal scales

	// Scale configuration
	#scheme: string;
	#scaleType: ColorScaleType; // 'ordinal' | 'sequential' | 'diverging' | 'cyclical'
	#reverse: boolean;
	#midpoint: number | undefined; // For diverging scales

	// Reactive state
	domain: (string | number)[] = $state([]);
	ready: boolean = $state(false);
	#activeValues: Set<string | number> | null = $state(null); // null = all active, Set = only these active

	// D3 scale instance (for legends and CPU lookups)
	#d3Scale: D3ColorScale | null = null;

	// Ordinal category mapping (string -> 1-based index)
	#categoryMap: Map<string | number, number> = new Map();

	// ViewManager integration - tracks tables this scale has registered columns for
	#registeredTables: Set<string> = new Set();
	#viewsCreated: Set<string> = new Set(); // Tables that have had their view column created (one-shot)

	constructor(config: ColorScaleConfig, registry: ScaleRegistry, gpuCoordinator: GPUCoordinator | null) {
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

	get field(): string {
		return this.#field;
	}

	get scheme(): string {
		return this.#scheme;
	}

	get scaleType(): ColorScaleType {
		return this.#scaleType;
	}

	get activeValues(): Set<string | number> | null {
		return this.#activeValues;
	}

	get isOrdinal(): boolean {
		return this.#scaleType === 'ordinal';
	}

	get isContinuous(): boolean {
		return this.#scaleType !== 'ordinal';
	}

	/**
	 * GPU slot information for registry cleanup.
	 */
	get gpuSlots(): { configSlot: number; rampSlot: number; paletteSlot: number } {
		return {
			configSlot: this.#configSlot,
			rampSlot: this.#rampSlot,
			paletteSlot: this.#paletteSlot
		};
	}

	/**
	 * The config slot index (used by marks for colorScaleIndex).
	 */
	get gpuIndex(): number {
		return this.#configSlot;
	}

	/**
	 * D3 scale for legends and CPU-side color lookups.
	 */
	get d3Scale(): D3ColorScale | null {
		return this.#d3Scale;
	}

	/**
	 * The column name used in derived views for this scale's index.
	 * Format: __dplot_{field}_idx (shared with band scales)
	 */
	get indexColumnName(): string {
		return ViewManagerService.bandIndexColumn(this.#field);
	}

	/**
	 * Unique scale ID for ViewManager registration.
	 */
	get scaleId(): string {
		return this.#scaleId;
	}

	// ============================================================
	// SLOT ALLOCATION
	// ============================================================

	#allocateSlots(): void {
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
	#swapSlots(newTypeIsOrdinal: boolean): void {
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
	 */
	processDataForGPU(data: (string | number | null)[] | Float32Array): Float32Array {
		// Fast path: already Float32Array from derived view (zero-copy)
		if (data instanceof Float32Array) {
			return data;
		}

		if (this.isOrdinal) {
			const indices = new Float32Array(data.length);
			for (let i = 0; i < data.length; i++) {
				const val = data[i];
				// 0 = null/fallback, 1..N = valid categories
				indices[i] = val == null ? 0 : (this.#categoryMap.get(val) ?? 0);
			}
			return indices;
		}

		// Continuous: convert to Float32Array
		return new Float32Array(data as number[]);
	}

	// ============================================================
	// GPU UPLOAD
	// ============================================================

	#uploadToGPU(): void {
		if (!this.#gpuCoordinator) {
			console.warn('[ColorScaleState] No GPU coordinator, skipping upload');
			return;
		}

		if (this.domain.length === 0) {
			return;
		}

		// Create D3 scale with current domain (for CPU/legend use)
		this.#d3Scale = createD3Scale(this.#scheme, this.domain as number[], {
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

	#uploadContinuous(): void {
		// Bake gradient from configured D3 scale
		const rampData = bakeGradient(this.#d3Scale, 256);
		this.#gpuCoordinator.writeColorRamp(this.#rampSlot, rampData);

		// Build and upload config struct
		const config = this.#buildColorConfig({
			type: this.#getScaleTypeInt(),
			rampOffset: this.#rampSlot * 256,
			domainMin: this.domain[0] as number,
			domainMax: this.domain[this.domain.length - 1] as number
		});
		this.#gpuCoordinator.writeColorConfig(this.#configSlot, config);
	}

	#uploadOrdinal(): void {
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
	#getScaleTypeInt(): number {
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
	#buildColorConfig(params: ColorConfigParams): ArrayBuffer {
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
	 */
	registerTable(sourceTable: string): void {
		this.#registeredTables.add(sourceTable);
		this.#maybeCreateView(sourceTable);
	}

	/**
	 * Create view for a table if both table is registered and domain is known.
	 * Only creates once per table (one-shot).
	 */
	#maybeCreateView(sourceTable: string): void {
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
		const sql = ViewManagerService.buildCaseExpression(this.#field, this.domain as string[], {
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
	#unregisterFromViewManager(): void {
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
	 */
	setDomain(newDomain: (string | number)[]): void {
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
	 */
	setScheme(newScheme: string): void {
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
	 */
	addMark(extent: (string | number)[], markId: string): void {
		// For now, simple domain overwrite
		// TODO: Aggregate across multiple marks if needed
		this.setDomain(extent);
	}

	/**
	 * Unregister a mark from this scale.
	 */
	removeMark(markId: string): void {
		// TODO: Remove mark's contribution to domain
	}

	// ============================================================
	// CPU-SIDE COLOR LOOKUP
	// ============================================================

	/**
	 * Get color for a value (CPU-side lookup).
	 */
	getColor(value: string | number): string {
		if (!this.#d3Scale) return '#000000';
		return this.#d3Scale(value);
	}

	/**
	 * Get color as RGBA array (0-1 range).
	 */
	getColorRGBA(value: string | number): RGBA {
		const cssColor = this.getColor(value);
		return parseColorToRGBA(cssColor);
	}

	// ============================================================
	// ACTIVE VALUES (selection feedback)
	// ============================================================

	setActiveValues(values: Iterable<string | number>): void {
		this.#activeValues = values instanceof Set ? values : new Set(values);
	}

	clearActiveValues(): void {
		this.#activeValues = null;
	}

	isActive(value: string | number): boolean {
		return this.#activeValues == null || this.#activeValues.has(value);
	}

	// ============================================================
	// CLEANUP
	// ============================================================

	destroy(): void {
		// Unregister from ViewManager
		this.#unregisterFromViewManager();

		// Slots are released by registry via gpuSlots getter
		this.#activeValues = null;
		this.#d3Scale = null;
		this.#categoryMap.clear();
		this.ready = false;
	}
}
