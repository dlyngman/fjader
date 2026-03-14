// src/lib/scales/BandScaleState.svelte.ts

import { scaleBand } from 'd3-scale';
import type { ScaleBand } from 'd3-scale';
import { viewManager, ViewManagerService } from '$lib/data/ViewManager.svelte';

interface BandScaleConfig {
	padding?: number;
	paddingInner?: number | null;
	paddingOuter?: number | null;
	align?: number;
	sourceField?: string | null;
	registry?: { invalidateChartsUsingScale(scale: unknown): void } | null;
}

interface BandGpuConfig {
	categoryCount: number;
	paddingInner: number;
	paddingOuter: number;
	align: number;
}

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
	get scaleType(): 'band' {
		return 'band';
	}

	/** Whether this scale supports interactive pan and zoom. */
	get supportsPanZoom(): boolean {
		return false;
	}

	id: string = crypto.randomUUID();
	#scaleId: string = crypto.randomUUID(); // Unique ID for ViewManager registration
	name: string = $state('');
	type: string = 'band';
	ready: boolean = $state(false);
	_version: number = $state(0);

	// ViewManager integration - tracks tables this scale has registered columns for
	#registeredTables: Set<string> = new Set();
	#viewsCreated: Set<string> = new Set(); // Tables that have had their view column created (one-shot)

	// =========================================================================
	// SELECTION STATE
	// =========================================================================
	#activeValues: Set<string> | null = $state(null); // null = all active, Set = only these active

	// =========================================================================
	// POINTER STATE
	// =========================================================================
	currentDataPoint: number | null = $state(null); // Band index under cursor (integer), or null

	// =========================================================================
	// DOMAIN STATE
	// =========================================================================
	#domain: string[] = $state([]);
	#extents: Map<string, string[]> = new Map(); // Stores domains from different marks
	#sortOrder: string[] | null = null; // Preferred category ordering from a mark with sort config
	#domainUpdateScheduled: boolean = false; // Microtask debounce for updateDomainFromExtents

	// =========================================================================
	// CONFIGURATION (D3 band scale parameters)
	// =========================================================================
	#padding: number = 0.1;
	#paddingInner: number | null = null;
	#paddingOuter: number | null = null;
	#align: number = 0.5;
	#sourceField: string | null = null; // Actual SQL column name (defaults to this.name if null)
	#registry: { invalidateChartsUsingScale(scale: unknown): void } | null = null;

	// =========================================================================
	// FREEZE/DEBOUNCE FUNCTIONALITY
	// =========================================================================
	#enableUpdates: boolean = $state(true);
	#frozenDomain: string[] | null = null;

	// =========================================================================
	// D3 SCALE INSTANCE (Reused for performance)
	// =========================================================================
	#sharedScale: ScaleBand<string> = scaleBand();

	// =========================================================================
	// DERIVED STATE
	// =========================================================================

	/**
	 * Category-to-index mapping (derived)
	 * Used by marks to convert category strings to GPU indices
	 */
	#categoryIndexMap: Map<string, number> = $derived.by(() => {
		const domain = this.#enableUpdates ? this.#domain : this.#frozenDomain || this.#domain;

		const map = new Map<string, number>();
		domain.forEach((category, index) => {
			map.set(category, index);
		});
		return map;
	});

	/**
	 * GPU state (derived) - for compatibility with coordinator
	 */
	gpuState: { domainMin: number; domainMax: number; p4: number; domainScale: number } = $derived.by(
		() => {
			const categoryCount = this.#categoryIndexMap.size;

			return {
				domainMin: 0,
				domainMax: Math.max(0, categoryCount - 1),
				p4: 0, // unused for band scales (SSBO written via getConfig instead)
				domainScale: 0
			};
		}
	);

	// =========================================================================
	// CONSTRUCTOR
	// =========================================================================

	constructor(name: string, domain: string[] = [], config: BandScaleConfig = {}) {
		this.name = name;
		this.#domain = [...domain];

		// Apply configuration with defaults
		this.#padding = config.padding ?? 0.1;
		this.#paddingInner = config.paddingInner ?? null;
		this.#paddingOuter = config.paddingOuter ?? null;
		this.#align = config.align ?? 0.5;
		this.#sourceField = config.sourceField ?? null;
		this.#registry = config.registry ?? null;

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

	setReady(): void {
		this.ready = true;
		console.log(`✅ BandScaleState "${this.name}" marked as ready`);
	}

	// =========================================================================
	// ACTIVE VALUES (selection feedback)
	// =========================================================================

	get activeValues(): Set<string> | null {
		return this.#activeValues;
	}

	setActiveValues(values: Iterable<string>): void {
		this.#activeValues = values instanceof Set ? values : new Set(values);
	}

	clearActiveValues(): void {
		this.#activeValues = null;
	}

	isActive(value: string): boolean {
		return this.#activeValues == null || this.#activeValues.has(value);
	}

	destroy(): void {
		// Unregister from ViewManager
		this.#unregisterFromViewManager();

		this.#activeValues = null;
		this.#frozenDomain = null;
		this.#extents.clear();
	}

	// =========================================================================
	// VIEWMANAGER INTEGRATION
	// =========================================================================

	/**
	 * The actual SQL column name in the source table.
	 * Defaults to this.name, but can be overridden (e.g. for facet scales
	 * where name is "__facet__species" but sourceField is "species").
	 */
	get sourceField(): string {
		return this.#sourceField ?? this.name;
	}

	/**
	 * The column name used in derived views for this scale's index.
	 * Format: __dplot_{field}_idx
	 */
	get indexColumnName(): string {
		return ViewManagerService.bandIndexColumn(this.sourceField);
	}

	/**
	 * Unique scale ID for ViewManager registration.
	 */
	get scaleId(): string {
		return this.#scaleId;
	}

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
		if (this.effectiveDomain.length === 0) {
			return;
		}

		this.#viewsCreated.add(sourceTable);

		const alias = this.indexColumnName;
		const sql = ViewManagerService.buildCaseExpression(this.sourceField, this.effectiveDomain, {
			oneBased: false // Band indices are 0-based
		});

		viewManager.registerColumn(sourceTable, alias, {
			sql,
			source: this.sourceField,
			scaleId: this.#scaleId
		});

		console.log(`[BandScaleState] Created view column ${alias} for table ${sourceTable}`);
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

	// =========================================================================
	// FREEZE/DEBOUNCE CONTROL
	// =========================================================================

	/**
	 * Enable or disable scale updates
	 * When disabled, domain is frozen at current state
	 */
	setUpdatesEnabled(enabled: boolean): void {
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

	get updatesEnabled(): boolean {
		return this.#enableUpdates;
	}

	get effectiveDomain(): string[] {
		return this.#enableUpdates ? this.#domain : this.#frozenDomain || this.#domain;
	}

	// =========================================================================
	// GPU READINESS
	// =========================================================================

	/**
	 * Check if the scale is ready for GPU processing
	 */
	get isReadyForGPU(): boolean {
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
	 */
	addMark(
		categories: string[],
		identifier: string,
		{ sorted = false }: { sorted?: boolean } = {}
	): this {
		const uniqueCategories = [...new Set(categories.filter((c) => c != null))];

		this.#extents.set(identifier, uniqueCategories);

		if (sorted) {
			this.#sortOrder = uniqueCategories;
		}

		if (this.#enableUpdates) {
			this.#scheduleDomainUpdate();
		}

		return this;
	}

	/**
	 * Remove a mark's categories from domain calculation
	 */
	removeMark(identifier: string): this {
		if (this.#extents.has(identifier)) {
			this.#extents.delete(identifier);

			if (this.#enableUpdates) {
				this.#scheduleDomainUpdate();
			}
		}
		return this;
	}

	/**
	 * Debounce domain updates via microtask so multiple marks registering
	 * in the same tick (e.g. sorted + unsorted) settle before views are created.
	 */
	#scheduleDomainUpdate(): void {
		if (this.#domainUpdateScheduled) return;
		this.#domainUpdateScheduled = true;
		queueMicrotask(() => {
			this.#domainUpdateScheduled = false;
			this.updateDomainFromExtents();
		});
	}

	/**
	 * Update domain based on all categories from all marks
	 * Preserves order of first appearance
	 */
	updateDomainFromExtents(): void {
		if (!this.#enableUpdates) {
			return;
		}
		if (this.#extents.size === 0) {
			this.#domain = [];
			this._version++;
			return;
		}

		// Collect all valid categories across all extents
		const validCategories = new Set<string>();
		for (const categories of this.#extents.values()) {
			for (const cat of categories) validCategories.add(cat);
		}

		const allCategories: string[] = [];
		const seen = new Set<string>();

		// If a sort order exists, use it as the base (filtering to valid categories)
		if (this.#sortOrder) {
			for (const cat of this.#sortOrder) {
				if (validCategories.has(cat) && !seen.has(cat)) {
					seen.add(cat);
					allCategories.push(cat);
				}
			}
		}

		// Append remaining categories from extents (first-appearance order)
		for (const categories of this.#extents.values()) {
			for (const category of categories) {
				if (!seen.has(category)) {
					seen.add(category);
					allCategories.push(category);
				}
			}
		}

		// Check if domain order actually changed
		const oldDomain = this.#domain;
		const domainChanged =
			oldDomain.length !== allCategories.length ||
			allCategories.some((cat, i) => cat !== oldDomain[i]);

		if (!domainChanged) return;

		this.#domain = allCategories;
		this._version++;

		// Domain order changed — clear one-shot guard to force view recreation
		this.#viewsCreated.clear();
		// Notify GPU to re-render charts using this scale
		this.#registry?.invalidateChartsUsingScale(this);

		for (const table of this.#registeredTables) {
			this.#maybeCreateView(table);
		}
	}

	// =========================================================================
	// GPU DATA INTERFACE
	// =========================================================================

	/**
	 * Convert categorical data to indices for GPU processing
	 *
	 * Fast path: If data is already a Float32Array (from ViewManager-derived view),
	 * returns it directly without processing.
	 */
	processDataForGPU(
		categoryData: string[] | Float32Array,
		markId: string = 'unknown',
		{ suppressUnmappedWarning = false }: { suppressUnmappedWarning?: boolean } = {}
	): Float32Array {
		// Fast path: already Float32Array from derived view (zero-copy)
		if (categoryData instanceof Float32Array) {
			return categoryData;
		}

		const categoryMap = this.#categoryIndexMap;

		// Safety check - ensure map is valid
		if (!(categoryMap instanceof Map)) {
			console.error(`🚨 BandScale "${this.name}": categoryMap is not a Map:`, categoryMap);
			const fallbackMap = new Map<string, number>();
			this.effectiveDomain.forEach((category, index) => {
				fallbackMap.set(category, index);
			});
			return this.#processWithMap(categoryData, fallbackMap, markId, suppressUnmappedWarning);
		}

		return this.#processWithMap(categoryData, categoryMap, markId, suppressUnmappedWarning);
	}

	/**
	 * Helper method to process data with a given category map
	 */
	#processWithMap(
		categoryData: string[],
		categoryMap: Map<string, number>,
		markId: string,
		suppressUnmappedWarning: boolean = false
	): Float32Array {
		const unmappedCategories = new Set<string>();

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
		// (suppressed for topN marks where transient mismatches are expected during selection changes)
		if (unmappedCategories.size > 0 && !suppressUnmappedWarning) {
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
	 */
	getConfig(): BandGpuConfig {
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
	 */
	getBaseScale(axis: string, innerWidthOrHeight: number): ScaleBand<string> {
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
	 */
	updateScaleDomain(scale: { domain(d: string[]): unknown }): unknown {
		this._version; // Register svelte dependency
		scale.domain(this.effectiveDomain);
		return scale; // Return the function itself
	}

	/**
	 * Get the current domain (array of categories)
	 */
	domain(): string[] {
		return [...this.effectiveDomain];
	}

	get domainForReactivity(): string[] {
		this._version;
		return this.effectiveDomain;
	}

	/**
	 * Generate tick values for grid lines and axes.
	 *
	 * Since the GPU shader logic (scaleBandX) expects a Float32 index (0.0, 1.0, etc.),
	 * we must return the indices themselves, not the domain strings.
	 *
	 * The Axis component will then use tickFormat() to resolve index 0 -> "Label".
	 */
	getTicks(): Float32Array {
		this._version; // Register Svelte dependency
		const n = this.effectiveDomain.length;

		// Create the sequence 0..N-1
		const ticks = new Float32Array(n);
		for (let i = 0; i < n; i++) ticks[i] = i;

		return ticks;
	}

	/**
	 * Get a formatter to convert tick indices back to category labels.
	 * Used by Axis components to display the string label for the underlying GPU index.
	 */
	tickFormat(): (index: number) => string {
		// Capture domain reference
		const d = this.effectiveDomain;
		return (index: number) => d[index];
	}

	/**
	 * Calculate bandwidth for a given range size (CPU-side)
	 * Useful for axes, tooltips, etc.
	 */
	bandwidth(rangeSize: number): number {
		const config = this.getConfig();
		const n = config.categoryCount;

		if (n === 0) return 0;

		const step = rangeSize / Math.max(1, n - config.paddingInner + config.paddingOuter * 2);
		return step * (1 - config.paddingInner);
	}

	/**
	 * Calculate step size for a given range size (CPU-side)
	 */
	step(rangeSize: number): number {
		const config = this.getConfig();
		const n = config.categoryCount;

		if (n === 0) return 0;

		return rangeSize / Math.max(1, n - config.paddingInner + config.paddingOuter * 2);
	}

	// =========================================================================
	// POINTER / INVERSION
	// =========================================================================

	/**
	 * Convert screen position to band index.
	 * Returns the 0-based index of the band under the cursor, or null if
	 * no bands exist.
	 */
	invertScreenToData(
		screenVal: number,
		rangeSize: number,
		isYAxis: boolean = false
	): number | null {
		const config = this.getConfig();
		const n = config.categoryCount;
		if (n === 0) return null;

		const stepSize = this.step(rangeSize);
		if (stepSize === 0) return null;

		const offset = config.paddingOuter * stepSize;

		// GPU band scale renders Y categories bottom-to-top (matching D3),
		// so flip screen coordinate for Y axis inversion.
		const pos = isYAxis ? rangeSize - screenVal : screenVal;

		const bandIndex = Math.floor((pos - offset) / stepSize);

		// Clamp to valid range
		return Math.max(0, Math.min(n - 1, bandIndex));
	}

	// =========================================================================
	// LEGACY/COMPATIBILITY METHODS
	// =========================================================================

	/**
	 * Get positioning information for a category (for compatibility)
	 */
	getPosition(category: string): { current: number } {
		const index = this.effectiveDomain.indexOf(category);
		if (index === -1) return { current: 0 };

		return {
			current: index / Math.max(1, this.effectiveDomain.length - 1)
		};
	}

	/**
	 * Read-only view of the category→index mapping.
	 * Derived from the effective domain; updates reactively.
	 */
	get categoryIndexMap(): ReadonlyMap<string, number> {
		return this.#categoryIndexMap;
	}

	/**
	 * Get all mark extents (for debugging)
	 */
	getExtents(): Record<string, string[]> {
		return Object.fromEntries(this.#extents);
	}

	// No-op methods for API consistency with LinearScaleState
	applyZoomDomain(): void {
		return;
	}
	applyPanDomain(): void {
		return;
	}
	resetZoom(): void {
		return;
	}

	// =========================================================================
	// DEBUGGING
	// =========================================================================

	/**
	 * Get comprehensive debug information
	 */
	getDebugInfo(): Record<string, unknown> {
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
