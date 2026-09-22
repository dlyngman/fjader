import type { DimValue, FieldIdentity } from '$lib/query-engine/categorical-identity';

/**
 * Which categories a categorical axis shows, and in what order.
 *
 * One question, answered from what the marks registered. It knows nothing
 * about d3, the GPU, slots, clocks or freezing — a scale asks it what the
 * domain is and decides what to do with the answer.
 *
 * It owns the harder half of the categorical work: the boundary between the
 * two spaces a category can be in. A channel carries a dim ID once the field
 * has an identity and a source VALUE before that, and the two are not
 * distinguishable by inspection — on a band axis over a year or a rating, a
 * raw category value is a number exactly as an id is. Every entry point
 * therefore says which space it is in, and the resolver converts once, at the
 * boundary, rather than decoding to values and re-encoding downstream.
 *
 * It returns what changed rather than telling anyone. Bumping a version,
 * rebuilding a slot table and invalidating charts are all things a scale does
 * with a resolution, not parts of resolving one.
 */

/**
 * What one mark registered, and what it claims about order.
 *
 * `explicit` is a `domain` prop, `sorted` a ranking the mark's query
 * published, null a list with no opinion. The claim travels with the list, so
 * a mark re-registering without one withdraws it and a mark leaving the scale
 * takes it along — a preferred order held apart from the extents used to
 * outlive both.
 */
interface MarkExtent {
	categories: (DimValue | number)[];
	role: 'explicit' | 'sorted' | null;
}

/** What a resolution produced, and whether it moved. */
export interface DomainResolution {
	/**
	 * Ids in display order — the permutation the identity design is about.
	 * Empty for an axis with no identity, whose channel already carries a
	 * display position.
	 */
	ids: Int32Array;
	/**
	 * The same list projected into source values, for d3's `scaleBand`, axis
	 * ticks, labels and tooltips. An OUTPUT, never state, and not necessarily
	 * strings: a band axis over an INTEGER column carries numbers all the way
	 * to `scaleBand`, which looks its domain up by the raw value and misses on
	 * a stringified one.
	 */
	values: DimValue[];
	/** Whether either moved since the previous resolution. */
	changed: boolean;
}

const EMPTY_IDS = new Int32Array(0);

export class DomainResolver {
	/** Per mark, keyed by the identifier it registered under. */
	#extents: Map<string, MarkExtent> = new Map();

	/**
	 * The engine's id <-> value bijection for this field.
	 *
	 * A live reference, never a copy: the dim appends when a second table
	 * registers the same field, and a snapshot taken at setup would be indexed
	 * past its end by ids from that table. Both directions come from here, so
	 * the pair cannot be half-stale.
	 */
	#identity: FieldIdentity | null = null;

	/**
	 * Whether `#extents` holds ids rather than source values.
	 *
	 * Flips once, when identity is first adopted, and is cleared whenever the
	 * dim behind those ids goes away, because the ids stored under it stop
	 * meaning anything at that moment. `setIdentity` is where both of those are
	 * detected and is the only writer.
	 */
	#encoded: boolean = false;

	/** The previous resolution, to answer `changed` without asking a consumer. */
	#lastIds: Int32Array = EMPTY_IDS;
	#lastValues: DimValue[] = [];

	// =========================================================================
	// REGISTRATION
	// =========================================================================

	/**
	 * Register one mark's categories, as SOURCE VALUES.
	 *
	 * The ordinary direction. An explicit `domain` prop, a dim's own value
	 * list, anything that names categories the way a person writes them.
	 * Values that this field's dim does not know are dropped.
	 *
	 * `sorted` marks the list as a ranking the axis should prefer over first
	 * appearance, `explicit` as a domain prop, which outranks a ranking.
	 */
	addMark(
		categories: DimValue[],
		identifier: string,
		{ sorted = false, explicit = false }: { sorted?: boolean; explicit?: boolean } = {}
	): void {
		this.#register(categories, identifier, explicit ? 'explicit' : sorted ? 'sorted' : null, false);
	}

	/**
	 * Register one mark's categories, as DIM IDS.
	 *
	 * The other direction, and it needs a method of its own because the two
	 * are not distinguishable by inspection: on a band axis over a year or a
	 * rating, a source value is a number exactly as an id is. This used to be
	 * a boolean on `addMark`, which meant a caller could hand ids to the value
	 * path and get the wrong categories, or none, with nothing thrown. Naming
	 * the method is what makes that unrepresentable.
	 *
	 * Exactly one caller is here: a mark registering the band channel of a
	 * result, whose rows carry ids straight from the query. It has no
	 * `explicit` option because an explicit domain is a prop, and props are
	 * written as values.
	 *
	 * Ids are range-checked against the dim, because one past the end would
	 * survive into the permutation and be dropped from the value projection,
	 * leaving the two different lengths.
	 */
	addMarkIds(
		ids: number[],
		identifier: string,
		{ sorted = false }: { sorted?: boolean } = {}
	): void {
		this.#register(ids, identifier, sorted ? 'sorted' : null, true);
	}

	/**
	 * Convert at the boundary and store, once.
	 *
	 * Encoding happens on the way IN rather than by decoding to values and
	 * re-encoding downstream, so the extents hold one space at a time and
	 * `#encoded` says which.
	 *
	 * Without identity there is no dim to convert against, so both entry
	 * points keep what they were handed: the channel carries a display
	 * position in that state, which is what the values already are. A caller
	 * cannot reach `addMarkIds` there — it asks whether the scale has identity
	 * first — and preserving the behaviour rather than refusing keeps this a
	 * rename of the surface and not a change of what it does.
	 */
	#register(
		categories: (DimValue | number)[],
		identifier: string,
		role: MarkExtent['role'],
		encoded: boolean
	): void {
		this.#extents.set(identifier, {
			categories: this.hasIdentity
				? this.#toIds(categories, encoded)
				: [...new Set(categories.filter((c) => c != null))],
			role
		});
	}

	/** Drop a mark's categories. Returns whether it had any. */
	removeMark(identifier: string): boolean {
		return this.#extents.delete(identifier);
	}

	/**
	 * Adopt the engine's bijection for this field, and re-encode anything
	 * registered before it arrived.
	 *
	 * Marks race here: a mark's domain fetch and its `ensureColumns` resume off
	 * the same coalesced promise, so `addMark` can run while there is still no
	 * identity and store values. Leaving those as values would have the
	 * resolution index the value array with a string and drop every category.
	 *
	 * Re-encoding runs exactly once, on the transition. Every mark on a shared
	 * scale calls this with the same live object, and after the first pass the
	 * stored lists are already ids — re-encoding them as VALUES would look each
	 * id up in the engine's map, miss, and drop the whole domain.
	 *
	 * TWO RELOAD ORDERINGS clear the flag, and the second is the one that is
	 * easy to miss:
	 *
	 *  1. The dim is emptied in place. The ids stored under it stop meaning
	 *     anything, so the next adoption must encode from values again.
	 *  2. `QueryEngine.reset()` clears its map, so a mark re-running setup gets
	 *     a DIFFERENT object for the same field and arrives here with it
	 *     already populated. `present` is true on the way in, so check 1 cannot
	 *     see it, and the flag would stay set from before the reload — leaving
	 *     pre-reset ids to be range-checked against a new numbering they merely
	 *     happen to fit. Wrong categories, no error. The signature is
	 *     unambiguous: the object being held has been emptied and a different
	 *     one is replacing it, which happens only across a reset, since
	 *     `identityFor()` is stable per field.
	 *
	 * Stale entries are DROPPED rather than translated: clearing the flag lets
	 * the re-encode treat them as values, where they miss and are discarded,
	 * while an entry a re-running mark has already refreshed is a real value
	 * and encodes correctly. That mixed state is the normal case, since
	 * `addMark` can land on either side of this call.
	 *
	 * RETURNS WHETHER ANYTHING MOVED, so a caller sharing this scale with other
	 * marks does not republish an answer identical to the one already on
	 * screen. Every mark on a shared axis adopts, with the same live object,
	 * and only the first adoption does work.
	 *
	 * The test is the reference OR `FieldIdentity.version`, and it has to be
	 * both. The object is live and mutates behind this class — that is
	 * deliberate, so the two directions cannot be half-stale — which means
	 * "same reference" alone would miss every in-place change. `values.length`
	 * would miss a same-length replacement. `reset` is the only writer of
	 * either direction and bumps the counter, so this is complete where those
	 * are not, and it covers the two cases that actually happen: the dim
	 * APPENDING (the Other-bucket reservation does one on every topN mark) and
	 * a reload replacing the values outright.
	 */
	setIdentity(identity: FieldIdentity): boolean {
		const previous = this.#identity;
		this.#identity = identity;

		const moved = previous !== identity || this.#seenVersion !== identity.version;
		this.#seenVersion = identity.version;

		if (!identity.present) this.#encoded = false;
		if (previous && previous !== identity && !previous.present) this.#encoded = false;

		if (!this.#encoded && this.hasIdentity) {
			this.#encoded = true;
			for (const extent of this.#extents.values()) {
				extent.categories = this.#toIds(extent.categories, false);
			}
			// Re-encoding rewrote every extent, so the next resolution has new
			// input whatever the counter says.
			return true;
		}
		return moved;
	}

	/**
	 * The live identity's `version` when this resolver last adopted it.
	 *
	 * -1 rather than 0 so a fresh resolver adopting a never-reset identity
	 * still counts as a move.
	 */
	#seenVersion: number = -1;

	// =========================================================================
	// RESOLUTION
	// =========================================================================

	/**
	 * Work out what is displayed and in what order.
	 *
	 * Synchronous and explicit: a caller that wants a result gets one, and a
	 * test does not have to await anything to see it. Batching several marks
	 * registering in the same tick is the caller's business, because what it
	 * batches is the cost of APPLYING a resolution — a slot rebuild, a redraw —
	 * rather than the cost of computing one.
	 */
	resolve(): DomainResolution {
		const ordered = this.#inPreferredOrder();
		const all: (DimValue | number)[] = [];
		const seen = new Set<DimValue | number>();
		for (const extent of ordered) {
			for (const category of extent.categories) {
				if (seen.has(category)) continue;
				seen.add(category);
				all.push(category);
			}
		}

		const values = this.#identity?.values ?? [];
		// Already ids: every path into #extents encodes at the boundary, so this
		// pass de-duplicates and range-checks.
		//
		// An id with no value is dropped from the IDS, before either projection.
		// Filtering only the values would shorten the value list without
		// shortening the permutation, and the two would disagree with the band
		// index space d3 and the shader's categoryCount use — by one, with
		// nothing failing. Unreachable today (the dim has no NULL values and
		// synthetic rows carry a label), which is why it is written so the two
		// cannot diverge rather than checked.
		const orderedIds = this.hasIdentity
			? this.#toIds(all, true).filter((id) => values[id] != null)
			: [];
		const resolved: DimValue[] = this.hasIdentity
			? orderedIds.map((id) => values[id] as DimValue)
			: (all as DimValue[]);

		const valuesChanged =
			this.#lastValues.length !== resolved.length ||
			resolved.some((cat, i) => cat !== this.#lastValues[i]);
		// The permutation can move while its value projection does not — most
		// obviously when identity arrives after the domain has settled, which is
		// the live ordering during setup. Comparing the values alone left the
		// permutation empty and the slot table stale.
		const idsChanged =
			this.hasIdentity &&
			(this.#lastIds.length !== orderedIds.length ||
				orderedIds.some((id, i) => id !== this.#lastIds[i]));

		const ids = this.hasIdentity ? Int32Array.from(orderedIds) : EMPTY_IDS;
		this.#lastIds = ids;
		this.#lastValues = resolved;
		return { ids, values: resolved, changed: valuesChanged || idsChanged };
	}

	/**
	 * The extents with a preferred one first: an explicit domain, else a
	 * ranking, else nobody.
	 *
	 * A preferred list needs no intersection against the others, because it is
	 * one mark's extent like any other — already only the categories that mark
	 * returned. It used to be held apart from the extents, which is what let an
	 * unfiltered list dictate the order of a filtered axis.
	 */
	#inPreferredOrder(): MarkExtent[] {
		const all = [...this.#extents.values()];
		const preferred =
			all.find((e) => e.role === 'explicit') ?? all.find((e) => e.role === 'sorted');
		return preferred ? [preferred, ...all.filter((e) => e !== preferred)] : all;
	}

	/**
	 * Normalize a caller's list to ids, dropping anything the dim does not know.
	 *
	 * Ids are range-checked against the value array, because an id past its end
	 * would survive into the permutation but be dropped from the value
	 * projection, desynchronizing the two.
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
			const id = encoded ? (item as number) : identity.ids.get(item as DimValue);
			if (id === undefined || !Number.isInteger(id) || id < 0 || id >= limit) continue;
			if (seen.has(id)) continue;
			seen.add(id);
			out.push(id);
		}
		return out;
	}

	// =========================================================================
	// IDENTITY <-> DISPLAY, FOR CPU CONSUMERS
	// =========================================================================
	//
	// The GPU crosses this boundary in the shader, through the slot tables.
	// Everything on the CPU crosses it here, so the rule — with identity a
	// channel value is a dim id, without it the value is already a display
	// position — is stated once rather than re-derived by each consumer.
	//
	// Both take the currently DISPLAYED values rather than reading a domain of
	// their own, because which values are on screen is the scale's to decide: a
	// frozen scale shows what it froze. Passing them in is also what lets the
	// position cache key on the array it was handed.

	/**
	 * Source value for a channel value — the decode side of the encode the
	 * query performs. A dim id with identity, a display position without.
	 */
	categoryAt(channelValue: number, displayed: readonly DimValue[]): DimValue | undefined {
		if (!this.hasIdentity) return displayed[channelValue];
		return this.#identity!.values[channelValue];
	}

	/**
	 * The inverse: the channel value a source value is carried as, or null when
	 * this axis does not know it.
	 *
	 * For a caller holding a VALUE that needs a key — a label whose channel came
	 * back as raw categories, a legend entry, a toggle. A caller already holding
	 * a channel value has the key and must not come through here.
	 *
	 * Both directions are a lookup, never a scan: with identity the dim's own
	 * map, and without it a value -> position map cached against the array it
	 * was built from. That cache is what keeps a per-frame consumer off an
	 * indexOf per item, since the positions of an axis mid-transition are asked
	 * for every label on every frame.
	 */
	channelValueFor(value: DimValue, displayed: readonly DimValue[]): number | null {
		if (this.hasIdentity) return this.#identity!.ids.get(value) ?? null;
		return this.#positionsOf(displayed).get(value) ?? null;
	}

	#positions: Map<DimValue, number> | null = null;
	#positionsFor: readonly DimValue[] | null = null;

	/**
	 * Keyed on the ARRAY rather than a version counter: every writer of a
	 * domain assigns a fresh array, so a reference comparison is exact and
	 * cannot miss a change that moved the domain without bumping a counter —
	 * freezing is one.
	 */
	#positionsOf(displayed: readonly DimValue[]): Map<DimValue, number> {
		if (this.#positions && this.#positionsFor === displayed) return this.#positions;
		const map = new Map<DimValue, number>();
		for (let i = 0; i < displayed.length; i++) map.set(displayed[i], i);
		this.#positions = map;
		this.#positionsFor = displayed;
		return map;
	}

	// =========================================================================
	// WHAT THE SCALE ASKS ABOUT
	// =========================================================================

	/** True once this field's dim exists and holds at least one value. */
	get hasIdentity(): boolean {
		return this.#identity?.present ?? false;
	}

	/** How many ids the dim holds — the width of a slot table over it. */
	get idCount(): number {
		return this.#identity?.values.length ?? 0;
	}

	/** How many marks have registered. */
	get markCount(): number {
		return this.#extents.size;
	}

	/** Each mark's registered categories, for a debug dump. */
	debugExtents(): Record<string, (DimValue | number)[]> {
		return Object.fromEntries([...this.#extents].map(([id, e]) => [id, e.categories]));
	}

	/**
	 * Which mark claimed which role, for a debug dump.
	 *
	 * The INPUT to display order rather than its output. An explicit domain
	 * outranks a ranking and a ranking outranks first appearance, so when an
	 * axis is in an order nobody asked for, which mark claimed what is the
	 * whole question, and the resolved list cannot answer it.
	 */
	debugRoles(): Record<string, string | null> {
		return Object.fromEntries([...this.#extents].map(([id, e]) => [id, e.role]));
	}
}
