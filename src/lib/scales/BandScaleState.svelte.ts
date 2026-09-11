// src/lib/scales/BandScaleState.svelte.ts

import { scaleBand } from 'd3-scale';
import type { ScaleBand } from 'd3-scale';
import type { DimValue, FieldIdentity } from '$lib/query-engine/categorical-identity';

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
 * It owns two spaces and the permutation between them: IDENTITY, the dim id a
 * channel carries, and DISPLAY, the slot a category occupies on the axis.
 * `displayOrder` is the permutation, `slotTarget` its inverse, `slotTable`
 * (= `slotCurrent`) what the shader actually reads, and `#domain` a value
 * projection for d3 and the axis. Target and current are equal until a spring
 * drives one toward the other (§9.5). See the IDENTITY <-> DISPLAY section for
 * the CPU-side translation.
 *
 * Key responsibilities:
 * - Domain management (unique categories from multiple marks)
 * - Identity <-> display translation, for the GPU and for CPU consumers
 * - D3 scale creation for axes and SVG components
 * - Configuration for GPU band scale calculations
 *
 * Features:
 * - Freeze/debounce support for performance
 * - Extent tracking from multiple marks
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
	name: string = $state('');
	type: string = 'band';
	ready: boolean = $state(false);
	_version: number = $state(0);

	// =========================================================================
	// SELECTION STATE
	// =========================================================================
	#activeValues: Set<DimValue> | null = $state(null); // null = all active, Set = only these active

	// =========================================================================
	// POINTER STATE
	// =========================================================================
	currentDataPoint: number | null = $state(null); // Band index under cursor (integer), or null

	// =========================================================================
	// DOMAIN STATE
	// =========================================================================
	#domain: DimValue[] = $state([]);
	// Ids when the scale has identity, values otherwise. See #toIds.
	#extents: Map<string, (DimValue | number)[]> = new Map();
	#sortOrder: (DimValue | number)[] | null = null;
	#explicitDomain: (DimValue | number)[] | null = null;
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
	 * The engine's id <-> value bijection for this scale's field (§9.4, §17.2).
	 * A live reference, never a copy: the dim appends when a second table
	 * registers the same field, and a snapshot taken at this scale's setup would
	 * be indexed past its end by ids from that table.
	 *
	 * Both directions come from here. The scale used to rebuild value -> id
	 * itself and self-heal on a length mismatch; that seam is gone.
	 */
	#identity: FieldIdentity | null = $state.raw(null);
	/**
	 * Whether #extents, #sortOrder and #explicitDomain hold ids rather than
	 * source values. Flips once, when identity is first adopted; see
	 * setIdentity. Cleared whenever the dim behind those ids goes away — emptied
	 * in place, or replaced by a fresh one after a reload — because the ids
	 * stored under it stop meaning anything at that point.
	 */
	#extentsEncoded: boolean = false;
	#registry: { invalidateChartsUsingScale(scale: unknown): void } | null = null;

	// =========================================================================
	// FREEZE/DEBOUNCE FUNCTIONALITY
	// =========================================================================
	#enableUpdates: boolean = $state(true);
	#frozenDomain: DimValue[] | null = null;

	// =========================================================================
	// D3 SCALE INSTANCE (Reused for performance)
	// =========================================================================
	#sharedScale: ScaleBand<DimValue> = scaleBand<DimValue>();

	// =========================================================================
	// DERIVED STATE
	// =========================================================================

	/**
	 * GPU state (derived) - for compatibility with coordinator
	 */
	gpuState: { domainMin: number; domainMax: number; p4: number; domainScale: number } = $derived.by(
		() => {
			// effectiveDomain.length, the same expression getConfig() uses for
			// categoryCount. This used to be the size of a category -> index Map
			// rebuilt on every domain change, which was the last consumer keeping
			// that Map alive once the band channel stopped carrying positions.
			// Two derivations of one number is one more than the GPU needs.
			const categoryCount = this.effectiveDomain.length;

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

	constructor(name: string, domain: DimValue[] = [], config: BandScaleConfig = {}) {
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

	get activeValues(): Set<DimValue> | null {
		return this.#activeValues;
	}

	setActiveValues(values: Iterable<DimValue>): void {
		this.#activeValues = values instanceof Set ? values : new Set(values);
	}

	clearActiveValues(): void {
		this.#activeValues = null;
	}

	isActive(value: DimValue): boolean {
		return this.#activeValues == null || this.#activeValues.has(value);
	}

	/**
	 * Marks the scale dead. Clears nothing, deliberately.
	 *
	 * ScaleRegistry calls this when a scale's chart-id usage hits zero, and then
	 * `_removeScaleFromStorage` drops it from the storage map — so the instance
	 * is unreachable through getOrCreateScale afterwards and a later request
	 * builds a fresh one. Its state therefore cannot leak into any future chart,
	 * which leaves wiping it with no upside and one large downside: components
	 * that still hold the reference lose whatever was registered on it, silently.
	 *
	 * That is not hypothetical. A faceted container obtains the facet scale,
	 * passes it to its cells, and stops being a chart itself — dropping usage to
	 * zero while every cell is still using the object. This wipe ate an explicit
	 * `fxDomain` that way, and the symptom was an ordering that simply did not
	 * apply (§25.3). Being dead and being unreferenced are different things, and
	 * only the registry's refcount claimed they were the same.
	 *
	 * What teardown genuinely needs to release — GPU config, ramp and palette
	 * slots — is released by the registry from `gpuSlots`, not here. A band
	 * scale holds none.
	 */
	destroy(): void {
		this.#destroyed = true;
	}

	/**
	 * True once the registry has torn this scale down. Use-after-destroy is
	 * reported rather than silently accepted; see #warnIfDestroyed.
	 */
	get isDestroyed(): boolean {
		return this.#destroyed;
	}

	#destroyed = false;
	#warnedAfterDestroy = false;

	/**
	 * Registering state on a destroyed scale means a component is holding a
	 * reference the registry has already written off — the shape that cost three
	 * stacked bugs in §25.3, every one of them silent. Warned once per scale:
	 * this can be reached from a render path.
	 */
	#warnIfDestroyed(what: string): void {
		if (!this.#destroyed || this.#warnedAfterDestroy) return;
		this.#warnedAfterDestroy = true;
		console.warn(
			`[BandScaleState] "${this.name}": ${what} after destroy(). The registry dropped this ` +
				`scale when its chart-id usage hit zero, but something still holds it — so it is ` +
				`invisible to the coordinator and a fresh instance will be built for the next ` +
				`getOrCreateScale. Register the holder's chart id, or hold the instance deliberately.`
		);
	}

	// =========================================================================
	// SQL ENCODING
	// =========================================================================

	/**
	 * The actual SQL column name in the source table.
	 * Defaults to this.name, but can be overridden (e.g. for facet scales
	 * where name is "__facet__species" but sourceField is "species").
	 */
	get sourceField(): string {
		return this.#sourceField ?? this.name;
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

	get effectiveDomain(): DimValue[] {
		return this.#enableUpdates ? this.#domain : this.#frozenDomain || this.#domain;
	}

	/**
	 * Adopt the engine's id -> value array for this field. Hold the reference.
	 */
	setIdentity(identity: FieldIdentity): void {
		this.#warnIfDestroyed('setIdentity');
		const previous = this.#identity;
		this.#identity = identity;

		// A reload empties the dim in place. The ids stored under it stop meaning
		// anything, so the next adoption must re-encode from values again.
		if (!identity.present) this.#extentsEncoded = false;

		// The other half of that reload, and the one the emptied-in-place check
		// cannot see: QueryEngine.reset() clears its map, so the mark re-running
		// setup gets a DIFFERENT FieldIdentity for the same field and arrives here
		// with it already populated. `present` is true on the way in and the flag
		// would stay set from before the reload, leaving pre-reset ids in #extents
		// to be range-checked against a new numbering they merely happen to fit —
		// wrong categories, no error. The signature is unambiguous: the object we
		// were holding has been emptied and a different one is replacing it. That
		// only happens across a reset, since identityFor() is stable per field.
		//
		// Dropped rather than translated, by clearing the flag and letting the
		// re-encode below treat the stale entries as VALUES: they miss and are
		// discarded, while an entry a re-running mark has already refreshed is a
		// real value and encodes correctly. That mixed state is the normal case —
		// a mark's domain fetch and its ensureColumns resume off the same
		// coalesced promise, so addMark can land on either side of this call.
		if (previous && previous !== identity && !previous.present) this.#extentsEncoded = false;

		// Re-encode anything registered BEFORE identity arrived. Marks race here:
		// a mark's domain fetch and its ensureColumns both resume off the same
		// coalesced promise, so addMark can run while hasIdentity is still false
		// and store values. Leaving those as strings makes updateDomainFromExtents
		// index the value array with a string and drop every category.
		//
		// Exactly once, on the transition. Every mark on a shared scale calls
		// this with the same live array, and after the first pass the stored
		// lists are already ids — re-encoding them as VALUES would look each id
		// up in the engine's map, miss, and drop the entire domain. The old "a number is an
		// id" heuristic made the repeat harmless by accident; #toIds no longer
		// guesses, so the transition has to be tracked.
		if (!this.#extentsEncoded && this.hasIdentity) {
			this.#extentsEncoded = true;
			for (const [id, cats] of this.#extents) {
				this.#extents.set(id, this.#toIds(cats, false));
			}
			if (this.#sortOrder) this.#sortOrder = this.#toIds(this.#sortOrder, false);
			if (this.#explicitDomain) this.#explicitDomain = this.#toIds(this.#explicitDomain, false);
		}

		this.updateDomainFromExtents();
		this._version++;
	}

	/** True when this scale's channel carries dim ids rather than positions. */
	get hasIdentity(): boolean {
		return this.#identity?.present ?? false;
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

	/**
	 * Normalize a caller's list to ids, dropping anything the dim does not know.
	 *
	 * `encoded` says which space the caller is in, because the two are NOT
	 * distinguishable by inspection. Treating any number as an id works only
	 * while dim values are strings; on a band axis over a numeric column —
	 * a year, a rating — a raw category value is a number too, and guessing
	 * reads it as an id, which is the wrong-data class of failure rather than a
	 * crash. Exactly one caller is in id space (the band channel of a scale
	 * with identity, in registerDataDerivedDomains); everything else — explicit
	 * domain props, the sort sidecar, the dim's own value list — supplies
	 * source values.
	 *
	 * Ids are range-checked against the value array. An id past its end would
	 * survive into #displayOrder but be dropped from #domain by the string
	 * projection, desynchronizing the permutation from the d3 band index space
	 * it has to agree with.
	 */
	#toIds(items: (DimValue | number)[], encoded: boolean): number[] {
		// No staleness check: both directions come from the engine's live
		// FieldIdentity, rewritten in one pass, so the map cannot lag the array.
		const identity = this.#identity;
		if (!identity) return [];

		const limit = identity.values.length;
		const out: number[] = [];
		const seen = new Set<number>();
		for (const item of items) {
			if (item == null) continue;
			const id = encoded ? (item as number) : identity.ids.get(item as string);
			if (id === undefined || !Number.isInteger(id) || id < 0 || id >= limit) continue;
			if (seen.has(id)) continue;
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
	 * Recomputes with the domain. An in-place append to the identity values alone
	 * does not invalidate it, but an append is always followed by the addMark
	 * that puts the new category into the domain, which does.
	 *
	 * This is `slotCurrent`, not `slotTarget` — what is on screen now, which
	 * during an animation is a fraction of the way between two orders. The two
	 * are equal at rest, and step 5 C1 has no spring yet, so they are equal
	 * always. See slotTarget.
	 */
	get slotTable(): Float32Array {
		return this.#slotCurrent;
	}

	/**
	 * Where each id is HEADED: the display slot it will occupy once the chart
	 * has settled, or -1 for an id that is not displayed. Rewritten whole on
	 * every reorder, by #rebuildSlotTable.
	 *
	 * Separate from slotCurrent because §9.5's animated reorder interpolates
	 * between them: a spring drives slotCurrent toward this, and the GPU reads
	 * slotCurrent. Introduced before the spring so the split can be verified
	 * while the two are still trivially equal — if anything moves on screen at
	 * C1, the plumbing is wrong, and that is far cheaper to find here than
	 * through a spring.
	 *
	 * Exposed for the spring and for tests, NOT as a lookup table: the same
	 * caution slotTable and displayOrder carry. Ask idAtSlot or categoryAt.
	 */
	get slotTarget(): Float32Array {
		return this.#slotTarget;
	}

	#slotTarget: Float32Array = new Float32Array(0);
	#slotCurrent: Float32Array = new Float32Array(0);
	/**
	 * Bumped on every slot-table rebuild. The GPU upload path compares this
	 * rather than the array contents, so an unchanged frame costs no writeBuffer
	 * — the slot table changes on reorder, not per frame.
	 *
	 * Once a spring writes slotCurrent per frame this has to be bumped per frame
	 * too, or the packer will upload the first frame of a transition and none of
	 * the rest. That belongs with the spring (C3), not here.
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
	categoryAt(channelValue: number): DimValue | undefined {
		if (!this.hasIdentity) return this.effectiveDomain[channelValue];
		return this.#identity!.values[channelValue];
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
	 *
	 * Writes slotTarget, then settles slotCurrent onto it. At C1 that settle is
	 * a copy — there is no spring — so the two never differ and nothing on
	 * screen changes. C3 replaces the copy with a retarget, and that is the only
	 * line in here that has to change.
	 */
	#rebuildSlotTable(): void {
		// Without identity the channel already carries a display position, so the
		// shader's lookup has to be a no-op. This is now only a TRANSIENT state —
		// the window before setIdentity arrives, and the all-NULL column that
		// renders nothing anyway — because an expression-backed axis gets a dim
		// like any other since `c55e719`. See §29.8: the pair of spaces this
		// branch serves outlived the reason for it.
		//
		// The identity permutation, not an empty table: empty would give the
		// scale offset 0 and another scale's slots.
		if (!this.hasIdentity) {
			const n = this.#domain.length;
			const target = this.#resizeSlots(n);
			for (let i = 0; i < n; i++) target[i] = i;
			this.#settleSlots();
			return;
		}

		// The plain inverse of displayOrder. No Map and no strings: displayOrder
		// is already ids, so this is an array walk. Everything not listed keeps
		// -1 — filtered out by a transform, or belonging to another table on a
		// shared scale.
		const target = this.#resizeSlots(this.#identity!.values.length);
		target.fill(-1);
		const order = this.#displayOrder;
		for (let slot = 0; slot < order.length; slot++) {
			const id = order[slot];
			if (id >= 0 && id < target.length) target[id] = slot;
		}

		this.#settleSlots();
	}

	/**
	 * Size both slot arrays to `length` and return the target for filling.
	 *
	 * Reuses the existing arrays when the length is unchanged, which is every
	 * reorder — the dim only grows when a second table appends. Callers always
	 * overwrite every entry they care about, so the stale contents of a reused
	 * target do not leak: the identity branch fills with -1 first, and the
	 * passthrough branch writes all n.
	 *
	 * Zero-copy is not the point here (a reorder is rare); not allocating two
	 * Float32Arrays per frame once a spring drives this IS, so the allocation
	 * decision is made here once rather than moved later.
	 */
	#resizeSlots(length: number): Float32Array {
		if (this.#slotTarget.length !== length) {
			this.#slotTarget = new Float32Array(length);
			this.#slotCurrent = new Float32Array(length);
		}
		return this.#slotTarget;
	}

	/**
	 * Put slotCurrent where slotTarget says, with no interpolation, and tell the
	 * upload path the table moved.
	 *
	 * This is the seam the spring replaces (C3): retarget instead of settle, and
	 * let the animation loop walk slotCurrent across and bump the version per
	 * frame. Until then a reorder is the same path with the spring snapped to 1,
	 * which is §3.1's point and the reason C1 must be invisible.
	 */
	#settleSlots(): void {
		this.#slotCurrent.set(this.#slotTarget);
		this.slotVersion++;
	}

	// =========================================================================
	// GPU READINESS
	// =========================================================================

	/**
	 * Check if the scale is ready for GPU processing.
	 *
	 * There used to be a fourth clause, `#categoryIndexMap instanceof Map`,
	 * which a field initializer made true before the constructor finished and
	 * which therefore never once decided this. Dropped with the Map.
	 */
	get isReadyForGPU(): boolean {
		return this.ready && this.effectiveDomain.length > 0 && this.#extents.size > 0;
	}

	// =========================================================================
	// DOMAIN MANAGEMENT
	// =========================================================================

	/**
	 * Add categorical data from a mark
	 */
	addMark(
		categories: (DimValue | number)[],
		identifier: string,
		{
			sorted = false,
			explicit = false,
			encoded = false
		}: { sorted?: boolean; explicit?: boolean; encoded?: boolean } = {}
	): this {
		this.#warnIfDestroyed('addMark');
		// Ids once identity exists, values otherwise. `encoded` says which space
		// `categories` is already in: the band channel of a scale with identity
		// carries dim ids straight from the data, everything else supplies source
		// values. Encoding happens here, once, at the boundary — not by decoding
		// to strings and re-encoding downstream.
		const uniqueCategories: (DimValue | number)[] = this.hasIdentity
			? this.#toIds(categories, encoded)
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
	 *
	 * Schedules a domain update, like every other writer of display-order state.
	 * It used to be the one that did not, which is why a reactive sort change
	 * did nothing at all: MarkLifecycleV2's sort effect re-ran the sidecar, the
	 * query returned the right categories in the right order, this stored them,
	 * and #domain, #displayOrder and the slot table all stayed where they were.
	 * §3.1 reported it as "the band re-sort path is not wired up"; PR #198 fixed
	 * the sidecar's SQL for computed axes without reaching this half.
	 *
	 * Not registering in #extents is the part this method is named for and is
	 * unchanged. Scheduling cannot leak a topN mark's full domain into its axis:
	 * updateDomainFromExtents intersects the preferred order against the
	 * categories actually in #extents, and that intersection is the protection.
	 */
	setSortOrder(categories: (DimValue | number)[]): void {
		this.#warnIfDestroyed('setSortOrder');
		// The sidecar selects the raw column, so these are always source values
		// (§15.6 item 2 would change that; until it does, never ids).
		this.#sortOrder = this.hasIdentity
			? this.#toIds(categories, false)
			: [...new Set(categories.filter((c) => c != null))];

		// Guarded like addMark and removeMark rather than relying on
		// updateDomainFromExtents' own #enableUpdates check. The duplication is
		// theirs and is noted in §32.7 as part of the funnel §29.8 should fold
		// these three writers into; matching them is the smaller change here.
		if (this.#enableUpdates) {
			this.#scheduleDomainUpdate();
		}
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
		const validCategories = new Set<DimValue | number>();
		for (const categories of this.#extents.values()) {
			for (const cat of categories) validCategories.add(cat);
		}

		const allCategories: (DimValue | number)[] = [];
		const seen = new Set<DimValue | number>();

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
		// source values for the consumers that need them: d3's scaleBand, axis
		// ticks, TextMark, the tooltip decode. Values are an output here, never
		// state — and they are not necessarily strings (see DimValue): a band axis
		// over an INTEGER column carries numbers all the way to scaleBand, which
		// looks its domain up by the raw value and misses on a stringified one.
		const values = this.#identity?.values ?? [];
		// Already ids: every path into #extents/#sortOrder/#explicitDomain
		// encodes at the boundary. This pass de-duplicates and range-checks.
		const orderedIds = this.hasIdentity ? this.#toIds(allCategories, true) : [];
		const resolved: DimValue[] = this.hasIdentity
			? orderedIds.map((id) => values[id]).filter((v): v is DimValue => v != null)
			: (allCategories as DimValue[]);

		const oldDomain = this.#domain;
		const domainChanged =
			oldDomain.length !== resolved.length || resolved.some((cat, i) => cat !== oldDomain[i]);

		// The permutation can change while its value projection does not — most
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

		// Notify GPU to re-render charts using this scale
		this.#registry?.invalidateChartsUsingScale(this);
	}

	// =========================================================================
	// GPU DATA INTERFACE
	// =========================================================================

	/**
	 * The band channel as GPU-ready floats.
	 *
	 * Zero-copy: the query selects the dim's id column CAST to REAL, so this
	 * arrives as a Float32Array of identity ids and is handed straight through.
	 *
	 * There used to be a second path here that mapped category STRINGS to
	 * domain positions, one row at a time, on every update — the per-row JS pass
	 * §3 exists to delete. Nothing produces strings on a band channel any more:
	 * #inlineIdentityColumns always selects the id column, and an axis it cannot
	 * dim is reported at setup rather than silently falling back. Strings here
	 * now mean a real defect upstream, so they are reported rather than mapped.
	 */
	processDataForGPU(
		categoryData: DimValue[] | Float32Array,
		markId: string = 'unknown'
	): Float32Array {
		if (categoryData instanceof Float32Array) return categoryData;

		console.error(
			`[${markId}] BandScale "${this.name}" received ${categoryData.length} raw category ` +
				`values where identity ids were expected. The query should be selecting this ` +
				`axis's __dplot_*_idx column; nothing will render.`
		);
		// -1 is the no-identity sentinel: scaleBand discards it before the slot
		// lookup, so this draws nothing rather than something wrong.
		return new Float32Array(categoryData.length).fill(-1);
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
	getBaseScale(axis: string, innerWidthOrHeight: number): ScaleBand<DimValue> {
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
	updateScaleDomain(scale: { domain(d: DimValue[]): unknown }): unknown {
		this._version; // Register svelte dependency
		scale.domain(this.effectiveDomain);
		return scale; // Return the function itself
	}

	/**
	 * Get the current domain (array of categories)
	 */
	domain(): DimValue[] {
		return [...this.effectiveDomain];
	}

	get domainForReactivity(): DimValue[] {
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
	 *
	 * Returns a STRING, unlike the rest of the value surface: this is the one
	 * consumer that is genuinely rendering text rather than feeding a lookup, so
	 * a numeric or bigint category is coerced here and nowhere else. Doing it any
	 * earlier is what would break d3's domain lookup (see DimValue).
	 */
	tickFormat(): (index: number) => string {
		// Capture domain reference
		const d = this.effectiveDomain;
		return (index: number) => String(d[index] ?? '');
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
	 * Calculate step size for a given range size (CPU-side) — the band pitch,
	 * centre to centre, of which `bandwidth` is the drawn fraction.
	 *
	 * d3 spells this `step()`, and so did this class until step 5 C2 needed that
	 * name for the animation interface `GPUCoordinator` drives, where `step()`
	 * means "advance physics by one fixed timestep" and takes no arguments. Two
	 * methods cannot share the name and the collision is silent — an arity
	 * mismatch, not a type error — so the geometry one moved. It pairs with
	 * `bandwidth(rangeSize)` either way.
	 */
	stepWidth(rangeSize: number): number {
		const config = this.getConfig();
		const n = config.categoryCount;

		if (n === 0) return 0;

		return rangeSize / Math.max(1, n - config.paddingInner + config.paddingOuter * 2);
	}

	// =========================================================================
	// ANIMATION INTERFACE (step 5 C2)
	// =========================================================================
	//
	// GPUCoordinator's fixed-timestep loop drives every scale in
	// #animatedScalesArray through exactly four methods — step(),
	// updateRenderState(dt), isAtRest() and _markAtRest() — and evicts a scale
	// the moment isAtRest() returns true (GPUCoordinator:975).
	//
	// This implements them and NOTHING REGISTERS YET. §9.5's spring is C3, and
	// registering here would add a state where "nothing happens on screen" is
	// ambiguous between "the loop ran and correctly did nothing" and "the loop
	// never saw this scale" — the two are indistinguishable without a frame
	// counter, and a checkpoint you cannot read is not a checkpoint. C3 makes
	// one change that both registers and interpolates, so the first frame of
	// motion proves the registration too.
	//
	// What C3 must add beyond a spring:
	//   - call addAnimatingScale(this) when a retarget leaves the two slot
	//     arrays disagreeing, and let the eviction sweep remove it again;
	//   - populate _affectedChartsArray, which is what the loop redraws per
	//     frame. This class currently pushes redraws through
	//     #registry.invalidateChartsUsingScale (see updateDomainFromExtents),
	//     which is a per-reorder call and not a per-frame one;
	//   - bump slotVersion inside updateRenderState, or the packer uploads the
	//     first frame of a transition and none of the rest.

	#isAnimating: boolean = false;

	/** True while a transition is in flight. Read by tests and by C3. */
	get isAnimating(): boolean {
		return this.#isAnimating;
	}

	/**
	 * Advance physics by one fixed timestep. Called at a fixed rate, not per
	 * frame, so it must not touch render state.
	 *
	 * Empty until C3: there is no spring, so there is no physics to advance.
	 */
	step(): void {}

	/**
	 * Update render state with extrapolation, once per frame.
	 *
	 * Empty until C3. When it fills in, it writes slotCurrent from the spring
	 * and bumps slotVersion — the array is mutated in place (C1's #resizeSlots
	 * reuses it), so the version is the only thing the packer can compare.
	 */
	updateRenderState(_extrapolationDt: number): void {}

	/**
	 * Whether the loop can stop driving this scale.
	 *
	 * Unconditionally true, and load-bearing rather than a placeholder: with no
	 * spring, a scale that ever got registered must fall straight back out on
	 * the next sweep instead of pinning the animation loop on forever. A chart
	 * that redraws every frame while looking perfectly correct is the failure
	 * this guards, and it is invisible except in a profiler.
	 */
	isAtRest(): boolean {
		return true;
	}

	/** Called by GPUCoordinator when this scale stops animating. */
	_markAtRest(): void {
		this.#isAnimating = false;
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

		const stepSize = this.stepWidth(rangeSize);
		if (stepSize === 0) return null;

		const offset = config.paddingOuter * stepSize;

		// GPU band scale renders Y categories bottom-to-top (matching D3),
		// so flip screen coordinate for Y axis inversion.
		const pos = isYAxis ? rangeSize - screenVal : screenVal;

		const bandIndex = Math.floor((pos - offset) / stepSize);

		// Clamp to valid range
		return Math.max(0, Math.min(n - 1, bandIndex));
	}

	/**
	 * Get all mark extents (for debugging). Ids when the scale has identity.
	 */
	getExtents(): Record<string, (DimValue | number)[]> {
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

			// Identity <-> display. Replaces the old category -> index map, which
			// described a channel encoding this scale no longer uses: with
			// identity the channel carries a dim id, and these two are what
			// resolve it — displayOrder[slot] is the id shown there,
			// slotCurrent[id] its position, and they are inverses. Dumping the
			// domain alone hides a desync between them.
			//
			// Both slot arrays, because the interesting failure once a spring
			// drives this is precisely that they disagree when they should not:
			// equal at rest, and slotCurrent a fraction of the way to slotTarget
			// mid-transition. One of them alone cannot show that.
			hasIdentity: this.hasIdentity,
			identityCount: this.#identity?.values.length ?? 0,
			displayOrder: Array.from(this.#displayOrder),
			slotCurrent: Array.from(this.#slotCurrent),
			slotTarget: Array.from(this.#slotTarget),

			// GPU state
			gpuState: this.gpuState
		};
	}
}
