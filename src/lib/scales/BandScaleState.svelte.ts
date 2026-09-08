// src/lib/scales/BandScaleState.svelte.ts

import { scaleBand } from 'd3-scale';
import type { ScaleBand } from 'd3-scale';
import { buildCaseExpression, bandIndexColumn } from '$lib/sql/case-expression';

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
	// Ids when the scale has identity, values otherwise. See #toIds.
	#extents: Map<string, (string | number)[]> = new Map();
	#sortOrder: (string | number)[] | null = null;
	#explicitDomain: (string | number)[] | null = null;
	#domainUpdateScheduled: boolean = false; // Microtask debounce for updateDomainFromExtents

	// =========================================================================
	// CONFIGURATION (D3 band scale parameters)
	// =========================================================================
	#padding: number = 0.1;
	#paddingInner: number | null = null;
	#paddingOuter: number | null = null;
	#align: number = 0.5;
	#sourceField: string | null = null; // Actual SQL column name (defaults to this.name if null)
	/**
	 * The engine's id -> value array for this scale's field (§9.4). A live
	 * reference, never a copy: the dim appends when a second table registers the
	 * same field, and a snapshot taken at this scale's setup would be indexed
	 * past its end by ids from that table.
	 */
	#identityValues: string[] = $state.raw([]);
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
		this.#explicitDomain = null;
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
		return bandIndexColumn(this.sourceField);
	}

	/**
	 * Inline CASE expression mapping domain values to 0-based indices.
	 * Used by MarkLifecycleV2 to inline in the query SELECT (no ViewManager).
	 * Reactive — recomputes when effectiveDomain changes (e.g. band reorder).
	 */
	get caseExpression(): string {
		return buildCaseExpression(this.sourceField, this.effectiveDomain, {
			oneBased: false
		});
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
	}

	#unregisterFromViewManager(): void {
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

	/**
	 * Adopt the engine's id -> value array for this field. Hold the reference.
	 */
	setIdentityValues(values: string[]): void {
		this.#identityValues = values;
		// The one encode table, built here rather than per reorder. Marks
		// re-adopt after the dim appends, so this stays in step with growth.
		this.#refreshIdOf();

		// Re-encode anything registered BEFORE identity arrived. Marks race here:
		// a mark's domain fetch and its ensureColumns both resume off the same
		// coalesced promise, so addMark can run while hasIdentity is still false
		// and store values. Leaving those as strings makes updateDomainFromExtents
		// index the value array with a string and drop every category.
		for (const [id, cats] of this.#extents) {
			this.#extents.set(id, this.#toIds(cats));
		}
		if (this.#sortOrder) this.#sortOrder = this.#toIds(this.#sortOrder);
		if (this.#explicitDomain) this.#explicitDomain = this.#toIds(this.#explicitDomain);

		this.updateDomainFromExtents();
		this._version++;
	}

	/**
	 * value -> id. A cache over #identityValues, which is a LIVE array that grows
	 * in place when the dim appends — so this must never be treated as a
	 * snapshot. #toIds refreshes it whenever the array has outgrown it.
	 *
	 * Cheap to keep correct for the same reason the value array is: the dim is
	 * append-only and never renumbers, so a stale map is only ever *short*, and
	 * length is a sufficient staleness test.
	 */
	#idOf: Map<string, number> = new Map();

	/** True when this scale's channel carries dim ids rather than positions. */
	get hasIdentity(): boolean {
		return this.#identityValues.length > 0;
	}

	/**
	 * Ids in display order — the permutation the whole design is about (§9.5).
	 * Primary state: #domain is derived from it, and the slot table is its
	 * inverse. Empty for a scale without identity, which stays on strings.
	 *
	 * Exposed for the animated reorder (§13 step 5) and for tests, NOT as a
	 * lookup table. To answer "which id is displayed at this slot" call
	 * idAtSlot, and to answer "which category is this channel value" call
	 * categoryAt: both handle the no-identity case, which indexing this array
	 * by hand does not. Consumers that indexed the raw arrays themselves are
	 * how the tooltip came to compare a slot against an id.
	 */
	get displayOrder(): Int32Array {
		return this.#displayOrder;
	}

	#displayOrder: Int32Array = new Int32Array(0);

	#refreshIdOf(): void {
		const values = this.#identityValues;
		this.#idOf = new Map();
		for (let i = 0; i < values.length; i++) this.#idOf.set(values[i], i);
	}

	/** Encode a mix of values and ids to ids. Unknown values are dropped. */
	#toIds(items: (string | number)[]): number[] {
		// Refresh before use: a mark's addMark can land between another mark's
		// dim append and its setIdentityValues, and an id missing from a stale map
		// is silently dropped rather than erroring — a category that vanishes from
		// multi-table charts only, and only on some interleavings.
		if (this.#idOf.size !== this.#identityValues.length) this.#refreshIdOf();

		const out: number[] = [];
		const seen = new Set<number>();
		for (const item of items) {
			if (item == null) continue;
			const id = typeof item === 'number' ? item : this.#idOf.get(item);
			if (id === undefined || id < 0 || seen.has(id)) continue;
			seen.add(id);
			out.push(id);
		}
		return out;
	}

	/**
	 * Display slot per identity id: `slotTable[id]` is the position this
	 * category occupies on the axis, or -1 when it is not currently displayed.
	 *
	 * This is the indirection that lets identity and position be different
	 * things (§9.5). The query supplies a stable id that never changes when the
	 * chart reorders; this table says where that id currently sits. A reorder
	 * rewrites the table and leaves the SQL, the vertex buffers and the preagg
	 * cubes alone.
	 *
	 * -1 covers two cases deliberately given one sentinel: an id filtered out by
	 * a category-reducing transform, and an id belonging to another table on a
	 * shared scale. Both must be discarded by the consumer, and -1 is already
	 * the "no identity" sentinel (§3.2), so there is one comparison rather than
	 * two.
	 *
	 * Recomputes with the domain. An in-place append to #identityValues alone
	 * does not invalidate it, but an append is always followed by the addMark
	 * that puts the new category into the domain, which does.
	 */
	get slotTable(): Float32Array {
		return this.#slotTable;
	}

	#slotTable: Float32Array = new Float32Array(0);
	/**
	 * Bumped on every slot-table rebuild. The GPU upload path compares this
	 * rather than the array contents, so an unchanged frame costs no writeBuffer
	 * — the slot table changes on reorder, not per frame.
	 */
	slotVersion: number = 0;

	// -------------------------------------------------------------------------
	// IDENTITY <-> DISPLAY, FOR CPU CONSUMERS
	// -------------------------------------------------------------------------
	//
	// The GPU crosses this boundary through slotTable, in the shader. Everything
	// on the CPU side — tooltips, hit-testing, legends, toggles — crosses it
	// here, so that the rule "with identity a channel value is a dim id, without
	// identity it is already a display position" is stated once, by the object
	// that owns both spaces, rather than re-derived by each consumer.
	//
	// Both degrade to the pre-identity behaviour when hasIdentity is false, so a
	// caller never has to ask which kind of scale it is holding.

	/**
	 * Identity id currently displayed at `slot`, or null when the slot holds no
	 * category. Use this to compare a display position — what invertScreenToData
	 * returns — against a channel value.
	 *
	 * Without identity a channel value IS the display position, so the slot
	 * passes through unchanged.
	 */
	idAtSlot(slot: number): number | null {
		if (!this.hasIdentity) {
			return slot >= 0 && slot < this.effectiveDomain.length ? slot : null;
		}
		const id = this.#displayOrder[slot];
		return id == null || id < 0 ? null : id;
	}

	/**
	 * Source value for a channel value — the decode side of the encode the query
	 * performs. A dim id with identity, a display position without.
	 *
	 * Reads the live domain rather than any snapshot: a caller that captured the
	 * domain once holds display order as of that moment, and reordering it is
	 * the entire point of the identity split (§9.4's warning, which has already
	 * been rediscovered twice).
	 *
	 * effectiveDomain, not #domain, so a frozen scale decodes to what is on
	 * screen. The two coincide today — updateDomainFromExtents returns early
	 * while frozen, so neither the domain nor displayOrder moves — but the
	 * display pipeline reads effectiveDomain, and this must not drift from it.
	 */
	categoryAt(channelValue: number): string | undefined {
		if (!this.hasIdentity) return this.effectiveDomain[channelValue];
		return this.#identityValues[channelValue];
	}

	/**
	 * Rebuilt imperatively rather than as a $derived, for two reasons. Its
	 * consumer is the per-frame GPU upload path, which is a plain rAF callback
	 * and not a reactive context, so lazy invalidation cannot be relied on
	 * there. And its inputs change on reorder — rarely — while a $derived read
	 * per frame invites recomputing a Map every frame for no reason.
	 *
	 * Called from the two places its inputs move: a domain change and adopting a
	 * new identity value array.
	 */
	#rebuildSlotTable(): void {
		// Without identity the channel already carries a display position — an
		// expression-backed axis CASE-inlines one — so the shader's lookup has to
		// be a no-op. The identity permutation, not an empty table: empty would
		// give the scale offset 0 and another scale's slots.
		if (!this.hasIdentity) {
			const n = this.#domain.length;
			const passthrough = new Float32Array(n);
			for (let i = 0; i < n; i++) passthrough[i] = i;
			this.#slotTable = passthrough;
			this.slotVersion++;
			return;
		}

		// The plain inverse of displayOrder. No Map and no strings: displayOrder
		// is already ids, so this is an array walk. Everything not listed keeps
		// -1 — filtered out by a transform, or belonging to another table on a
		// shared scale.
		const table = new Float32Array(this.#identityValues.length);
		table.fill(-1);
		const order = this.#displayOrder;
		for (let slot = 0; slot < order.length; slot++) {
			const id = order[slot];
			if (id >= 0 && id < table.length) table[id] = slot;
		}

		this.#slotTable = table;
		this.slotVersion++;
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
		categories: (string | number)[],
		identifier: string,
		{ sorted = false, explicit = false }: { sorted?: boolean; explicit?: boolean } = {}
	): this {
		// Ids once identity exists, values otherwise. Callers may pass either:
		// topN hands over ids straight from the data, an explicit domain prop
		// hands over the user's strings. Encoding happens here, once, at the
		// boundary — not by decoding to strings and re-encoding downstream.
		const uniqueCategories: (string | number)[] = this.hasIdentity
			? this.#toIds(categories)
			: [...new Set(categories.filter((c) => c != null))];

		this.#extents.set(identifier, uniqueCategories);

		if (explicit) {
			this.#explicitDomain = uniqueCategories;
		} else if (sorted) {
			this.#sortOrder = uniqueCategories;
		}

		if (this.#enableUpdates) {
			this.#scheduleDomainUpdate();
		}

		return this;
	}

	/**
	 * Set the preferred sort order without registering categories in #extents.
	 * Used by topN marks: the sort sidecar runs against the full dataset but
	 * the domain should only contain post-transform categories.
	 */
	setSortOrder(categories: (string | number)[]): void {
		this.#sortOrder = this.hasIdentity
			? this.#toIds(categories)
			: [...new Set(categories.filter((c) => c != null))];
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
			this.#displayOrder = new Int32Array(0);
			this.#rebuildSlotTable();
			this._version++;
			return;
		}

		// Collect all valid categories across all extents
		const validCategories = new Set<string | number>();
		for (const categories of this.#extents.values()) {
			for (const cat of categories) validCategories.add(cat);
		}

		const allCategories: (string | number)[] = [];
		const seen = new Set<string | number>();

		// Priority 1: Explicit domain from mark prop (highest specificity)
		// Priority 2: Sort order from sidecar query
		const preferredOrder = this.#explicitDomain ?? this.#sortOrder;
		if (preferredOrder) {
			for (const cat of preferredOrder) {
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

		// allCategories is ids when the scale has identity. displayOrder is that
		// list verbatim — the permutation — and #domain is its projection into
		// strings for the consumers that need them: d3's scaleBand, axis ticks,
		// TextMark, the tooltip decode. Strings are an output here, never state.
		const values = this.#identityValues;
		// #toIds is a no-op on a list that is already ids, and rescues one that
		// is not — a mark registering values after identity exists, say.
		const orderedIds = this.hasIdentity ? this.#toIds(allCategories) : [];
		const resolved: string[] = this.hasIdentity
			? orderedIds.map((id) => values[id]).filter((v): v is string => v != null)
			: (allCategories as string[]);

		const oldDomain = this.#domain;
		const domainChanged =
			oldDomain.length !== resolved.length || resolved.some((cat, i) => cat !== oldDomain[i]);

		// The permutation can change while its string projection does not — most
		// obviously when identity arrives after the domain has already settled,
		// which is the live ordering during setup. Guarding on the strings alone
		// left displayOrder empty and the slot table stale.
		const oldOrder = this.#displayOrder;
		const orderChanged =
			this.hasIdentity &&
			(oldOrder.length !== orderedIds.length || orderedIds.some((id, i) => id !== oldOrder[i]));

		if (!domainChanged && !orderChanged) return;

		this.#domain = resolved;
		this.#displayOrder = this.hasIdentity ? Int32Array.from(orderedIds) : new Int32Array(0);
		this.#rebuildSlotTable();
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
					// -1 = no identity, 0+ = valid categories. Matches
					// buildCaseExpression's ELSE -1 (case-expression.ts) and
					// ColorScaleState.processDataForGPU, so the SQL and JS paths
					// agree. Returning 0 here drew unmapped rows stacked on top of
					// the first real category. scaleBand discards negatives.
					return -1;
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
	 * Get all mark extents (for debugging). Ids when the scale has identity.
	 */
	getExtents(): Record<string, (string | number)[]> {
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
