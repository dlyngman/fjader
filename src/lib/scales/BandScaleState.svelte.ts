// src/lib/scales/BandScaleState.svelte.ts

import { scaleBand } from 'd3-scale';
import type { ScaleBand } from 'd3-scale';
import type { DimValue, FieldIdentity } from '$lib/query-engine/categorical-identity';
import type { ClockLoop } from '$lib/animation';
import { SlotTransition, type BandSlots } from './SlotTransition';
import { ActivityTable, DEFAULT_INACTIVE_OPACITY } from './ActivityTable';
import { DomainResolver } from './DomainResolver';

/**
 * Driver constants, taken from ParallelAxisReorder, which is the same
 * interaction: a permutation settling into place.
 *
 * The precision is in NORMALISED t, not slot space — 0.0005 of a whole
 * transition. That is the better place for it: a per-slot threshold means
 * something different for a one-band nudge than for a full reorder, while a
 * threshold on t is the same fraction of the journey either way.
 */

/** One label on a band axis, as `bandTicks` reports it. */
export interface BandTick {
	/** Stable across reorders: the dim id, or the position without identity. */
	key: number;
	value: DimValue | undefined;
}

interface BandScaleConfig {
	padding?: number;
	paddingInner?: number | null;
	paddingOuter?: number | null;
	sourceField?: string | null;
	registry?: {
		invalidateChartsUsingScale(scale: unknown): void;
		chartsUsing(scale: unknown): string[];
	} | null;
	/**
	 * How a transition reaches the animation loop. Structurally typed rather
	 * than importing GPUCoordinator, which would be a cycle. The loop drives
	 * this scale's CLOCK, not the scale.
	 */
	gpuCoordinator?: ClockLoop | null;
}

interface BandGpuConfig {
	categoryCount: number;
	paddingInner: number;
	paddingOuter: number;
}

/**
 * BandScaleState manages categorical (band/point) scales.
 *
 * It owns two spaces and the permutation between them: IDENTITY, the dim id a
 * channel carries, and DISPLAY, the slot a category occupies on the axis.
 * `displayOrder` is the permutation, `slots.target` its inverse, `slots.from`
 * and `slots.to` what the GPU resolves, and `#domain` a value projection for d3
 * and the axis.
 *
 * A transition is `mix(slots.from, slots.to, t)` with ONE spring
 * driving `t` for the whole scale, so everything in flight arrives together.
 * `slots.to` is the animated destination and `slots.target` what the scale says;
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
	/**
	 * Which categories are displayed and in what order, and the id <-> value
	 * boundary that decides it. This class publishes the answer; it does not
	 * work it out. See DomainResolver.
	 */
	#resolver = new DomainResolver();
	#domainUpdateScheduled: boolean = false; // Microtask debounce for updateDomainFromExtents

	// =========================================================================
	// CONFIGURATION (D3 band scale parameters)
	// =========================================================================
	#padding: number = 0.1;
	#paddingInner: number | null = null;
	#paddingOuter: number | null = null;
	#sourceField: string | null = null; // Actual SQL column name (defaults to this.name if null)
	#registry: {
		invalidateChartsUsingScale(scale: unknown): void;
		chartsUsing(scale: unknown): string[];
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
	// CONSTRUCTOR
	// =========================================================================

	constructor(name: string, domain: DimValue[] = [], config: BandScaleConfig = {}) {
		this.name = name;
		this.#domain = [...domain];

		// Apply configuration with defaults
		this.#padding = config.padding ?? 0.1;
		this.#paddingInner = config.paddingInner ?? null;
		this.#paddingOuter = config.paddingOuter ?? null;
		this.#sourceField = config.sourceField ?? null;
		this.#registry = config.registry ?? null;
		this.#slots = new SlotTransition(config.gpuCoordinator ?? null, {
			charts: () => this._affectedChartsArray,
			onFrame: () => this.#slotFrame++,
			onRest: () => this.#slotRest++
		});
		this.#activity = new ActivityTable(config.gpuCoordinator ?? null, {
			charts: () => this._affectedChartsArray,
			onFrame: () => this.#activityFrame++
		});
		this.#slots.activity = this.#activity;
	}

	// =========================================================================
	// LIFECYCLE
	// =========================================================================

	setReady(): void {
		this.ready = true;
	}

	// =========================================================================
	// ACTIVE VALUES (selection feedback)
	// =========================================================================

	get activeValues(): Set<DimValue> | null {
		return this.#activeValues;
	}

	setActiveValues(values: Iterable<DimValue>): void {
		const set = values instanceof Set ? values : new Set(values);
		this.#activeValues = set;
		this.#applyActiveValues(set);
	}

	clearActiveValues(): void {
		this.#activeValues = null;
		this.#activity.clear();
	}

	/**
	 * Which categories are selected, as a fade over every id of the dim: the
	 * activity half of this scale's block, which bars, dots and rules on this
	 * axis read to dim, and which the axis labels follow.
	 */
	#activity: ActivityTable;

	/** Bumped on every frame the selection fade is driven, and once at rest. */
	#activityFrame = $state(0);

	/** Reused id list for #applyActiveValues, which runs on every filter update. */
	#activeIds: number[] = [];

	/**
	 * Point the activity table at the ids of these values. Without identity the
	 * channel carries positions, not ids, and an axis without identity draws
	 * nothing, so there is nothing to dim; the values are applied once
	 * identity lands and the slots are laid out.
	 */
	#applyActiveValues(values: Set<DimValue>): void {
		if (!this.hasIdentity) return;
		this.#activity.resize(this.#slots.count);
		const ids = this.#activeIds;
		ids.length = 0;
		for (const value of values) {
			const id = this.channelValueFor(value);
			if (id !== null) ids.push(id);
		}
		this.#activity.setActive(ids);
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
	 * apply. Being dead and being unreferenced are different things, and
	 * only the registry's refcount claimed they were the same.
	 *
	 * What teardown genuinely needs to release — GPU config, ramp and palette
	 * slots — is released by the registry from `gpuSlots`, not here. A band
	 * scale holds none of those.
	 *
	 * It does hold one thing, and it is not state: a place in the animation
	 * loop. A clock mid-transition when the registry drops the scale keeps the
	 * loop awake and its charts rendering until the spring settles, for a
	 * transition nobody is watching. Stopping it leaves the arrays alone, which
	 * is the whole point of not wiping — a component still holding the scale
	 * reads exactly what it read before, it just no longer animates.
	 */
	destroy(): void {
		this.#destroyed = true;
		this.#slots.clock.stop();
		this.#activity.destroy();
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
	 * stacked bugs, every one of them silent. Warned once per scale:
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
		} else if (!wasEnabled && enabled) {
			// Unfreezing - restore updates
			this.#frozenDomain = null;
			this.updateDomainFromExtents();
		}
	}

	get updatesEnabled(): boolean {
		return this.#enableUpdates;
	}

	get effectiveDomain(): DimValue[] {
		return this.#enableUpdates ? this.#domain : this.#frozenDomain || this.#domain;
	}

	/**
	 * Adopt the engine's bijection for this field.
	 *
	 * The resolver does the work — re-encoding anything registered before
	 * identity arrived, and detecting the two reload orderings that make stored
	 * ids meaningless. What belongs here is what a scale does afterwards:
	 * republish, and bump the version, because `hasIdentity` changing alters
	 * what the ticks and the grid report even when the domain itself has not
	 * moved.
	 *
	 * EVERY MARK ON A SHARED AXIS CALLS THIS, with the same live object — two
	 * marks on one chart, or forty facet cells. Only the first adoption does
	 * anything; the rest used to re-resolve the whole domain and bump the
	 * version to publish an answer identical to the one already on screen. At a
	 * thousand categories that was 28ms of setup for a forty-cell grid.
	 *
	 * So the resolver reports whether adopting MOVED anything, and this returns
	 * when it did not. What makes that safe is `FieldIdentity.version`: the
	 * object is live and mutates behind every holder, and the guard cannot be
	 * "same reference" or "same length" — a dim APPEND (the Other bucket
	 * reservation does one on every topN mark) and a same-length replacement
	 * are both real changes that neither test would catch. `reset` is the only
	 * writer and bumps the counter, so comparing it is complete.
	 */
	setIdentity(identity: FieldIdentity): void {
		this.#warnIfDestroyed('setIdentity');
		if (!this.#resolver.setIdentity(identity)) return;
		this.updateDomainFromExtents();
		this._version++;
	}

	/** True when this scale's channel carries dim ids rather than positions. */
	get hasIdentity(): boolean {
		return this.#resolver.hasIdentity;
	}

	/**
	 * Ids in display order — the permutation the whole design is about.
	 * Primary state: #domain is derived from it, and the slot table is its
	 * inverse. Empty for a scale without identity, which stays on strings.
	 *
	 * Exposed for the animated reorder and for tests, NOT as a
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

	// -------------------------------------------------------------------------
	// SLOTS — where each category is on screen, owned by SlotTransition
	// -------------------------------------------------------------------------
	//
	// Everything about entering, leaving, folding and the clock lives in
	// SlotTransition; this class decides what is displayed and in what order.

	#slots: SlotTransition;
	/**
	 * Bumped on every frame a slot transition is driven, and once on settling.
	 * What the CPU consumers of an in-flight layout — axis labels, bandwidth for
	 * hit-testing — subscribe to. Nothing bumps it at rest, so a still chart costs
	 * no reactivity at all.
	 */
	#slotFrame = $state(0);
	/** Bumped when a transition settles — the set of ids on screen shrank. */
	#slotRest = $state(0);
	/**
	 * getConfig's result, overwritten on every call rather than rebuilt: the
	 * coordinator reads it for every band scale on every frame, and the CPU layout
	 * reads it per label per frame during a transition. Read it immediately.
	 */
	#gpuConfig: BandGpuConfig = { categoryCount: 0, paddingInner: 0, paddingOuter: 0 };

	/**
	 * Where every category of this axis is on screen, and the clock it travels on.
	 *
	 * The packer reads it as a SlotSource. Marks drawn against this axis adopt its
	 * `clock`, and `startTransition` on it restarts that clock for a value-only
	 * update — every other mark on the axis folds to where it already is, which
	 * is why one mark may start a clock they all share.
	 *
	 * `snapshot()` copies where every id is now: -1 for an id filtered out by a
	 * transform or belonging to another table on a shared scale. It allocates, so
	 * it is for tests and debugging; a label asks `tickSlot`, and a CPU lookup
	 * asks idAtSlot or categoryAt.
	 *
	 * Laying the axis out is this scale's alone, so `layout` is not exposed.
	 */
	get slots(): BandSlots {
		return this.#slots;
	}

	/**
	 * Charts to redraw while this scale animates, asked of the registry rather
	 * than written into this object.
	 *
	 * The registry owns which charts use which scale, and now owns the array
	 * form too. This used to be a plain field that the registry AND the
	 * coordinator's topology handler each assigned — one fact, two writers, on
	 * an object owned by neither, reached by probing for the field. Asking is
	 * also what keeps it current, which is the lesson the frame uniform taught:
	 * a derived value that is pushed goes stale when one writer forgets.
	 *
	 * Returns a held array either way: the loop reads this once per frame for
	 * every source it drives, so it must not build one.
	 */
	get _affectedChartsArray(): string[] {
		return this.#registry?.chartsUsing(this) ?? this.#noCharts;
	}

	/** Returned when no registry owns this scale, as in a unit test. */
	#noCharts: string[] = [];

	/**
	 * Tell this axis which id is its Other bucket, if any — where entering and
	 * leaving categories travel from and to.
	 *
	 * The lifecycle reserves an Other id for every categorical axis of a mark
	 * rather than re-deriving which one topN picked. That costs nothing on the
	 * axes topN did not pick: an Other no row carries is never displayed, and an
	 * undisplayed Other is ignored.
	 */
	setOtherId(id: number | null): void {
		this.#slots.otherId = id;
	}

	// -------------------------------------------------------------------------
	// IDENTITY <-> DISPLAY, FOR CPU CONSUMERS
	// -------------------------------------------------------------------------
	//
	// The GPU crosses this boundary through the slot tables, in the shader. Everything
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
	 * the entire point of the identity split (a warning that has already been
	 * rediscovered twice).
	 *
	 * effectiveDomain, not #domain, so a frozen scale decodes to what is on
	 * screen. The two coincide today — updateDomainFromExtents returns early
	 * while frozen, so neither the domain nor displayOrder moves — but the
	 * display pipeline reads effectiveDomain, and this must not drift from it.
	 */
	categoryAt(channelValue: number): DimValue | undefined {
		return this.#resolver.categoryAt(channelValue, this.effectiveDomain);
	}

	/**
	 * The inverse of `categoryAt`: the channel value a source value is carried
	 * as, or null when this axis does not know it.
	 *
	 * For a caller holding a VALUE that needs a key — a label whose channel came
	 * back as raw categories because the axis has no dim, a legend entry, a
	 * toggle. A caller already holding a channel value has the key and must not
	 * come through here.
	 *
	 * Both directions are a lookup, never a scan: with identity the dim's own
	 * map, and without it a value -> position map cached against the domain
	 * array it was built from. That cache is what keeps a per-frame consumer off
	 * an indexOf per item — the positions of an axis mid-transition are asked
	 * for every label on every frame.
	 */
	channelValueFor(value: DimValue): number | null {
		return this.#resolver.channelValueFor(value, this.effectiveDomain);
	}

	/**
	 * Hand the current display order to the slots.
	 *
	 * Imperative rather than a $derived: the consumer is the per-frame GPU upload
	 * path, which is not a reactive context, and the inputs change on reorder.
	 * Called from the two places they move: a domain change and adopting a new
	 * identity value array.
	 *
	 * Without identity the channel already carries a display position, so the
	 * layout is the identity permutation over the domain — not an empty table,
	 * which would give the scale offset 0 and another scale's slots. That is only
	 * a TRANSIENT state now — the window before setIdentity arrives, and the
	 * all-NULL column that renders nothing — because an expression-backed axis
	 * gets a dim like any other since `c55e719`.
	 */
	#rebuildSlotTable(): void {
		if (this.hasIdentity) {
			this.#slots.layout('ids', this.#displayOrder, this.#resolver.idCount);
			// The activity table covers the same ids. A selection made before these
			// ids existed (or before identity landed) is applied to them now.
			this.#activity.resize(this.#slots.count);
			if (this.#activeValues) this.#applyActiveValues(this.#activeValues);
		} else {
			this.#slots.layout('positions', null, this.#domain.length);
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
		return this.ready && this.effectiveDomain.length > 0 && this.#resolver.markCount > 0;
	}

	// =========================================================================
	// DOMAIN MANAGEMENT
	// =========================================================================

	/**
	 * Register a mark's categories, as source values.
	 *
	 * For ids — the band channel of a result, which carries them straight from
	 * the query — use `addMarkIds`. The two spaces are not distinguishable by
	 * inspection, so which one a caller is in is said by which method it calls.
	 */
	addMark(
		categories: DimValue[],
		identifier: string,
		options: { sorted?: boolean; explicit?: boolean } = {}
	): this {
		this.#warnIfDestroyed('addMark');
		this.#resolver.addMark(categories, identifier, options);
		this.#afterRegistration();
		return this;
	}

	/** Register a mark's categories, as dim ids. See `addMark`. */
	addMarkIds(ids: number[], identifier: string, options: { sorted?: boolean } = {}): this {
		this.#warnIfDestroyed('addMarkIds');
		this.#resolver.addMarkIds(ids, identifier, options);
		this.#afterRegistration();
		return this;
	}

	/** Both registration paths schedule the same way. */
	#afterRegistration(): void {
		if (this.#enableUpdates) {
			this.#scheduleDomainUpdate();
		}
	}

	/**
	 * Remove a mark's categories from domain calculation
	 */
	removeMark(identifier: string): this {
		if (this.#resolver.removeMark(identifier) && this.#enableUpdates) {
			this.#scheduleDomainUpdate();
		}
		return this;
	}

	/**
	 * Debounce domain updates via microtask so multiple marks registering
	 * in the same tick (e.g. sorted + unsorted) settle before views are created.
	 *
	 * THE FLAG IS THE REQUEST, not the microtask. A microtask cannot be
	 * cancelled, so `updateDomainFromExtents` clears the flag to say the request
	 * has been served, and the queued callback finds nothing to do and returns.
	 *
	 * Without that every data update on a band axis resolved TWICE: a mark
	 * registers its result, which schedules this, and then the same caller
	 * resolves synchronously because it needs the domain before it returns. The
	 * microtask then recomputed the identical answer to discover `changed` was
	 * false and discard it. The resolver's own contract says the debounce
	 * batches the cost of APPLYING a resolution rather than computing one, and
	 * this is what makes that true.
	 *
	 * A registration landing AFTER the explicit resolve finds the flag clear and
	 * schedules again, which is correct — its categories have not been seen.
	 */
	#scheduleDomainUpdate(): void {
		if (this.#domainUpdateScheduled) return;
		this.#domainUpdateScheduled = true;
		queueMicrotask(() => {
			if (!this.#domainUpdateScheduled) return;
			this.#domainUpdateScheduled = false;
			this.updateDomainFromExtents();
		});
	}

	/**
	 * Take the resolver's answer and publish it.
	 *
	 * What is left here once resolving moved out is all display: whether a
	 * frozen scale adopts the answer at all, the permutation and its value
	 * projection as this scale's published state, the slot table that has to
	 * follow them, the version every reactive reader watches, and the redraw.
	 *
	 * Resolving is unconditional and applying is not, which is why the resolver
	 * reports what CHANGED rather than notifying anyone: nothing below runs for
	 * an answer identical to the one already on screen.
	 */
	updateDomainFromExtents(): void {
		if (!this.#enableUpdates) {
			return;
		}

		// Any pending microtask asked for exactly this, so it is now served.
		// Cleared below the freeze guard rather than above it: a frozen call
		// resolves nothing, so it has not answered the request, and the microtask
		// should still run and take the same early return.
		this.#domainUpdateScheduled = false;

		const { ids, values, changed } = this.#resolver.resolve();
		if (!changed) return;

		this.#domain = values;
		this.#displayOrder = ids;
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
	 * domain positions, one row at a time, on every update — a per-row JS pass
	 * the identity layer exists to delete. Nothing produces strings on a band channel any more:
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

		// Mid-transition the band count is travelling too, so widths and pitch
		// change WITH the bars rather than on the frame the data landed. The
		// coordinator writes this to the GPU every frame, and the CPU layout
		// below reads it, so the two agree. At rest it is the domain's length.
		void this.#slotFrame;
		const categoryCount = this.#slots.isAnimating
			? this.#slots.animatedCount
			: this.effectiveDomain.length;

		const config = this.#gpuConfig;
		config.categoryCount = categoryCount;
		config.paddingInner = paddingInner;
		config.paddingOuter = paddingOuter;
		return config;
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

		// align is left at d3's default, which is centred. The GPU band layout
		// has no alignment parameter — computeBandLayout places a category at
		// paddingOuter * step + slot * step — so a d3 scale aligned any other way
		// would put every SVG consumer somewhere the bars are not. It was a prop
		// until it was noticed that it reached only this line.

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
	 * Channel values for grid lines — what this axis's channel carries, so the
	 * shader's scaleBand resolves each one through the slot table exactly as it
	 * resolves a bar.
	 *
	 * With identity that is EVERY id in the dim, displayed or not. A hidden id
	 * resolves to slot -1 and the shader puts it off-screen, so it costs nothing
	 * visible — and it makes row i the same category on every update, which is
	 * what lets a line's opacity morph the way a bar's height does (see
	 * `tickVisibility`). Handing over display positions instead, as this once
	 * did, had the shader read position i as id i: every position whose id was
	 * hidden lost its line, and no line followed a reorder.
	 *
	 * Without identity the channel is already a position, so positions it is.
	 * Changes only when the dim or the domain does.
	 */
	getTicks(): Float32Array {
		void this._version;
		const n = this.hasIdentity ? this.#resolver.idCount : this.effectiveDomain.length;
		const ticks = new Float32Array(n);
		for (let i = 0; i < n; i++) ticks[i] = i;
		return ticks;
	}

	/**
	 * Where each grid line is headed: 1 for a displayed category, 0 otherwise,
	 * row-aligned with `getTicks`. A grid morphs its lines' opacity toward this on
	 * the axis's clock, so a line fades out with a leaving bar and in with an
	 * entering one. Changes on every layout.
	 */
	tickVisibility(): Float32Array {
		void this._version;
		if (!this.hasIdentity) return new Float32Array(this.effectiveDomain.length).fill(1);
		const target = this.#slots.target;
		const n = this.#resolver.idCount;
		const out = new Float32Array(n);
		for (let id = 0; id < n; id++) out[id] = (target[id] ?? -1) >= 0 ? 1 : 0;
		return out;
	}

	/**
	 * The categories on screen, for a band axis to label.
	 *
	 * Not the domain: mid-transition a leaving category is no longer in it but
	 * its bar is still sliding out, and an entering one is in it but has not
	 * arrived. Both are listed, from the moment a layout lands until the
	 * transition settles.
	 *
	 * The LIST changes only then — layout and settling — so it is rebuilt only
	 * then, and its entries are stable. Where each label is and how visible, which
	 * change every frame, are asked per label with `tickSlot` and `tickOpacity`:
	 * O(1) each, no arrays, and no walk over ids that are not on screen.
	 *
	 * Keyed by id, so an axis `{#each}` moves a label rather than replacing it.
	 */
	bandTicks(): BandTick[] {
		void this._version;
		void this.#slotRest;
		const ticks: BandTick[] = [];

		if (this.hasIdentity) {
			// Headed somewhere on screen: displayed, entering, or leaving toward a
			// gateway. A hidden id is -1 in both halves.
			const to = this.#slots.to;
			for (let id = 0; id < to.length; id++) {
				if (to[id] >= 0) ticks.push({ key: id, value: this.categoryAt(id) });
			}
			return ticks;
		}

		// No identity: the channel is already a display position.
		const domain = this.effectiveDomain;
		for (let i = 0; i < domain.length; i++) ticks.push({ key: i, value: domain[i] });
		return ticks;
	}

	/** Where a tick's category is now — its fractional slot. Per frame, O(1). */
	tickSlot(key: number): number {
		void this.#slotFrame;
		return this.#slots.slotOf(key);
	}

	/**
	 * How visible a tick's label is now. Per frame, O(1).
	 *
	 * Two fades, multiplied. The category's own, on the transition's clock. And
	 * its position: a band is drawn only inside the plot, clipped at the axis
	 * ends, but a label is SVG outside it — so a leaver heading past the end still
	 * showed its label after its bar had gone. The label is centred on its band,
	 * so it fades out over the half slot before that centre reaches the axis end
	 * (the animated count), and is gone from there; the same at the start. An
	 * entrant's label appears as its band crosses in.
	 */
	tickOpacity(key: number): number {
		void this.#slotFrame;
		void this.#activityFrame;
		const slot = this.#slots.slotOf(key);
		const n = this.getConfig().categoryCount;
		const inside = Math.min(1, Math.max(0, (n - 0.5 - slot) * 2), Math.max(0, (slot + 0.5) * 2));
		return this.#slots.alphaOf(key) * inside * this.#selectionOpacity(key);
	}

	/**
	 * A label's selection fade, on the same clock and the same mapping as the
	 * bars: an inactive category's label fades to DEFAULT_INACTIVE_OPACITY with
	 * them. Without identity the key is a position, not an id, and there is no
	 * table to read.
	 */
	#selectionOpacity(key: number): number {
		if (!this.hasIdentity) return 1;
		const activity = this.#activity.activityOf(key);
		return DEFAULT_INACTIVE_OPACITY + (1 - DEFAULT_INACTIVE_OPACITY) * activity;
	}

	/**
	 * Where a tick's label sits now, in pixels along the axis: the centre of its
	 * category's current slot, so it travels with the bar. Slot 0 is at the start
	 * of the range on x and at the bottom on y, as in the shader and d3's
	 * reversed range. Per frame, O(1).
	 */
	tickPosition(key: number, rangeSize: number, axis: 'x' | 'y'): number {
		return this.slotPosition(this.tickSlot(key), rangeSize, axis);
	}

	/**
	 * The same, for a caller that already has the slot.
	 *
	 * A consumer that has to test the slot first — an SVG label, which must not
	 * draw a category the axis is not displaying — would otherwise ask for it
	 * twice per item per frame. The axis flip lives here rather than being
	 * re-derived by such a caller.
	 */
	slotPosition(slot: number, rangeSize: number, axis: 'x' | 'y'): number {
		const centre = this.slotCenter(slot, rangeSize);
		return axis === 'y' ? rangeSize - centre : centre;
	}

	/** Whether a tick's category is outside the current selection. */
	isTickDimmed(tick: BandTick): boolean {
		return tick.value != null && !this.isActive(tick.value);
	}

	/**
	 * Centre of a (possibly fractional) slot, measured from the start of the
	 * range — the same layout the shader's computeBandLayout uses, so a label
	 * sits on its bar mid-transition. For a y axis, subtract from the height, or
	 * use `tickPosition`.
	 */
	slotCenter(slot: number, rangeSize: number): number {
		const config = this.getConfig();
		if (config.categoryCount <= 0) return 0;
		const step = this.#step(rangeSize, config);
		return config.paddingOuter * step + slot * step + (step * (1 - config.paddingInner)) / 2;
	}

	/**
	 * The band pitch for a range, from a config just read.
	 *
	 * THE CPU TWIN of the shader's computeBandLayout, and the one formula every
	 * CPU layout method here shares — slotCenter, bandwidth, stepWidth and the
	 * pointer inversion. Two implementations is the floor, not an oversight: one
	 * runs per vertex on the GPU, one answers axis ticks, tooltips and
	 * hit-testing on a pointer event, and neither can call the other.
	 *
	 * What holds them together is that each is written once and both are pinned
	 * against d3's scaleBand, which is the third implementation and the one that
	 * positions every SVG consumer. See band-layout.test.ts. When they drift,
	 * the symptom is labels off their bars — which is what a prop reaching only
	 * d3 produced, and why it was dropped rather than wired.
	 */
	#step(rangeSize: number, config: BandGpuConfig): number {
		return (
			rangeSize / Math.max(1, config.categoryCount - config.paddingInner + config.paddingOuter * 2)
		);
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
		if (config.categoryCount === 0) return 0;
		return this.#step(rangeSize, config) * (1 - config.paddingInner);
	}

	/**
	 * Calculate step size for a given range size (CPU-side) — the band pitch,
	 * centre to centre, of which `bandwidth` is the drawn fraction.
	 *
	 * d3 spells this `step()`. Not here: the animation loop's interface uses
	 * `step()` for "advance physics one timestep", and a scale that ever joins the
	 * loop again would collide silently — an arity mismatch, not a type error.
	 * It pairs with `bandwidth(rangeSize)` either way.
	 */
	stepWidth(rangeSize: number): number {
		const config = this.getConfig();
		if (config.categoryCount === 0) return 0;
		return this.#step(rangeSize, config);
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

		const stepSize = this.#step(rangeSize, config);
		if (stepSize === 0) return null;

		const offset = config.paddingOuter * stepSize;

		// GPU band scale renders Y categories bottom-to-top (matching D3),
		// so flip screen coordinate for Y axis inversion.
		const pos = isYAxis ? rangeSize - screenVal : screenVal;

		const bandIndex = Math.floor((pos - offset) / stepSize);

		// Clamped to a WHOLE slot. Mid-transition the count is fractional, so a
		// bare `n - 1` hands back a fraction for a pointer past the last band —
		// and a fractional slot indexes nothing, so idAtSlot and the domain both
		// answer undefined and hover and click die at the axis end while an axis
		// reorders. Rounded UP rather than down: a slot that is on its way out
		// still exists, and reporting no category there is honest where reporting
		// its neighbour's would not be. Identical to `n - 1` at rest.
		return Math.max(0, Math.min(Math.ceil(n) - 1, bandIndex));
	}

	/**
	 * Get all mark extents (for debugging). Ids when the scale has identity.
	 */
	getExtents(): Record<string, (DimValue | number)[]> {
		return this.#resolver.debugExtents();
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
			extentsCount: this.#resolver.markCount,
			extents: this.getExtents(),

			// Configuration
			configuration: {
				padding: this.#padding,
				paddingInner: this.#paddingInner,
				paddingOuter: this.#paddingOuter
			},

			// GPU config
			gpuConfig: { ...this.getConfig() },

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
			identityCount: this.#resolver.idCount,

			// The INPUTS to display order, not just its output. updateDomainFromExtents
			// takes an explicit extent first, then a sorted one, then the rest in
			// first-appearance order — so when an axis is in an order nobody asked
			// for, which mark claimed which role is the whole question. Dumping
			// only the result cannot answer it.
			extentRoles: this.#resolver.debugRoles(),
			displayOrder: Array.from(this.#displayOrder),
			// The transition. slotCurrent is mix(slotFrom, slotTo, t), and slotTo
			// differs from slotTarget exactly for the ids on their way out.
			...this.#slots.debugState()
		};
	}
}
