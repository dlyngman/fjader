// src/lib/scales/BandScaleState.svelte.ts

import { scaleBand } from 'd3-scale';
import type { ScaleBand } from 'd3-scale';
import type { DimValue, FieldIdentity } from '$lib/query-engine/categorical-identity';
import { Spring } from '$lib/animation';

/**
 * Driver constants, taken from ParallelAxisReorder, which is the same
 * interaction: a permutation settling into place.
 *
 * The precision is in NORMALISED t, not slot space — 0.0005 of a whole
 * transition. That is the better place for it: a per-slot threshold means
 * something different for a one-band nudge than for a full reorder, while a
 * threshold on t is the same fraction of the journey either way.
 */
const REORDER_STIFFNESS = 120;
const REST_PRECISION = 0.0005;

interface BandScaleConfig {
	padding?: number;
	paddingInner?: number | null;
	paddingOuter?: number | null;
	align?: number;
	sourceField?: string | null;
	registry?: { invalidateChartsUsingScale(scale: unknown): void } | null;
	/**
	 * How a reorder reaches the animation loop (step 5 C3). Structurally typed
	 * rather than importing GPUCoordinator, which would be a cycle: the
	 * coordinator's ScaleInstance is what this class implements.
	 */
	gpuCoordinator?: {
		addAnimatingScale(scale: unknown): void;
		removeAnimatingScale?(scale: unknown): void;
	} | null;
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
 * projection for d3 and the axis.
 *
 * A transition is `slotCurrent = mix(slotFrom, slotTo, t)` with ONE spring
 * driving `t` for the whole scale, so everything in flight arrives together.
 * `slotTo` is the animated destination and `slotTarget` what the scale says;
 * they differ exactly for the ids on their way out, which hold a real slot until
 * they land. See the IDENTITY <-> DISPLAY section for the CPU-side translation.
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
	#gpuCoordinator: {
		addAnimatingScale(scale: unknown): void;
		removeAnimatingScale?(scale: unknown): void;
	} | null = null;

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
		this.#gpuCoordinator = config.gpuCoordinator ?? null;

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
	 * during an animation is a fraction of the way between two orders.
	 *
	 * Computed ON DEMAND rather than maintained. The GPU no longer reads it:
	 * it reads slotFrom, slotTo and t and does the mix in the vertex stage, so
	 * a per-frame walk of every id existed only to produce a value nothing read
	 * every frame. It is still the honest answer to "where is everything now",
	 * for the fold, for tests, and for the axis labels that will need it.
	 */
	/**
	 * How many ids the slot arrays hold — the packer's count header.
	 *
	 * Exists so the packer never reads `slotTable`, whose getter folds
	 * `mix(from, to, t)` over the whole dim. The packer runs every frame and the
	 * GPU does that mix itself now, so reading it there was an O(dim) walk per
	 * frame producing a number nothing consumed.
	 */
	get slotCount(): number {
		return this.#slotTarget.length;
	}

	get slotTable(): Float32Array {
		if (this.#currentDirty) {
			this.#writeCurrent(this.#renderT);
			this.#currentDirty = false;
		}
		return this.#slotCurrent;
	}

	/**
	 * The two halves the GPU interpolates between, and where along it we are.
	 *
	 * These are what the packer uploads: `from` and `to` change on a retarget,
	 * `t` every frame — which is the whole point, since t is four bytes and the
	 * table is as many as there are ids.
	 */
	get slotFrom(): Float32Array {
		return this.#slotFrom;
	}

	get slotTo(): Float32Array {
		return this.#slotTo;
	}

	/** Extrapolated for the frame being drawn, not the last physics step. */
	get t(): number {
		return this.#renderT;
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
	 * Where the driver is for the frame being drawn — extrapolated ahead of the
	 * simulated state, and clamped, since a read ahead of the last step can
	 * cross 1 near the end of a transition.
	 */
	#renderT: number = 1;
	/** slotCurrent is stale until someone asks for it. */
	#currentDirty: boolean = false;
	/**
	 * ONE spring for the whole scale, driving a normalised `t` from 0 to 1
	 * across every id at once — not one spring per category.
	 *
	 * A spring is per DATA UPDATE, not per category: everything that moves does
	 * so because the same result landed. Sharing `t` is the feature rather than
	 * a compromise — ids have different displacements, so one clock moves them
	 * at proportionally different speeds and makes them ARRIVE TOGETHER, where
	 * independent springs finish raggedly. Per-id timing, where it is wanted, is
	 * a static phase buffer over this same `t`, not N springs.
	 *
	 * It also makes isAtRest() one comparison instead of a scan, and gives a
	 * departing id a single moment at which to be retired.
	 *
	 * The costs, stated rather than hidden: `t` is normalised, so settle
	 * DURATION is independent of distance — a one-band correction takes as long
	 * as a full reorder — and a mid-flight retarget is continuous in `t` but not
	 * in world space. Both are the other face of arriving together.
	 */
	#driver: Spring = new Spring(1, REORDER_STIFFNESS, REST_PRECISION);
	/**
	 * Where each id's current transition STARTED, id-indexed.
	 *
	 * Rewritten by the fold on every retarget: a result landing mid-flight must
	 * continue from where things actually are, so current position becomes the
	 * new `from` before `t` resets to 0.
	 */
	#slotFrom: Float32Array = new Float32Array(0);
	/**
	 * Where each id's current transition is GOING — the animated destination,
	 * which for a leaver is its gateway rather than the hidden sentinel.
	 *
	 * Distinct from #slotTarget, which is what the scale SAYS: -1 for anything
	 * not displayed. The two disagree about a departing id on purpose, for the
	 * length of its exit, and #exiting is what records that.
	 */
	#slotTo: Float32Array = new Float32Array(0);
	/**
	 * 1 for an id that is travelling OUT — no longer displayed, but still on
	 * screen until its spring reaches the far end (§12 Q1, C4).
	 *
	 * A leaver cannot simply take -1 as its target: -1 is the not-displayed
	 * sentinel and the shader discards it before the slot lookup, so the bar
	 * would vanish on the frame the reorder landed. It has to hold a REAL slot
	 * for the whole exit, which means slotCurrent and slotTarget disagree about
	 * it on purpose, and this array is what says so.
	 */
	#exiting: Uint8Array = new Uint8Array(0);
	/**
	 * False until the first layout with anything in it.
	 *
	 * The opening frame of a chart is every category entering at once, and
	 * animating that would slide every bar in from off-axis on load. Only
	 * categories arriving AFTER a chart exists are entrances worth showing.
	 */
	#hasLaidOut: boolean = false;
	/**
	 * Which value space the slot arrays are currently indexed in — true for dim
	 * ids, false for domain positions. Not the same question as `hasIdentity`,
	 * which is about NOW; this is about what is already in the arrays, and the
	 * gap between the two is the boundary #rebuildSlotTable has to notice.
	 */
	#slotsHaveIdentity: boolean = false;
	/**
	 * The dim id of this axis's synthetic "Other" bucket, or null when the mark
	 * has none. Set by the lifecycle alongside the reservation (§16.9).
	 *
	 * It is where entrances and exits come from and go to when it exists,
	 * because with an Other bucket that is literally true: a category dropping
	 * out of the top N does not leave the chart, its value moves INTO Other, and
	 * one climbing in is value coming back OUT of it. Travelling past the end of
	 * the axis would say the opposite — that it went somewhere else.
	 */
	#otherId: number | null = null;

	/**
	 * Tell this axis which id is its Other bucket, if any.
	 *
	 * An id that is never displayed is INERT here, and that is a guarantee rather
	 * than a coincidence: the gateway is read from the slot TABLE, so an Other
	 * that no row carries holds -1 and the gateway falls back to the far end. The
	 * lifecycle reserves an Other id for every categorical axis of a mark rather
	 * than re-deriving which one topN picked, so the axes topN did not pick get
	 * one too — and this is why that costs nothing.
	 */
	setOtherId(id: number | null): void {
		this.#otherId = id;
	}
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
		// The slot arrays are indexed by DIM ID with identity and by DOMAIN
		// POSITION without it, so crossing that boundary changes what every entry
		// means. Carrying slotCurrent across it hands the id space a set of
		// positions that were never id-indexed, and #resizeSlots cannot see the
		// difference: the two spaces are usually the same LENGTH, so its
		// unchanged-length fast path keeps the whole stale array.
		//
		// That made the first real layout of a chart look like a reorder — every
		// id "already on screen" at a meaningless slot, everything retargeted, the
		// scale registered with the loop — and the bars slid in from nowhere.
		// #hasLaidOut did not protect it, because the passthrough layout had
		// already set it. Both halves are fixed by treating the boundary as the
		// start of a new scale: drop the state, and let the identity layout be a
		// first layout, which snaps.
		//
		// A dim that merely GROWS is not this case (§16.9's Other reservation
		// appends one). The id space is unchanged there, existing ids keep their
		// paths, and #resizeSlots' copy is exactly right.
		if (this.#slotsHaveIdentity !== this.hasIdentity) {
			this.#slotsHaveIdentity = this.hasIdentity;
			this.#discardSlotState();
		}

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
			this.#retargetSlots(n);
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

		this.#retargetSlots(order.length);
	}

	/**
	 * Size every id-indexed slot array to `length`, returning the target for
	 * filling.
	 *
	 * Reuses everything when the length is unchanged, which is every reorder —
	 * the dim only grows when a second table appends. Callers always overwrite
	 * every target entry they care about, so stale contents do not leak: the
	 * identity branch fills with -1 first, and the passthrough branch writes all
	 * n.
	 *
	 * On a grow, existing ids KEEP where they currently are and keep the path
	 * they are on, so a dim append mid-transition does not teleport the
	 * categories already on screen. New ids start at -1, which is "not
	 * displayed" and makes them enter by the same route as any other newcomer.
	 */
	/**
	 * Forget everything positional, so the next layout is a first layout.
	 *
	 * Lengths go to zero rather than being refilled: that is what stops
	 * #resizeSlots' unchanged-length fast path from preserving the arrays it is
	 * being asked to throw away. #hasLaidOut goes with them, because "has this
	 * scale laid out before" is only meaningful about the space it laid out in.
	 */
	#discardSlotState(): void {
		this.#slotTarget = new Float32Array(0);
		this.#slotCurrent = new Float32Array(0);
		this.#slotFrom = new Float32Array(0);
		this.#slotTo = new Float32Array(0);
		this.#exiting = new Uint8Array(0);
		this.#driver.set(1);
		this.#hasLaidOut = false;
	}

	#resizeSlots(length: number): Float32Array {
		if (this.#slotTarget.length === length) return this.#slotTarget;

		const current = new Float32Array(length);
		// -1 is the not-displayed sentinel, and it is the right INITIAL value:
		// before the first layout nothing is on screen, so every id is entering.
		// Zero would instead mean "everything is at slot 0", and the first paint
		// would animate outward from there.
		current.fill(-1);
		const keep = Math.min(this.#slotCurrent.length, length);
		current.set(this.#slotCurrent.subarray(0, keep), 0);

		// from and to carry across a grow for the same reason current does: an id
		// already in flight keeps the path it is on.
		const from = new Float32Array(length);
		from.fill(-1);
		from.set(this.#slotFrom.subarray(0, keep), 0);

		const to = new Float32Array(length);
		to.fill(-1);
		to.set(this.#slotTo.subarray(0, keep), 0);

		const exiting = new Uint8Array(length);
		exiting.set(this.#exiting.subarray(0, keep), 0);
		this.#exiting = exiting;

		this.#slotTarget = new Float32Array(length);
		this.#slotCurrent = current;
		this.#slotFrom = from;
		this.#slotTo = to;
		return this.#slotTarget;
	}

	/**
	 * Point every spring at its new slot, and wake the animation loop if any of
	 * them has somewhere to go.
	 *
	 * **Transitions involving -1 snap rather than spring**, and that is C3's
	 * deliberate limit, not an oversight. -1 means "not displayed", so a spring
	 * from slot 3 to -1 would slide the leaving bar left through every one of its
	 * neighbours before the shader finally discarded it below zero, and an
	 * entering one would slide in from off-axis the same way. Neither is a
	 * designed behaviour; §12 Q1 is the open question of what the designed one
	 * is, and it needs answering with a chart in front of you rather than here.
	 *
	 * The consequence, which is what `test/band-race` chart 2 exists to show: a
	 * pure reorder animates, and a category entering or leaving POPS. That is
	 * the expected C3 result, and "fixing" it by inventing semantics here is
	 * exactly what the checkpoint is meant to prevent.
	 */
	#retargetSlots(count: number): void {
		// Materialise where everything actually is before overwriting it — the
		// fold's input. Reading the getter rather than the field because
		// slotCurrent is only computed on demand now, and a retarget arriving
		// between frames must see this frame's positions, not the last ones the
		// table happened to be written with.
		const current = this.slotTable;
		const target = this.#slotTarget;
		const from = this.#slotFrom;
		const to = this.#slotTo;
		const exiting = this.#exiting;
		// Where an entrance comes from and an exit goes to.
		//
		// Other's slot when this axis has an Other bucket that is on screen: a
		// category leaving the top N has its value absorbed there, so that IS
		// where it went, and one entering is value coming back out. Anything else
		// would animate a claim that is not true of the data.
		//
		// Otherwise one past the last displayed slot. Off the end of the axis so
		// the scissor rect clips it, and non-negative so it survives the shader's
		// `slot < 0.0` discard on the way through — that pair is what makes
		// travel expressible at all without a second per-id channel.
		const far = count;
		const otherId = this.#otherId;
		const otherSlot =
			otherId != null && otherId >= 0 && otherId < target.length ? target[otherId] : -1;
		const settled = !this.#hasLaidOut;
		let moving = false;

		for (let id = 0; id < target.length; id++) {
			const trueTo = target[id];
			const onScreen = current[id] >= 0;

			// Other itself has nowhere to emerge from or vanish into but the end.
			const gateway = otherSlot >= 0 && id !== otherId ? otherSlot : far;

			if (trueTo >= 0) {
				exiting[id] = 0;
				// THE FOLD. An id already on screen continues from where it
				// actually is, not from where its last transition began — a result
				// landing at t = 0.4 must not restart the journey. For an id that is
				// mid-exit this is also what reverses it in place rather than
				// teleporting it back to its old slot.
				//
				// slotCurrent is exactly mix(from, to, t) as of the last frame, so
				// reading it IS the fold; there is nothing to recompute.
				//
				// Entering instead starts at the gateway — on a first layout there
				// is nothing to enter from, so it starts where it lands and does not
				// move at all.
				from[id] = onScreen ? current[id] : settled ? trueTo : gateway;
				to[id] = trueTo;
			} else if (onScreen && !settled) {
				// Leaving. Keep a REAL slot and walk out; the hidden sentinel is
				// applied by #settleSlots once it arrives, not now. slotTarget
				// already says -1, so the two disagree about this id on purpose —
				// #exiting is what records that.
				exiting[id] = 1;
				from[id] = current[id];
				to[id] = gateway;
			} else {
				// Hidden and staying hidden, or hidden before the first layout.
				exiting[id] = 0;
				from[id] = -1;
				to[id] = -1;
			}

			if (from[id] !== to[id]) moving = true;
		}

		if (count > 0) this.#hasLaidOut = true;

		// An animation nobody can drive has to be an instant transition, not a
		// lost one. slotCurrent is written ONLY by updateRenderState, which only
		// runs while the loop holds this scale — so without a coordinator the
		// driver would be reset and the table would keep the old order forever.
		// Reorders do happen with no coordinator attached: every unit test, and
		// any scale built before one is wired up.
		if (moving && this.#gpuCoordinator) {
			// Restart the clock, CARRYING VELOCITY — assigning the fields rather
			// than calling set(), which zeroes it. A retarget mid-flight continues
			// at the speed it was travelling instead of stalling and re-accelerating.
			this.#driver.current = 0;
			this.#driver.target = 1;
			this.#renderT = 0;
			// Publish the folded positions immediately. Without this the table
			// would hold last frame's values until the loop's first
			// updateRenderState, and a retarget that lands between frames would
			// show one frame of the old arrangement.
			this.#writeCurrent(0);
			this.#currentDirty = false;
			this.#ensureAnimating();
		} else {
			this.#settleSlots();
		}

		this.slotVersion++;
	}

	/**
	 * Write slotCurrent = mix(from, to, t), the one expression this whole design
	 * is organised around. Band step 4 moves it to the vertex stage, where the
	 * GPU evaluates the identical formula from the identical inputs; until then
	 * JS evaluates it for everyone.
	 *
	 * An id whose true target is -1 and which is not leaving is written straight
	 * through: not-displayed is a STATE, not a position, and interpolating
	 * toward it would put a bar at slot -0.4 for a frame.
	 */
	#writeCurrent(t: number): void {
		const current = this.#slotCurrent;
		const target = this.#slotTarget;
		const from = this.#slotFrom;
		const to = this.#slotTo;
		const exiting = this.#exiting;
		for (let id = 0; id < current.length; id++) {
			current[id] = target[id] < 0 && !exiting[id] ? -1 : from[id] + (to[id] - from[id]) * t;
		}
	}

	/** Land every id exactly on its target, with no interpolation. */
	#settleSlots(): void {
		const target = this.#slotTarget;
		// Snap t to exactly 1. A spring approaches asymptotically and isAtRest
		// fires at an epsilon, so leaving t just short of 1 would leave every
		// element fractionally short — and a staggered t_i, which divides by
		// (1 - phase), fractionally shorter still.
		this.#driver.set(1);
		this.#renderT = 1;
		this.#currentDirty = false;
		for (let i = 0; i < target.length; i++) {
			// The TRUE target, which for a leaver is the hidden sentinel and not
			// the gateway it was walking toward. This is where an exit completes.
			this.#slotCurrent[i] = target[i];
			this.#slotFrom[i] = target[i];
			this.#slotTo[i] = target[i];
			this.#exiting[i] = 0;
		}
	}

	/** Join the animation loop, once, until the eviction sweep drops us. */
	#ensureAnimating(): void {
		if (!this.#isAnimating && this.#gpuCoordinator) {
			this.#isAnimating = true;
			this.#gpuCoordinator.addAnimatingScale(this);
		}
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
	 * Charts to redraw while this scale animates. Populated by ScaleRegistry,
	 * which fills this on any scale that declares it — declaring the field is
	 * the whole subscription.
	 */
	_affectedChartsArray: string[] = [];

	/**
	 * Advance physics by one fixed timestep. Called at a fixed rate, not per
	 * frame, so it must not touch render state.
	 */
	step(): void {
		this.#driver.step();
	}

	/**
	 * Record where the driver is for this frame. Does NOT touch the slot table.
	 *
	 * The GPU reads slotFrom, slotTo and t and interpolates in the vertex stage,
	 * so the only thing that changes per frame is four bytes of t. This used to
	 * write every id and bump slotVersion, which made the packer re-upload the
	 * entire packed range — up to 64 KB — on every frame of every animation.
	 *
	 * slotVersion is deliberately NOT bumped here any more. It means "the
	 * tables moved", which happens on a retarget, and bumping it per frame is
	 * exactly what made the upload per-frame.
	 *
	 * `_version` is not bumped either. Nothing an axis reads has changed —
	 * #domain holds display ORDER and only slots are moving — so waking Svelte
	 * per frame would recompute the axis for no new information. The visible
	 * consequence is labels jumping to their final order while the bars slide,
	 * which is this checkpoint's known residual.
	 */
	updateRenderState(extrapolationDt: number): void {
		const t = this.#driver.getRenderable(extrapolationDt);
		this.#renderT = t < 0 ? 0 : t > 1 ? 1 : t;
		this.#currentDirty = true;
	}

	/**
	 * Whether the loop can stop driving this scale.
	 *
	 * One comparison, not a scan: everything in flight shares the driver, which
	 * is the practical payoff of one spring. It also means rest arrives for
	 * every id at once — which is exactly why a departing set has to accumulate
	 * across updates rather than be replaced, since departures from several
	 * consecutive updates are in the air together and are all retired here.
	 */
	isAtRest(): boolean {
		return this.#driver.isAtRest(REST_PRECISION);
	}

	/**
	 * Called by GPUCoordinator when this scale stops animating.
	 *
	 * Lands exactly on the target rather than wherever the last extrapolated
	 * frame left things. REST_PRECISION is sub-pixel so the difference is
	 * invisible, but slotCurrent is what every later comparison reads, and a
	 * scale at rest holding 2.0003 is a scale whose next retarget springs from a
	 * number that was never a slot.
	 */
	_markAtRest(): void {
		this.#isAnimating = false;
		this.#settleSlots();
		this.slotVersion++;
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

			// The INPUTS to display order, not just its output. updateDomainFromExtents
			// resolves #explicitDomain ?? #sortOrder first and appends the rest from
			// #extents, and a partial preferred order pulls its members to the front —
			// so when an axis is in an order nobody asked for, which of these is set
			// is the whole question. Dumping only the result cannot answer it.
			sortOrder: this.#sortOrder ? [...this.#sortOrder] : null,
			explicitDomain: this.#explicitDomain ? [...this.#explicitDomain] : null,
			displayOrder: Array.from(this.#displayOrder),
			slotCurrent: Array.from(this.#slotCurrent),
			slotTarget: Array.from(this.#slotTarget),

			// The transition itself. slotCurrent is mix(slotFrom, slotTo, t), so
			// these three are what produced it — and slotTo differs from slotTarget
			// exactly for the ids that are on their way out.
			slotFrom: Array.from(this.#slotFrom),
			slotTo: Array.from(this.#slotTo),
			exiting: Array.from(this.#exiting),
			t: this.#driver.current,

			// GPU state
			gpuState: this.gpuState
		};
	}
}
