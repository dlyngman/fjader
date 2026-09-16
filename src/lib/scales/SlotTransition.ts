import { TransitionClock } from '$lib/animation';

/**
 * Where every category of a band axis sits, and how it gets there.
 *
 * The indirection that lets identity and position be different things: a query
 * supplies a stable id that never changes when the chart reorders, and the slot
 * table says where that id currently sits. A reorder rewrites the table and
 * leaves the SQL, the vertex buffers and the preagg cubes alone.
 *
 * Owns the slot arrays, the clock they travel on, and the rules for entering,
 * leaving and folding. Knows nothing about categories, domains or identity: it
 * is handed a display order over some id space, and answers in typed arrays.
 * `BandScaleState` decides WHAT is displayed; this decides where it is on screen
 * while that changes.
 *
 * ARRAYS, all indexed by id and all the same length:
 *
 * | | |
 * |---|---|
 * | `target` | where each id is HEADED once settled; -1 if not displayed |
 * | `from`, `to` | the two ends of the transition in flight |
 * | `table` | `mix(from, to, t)` — where each id is NOW |
 *
 * `to` and `target` disagree about exactly one kind of id: one that is leaving,
 * which is -1 in `target` and its exit gateway in `to`, for the length of its
 * exit. `#exiting` records which.
 *
 * THE INVARIANT everything leans on: a hidden id holds -1 in BOTH `from` and
 * `to`, and nothing ever interpolates between a real slot and -1. So
 * `mix(from, to, t)` needs no sentinel branch, in JS or in the GPU resolve
 * kernel, and the two compute the same expression from the same inputs.
 */

/** What joining the animation loop needs. */
export interface SlotLoop {
	addAnimatedSource(source: TransitionClock): void;
}

export class SlotTransition {
	#loop: SlotLoop | null;

	#target: Float32Array = new Float32Array(0);
	#current: Float32Array = new Float32Array(0);
	/**
	 * The t `#current` was computed at, or NaN when from/to have moved since.
	 *
	 * Keyed on t rather than invalidated per frame, so nothing has to say a frame
	 * happened — the loop drives the clock, not this.
	 */
	#currentT: number = Number.NaN;
	/**
	 * Where each id's current transition STARTED.
	 *
	 * Rewritten by the fold on every retarget: a result landing mid-flight must
	 * continue from where things actually are, so the current position becomes
	 * the new `from` before `t` resets to 0.
	 */
	#from: Float32Array = new Float32Array(0);
	/**
	 * Where each id's current transition is GOING — the animated destination,
	 * which for a leaver is its gateway rather than the hidden sentinel.
	 */
	#to: Float32Array = new Float32Array(0);
	/**
	 * 1 for an id that is travelling OUT — no longer displayed, but still on
	 * screen until the clock reaches the far end.
	 *
	 * A leaver cannot simply take -1 as its destination: -1 is the not-displayed
	 * sentinel and the shader discards it before the slot lookup, so the bar
	 * would vanish on the frame the reorder landed. It has to hold a REAL slot
	 * for the whole exit.
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
	 * Which space the arrays are indexed in. See `layout`.
	 */
	#space: 'ids' | 'positions' = 'positions';
	#isAnimating: boolean = false;

	/**
	 * ONE clock for the whole axis, driving a normalised `t` from 0 to 1 across
	 * every id at once — not one spring per category.
	 *
	 * A transition is per DATA UPDATE, not per category: everything that moves
	 * does so because the same result landed. Sharing `t` is the feature rather
	 * than a compromise — ids have different displacements, so one clock moves
	 * them at proportionally different speeds and makes them ARRIVE TOGETHER,
	 * where independent springs finish raggedly.
	 *
	 * It also gives a departing id a single moment at which to be retired: rest.
	 *
	 * The costs, stated rather than hidden: `t` is normalised, so settle DURATION
	 * is independent of distance — a one-band correction takes as long as a full
	 * reorder — and a mid-flight retarget is continuous in `t` but not in world
	 * space. Both are the other face of arriving together.
	 */
	readonly clock: TransitionClock = new TransitionClock({ onRest: () => this.#onClockRest() });

	/**
	 * The id of the axis's synthetic "Other" bucket, or null when it has none.
	 *
	 * It is where entrances and exits come from and go to when it exists,
	 * because with an Other bucket that is literally true: a category dropping
	 * out of the top N does not leave the chart, its value moves INTO Other, and
	 * one climbing in is value coming back OUT of it. Travelling past the end of
	 * the axis would say the opposite — that it went somewhere else.
	 *
	 * An id that is never displayed is INERT here, and that is a guarantee rather
	 * than a coincidence: the gateway is read from `target`, so an Other that no
	 * row carries holds -1 and the gateway falls back to the far end.
	 */
	otherId: number | null = null;

	/**
	 * Bumped whenever `from` or `to` move — a retarget, a fold, a settle. The
	 * packer compares this rather than the array contents, so a frame where only
	 * t moved uploads four bytes and nothing else. Writing either array without
	 * bumping this leaves the GPU on the old one.
	 */
	version: number = 0;

	/**
	 * `loop` is null when nothing can drive the clock — every unit test, and a
	 * scale built before a coordinator is wired up. Transitions then land
	 * instantly rather than being lost.
	 */
	constructor(loop: SlotLoop | null = null) {
		this.#loop = loop;
	}

	/** How many ids the arrays hold — the packer's count header. */
	get count(): number {
		return this.#target.length;
	}

	/**
	 * Where each id is NOW: `mix(from, to, t)`, or -1 when not displayed.
	 *
	 * Computed on demand rather than maintained. The GPU never reads it — it
	 * resolves the same mix in a compute pass — so a per-frame walk of every id
	 * would produce a value nothing reads. It is the honest answer to "where is
	 * everything", for the fold, for tests, and for axis labels.
	 */
	get table(): Float32Array {
		const t = this.clock.t;
		if (this.#currentT !== t) {
			this.#writeCurrent(t);
			this.#currentT = t;
		}
		return this.#current;
	}

	/** Where each id is headed once settled; -1 for an id not displayed. */
	get target(): Float32Array {
		return this.#target;
	}

	get from(): Float32Array {
		return this.#from;
	}

	get to(): Float32Array {
		return this.#to;
	}

	/** Extrapolated for the frame being drawn, not the last physics step. */
	get t(): number {
		return this.clock.t;
	}

	/** True while the clock is in the loop. */
	get isAnimating(): boolean {
		return this.#isAnimating;
	}

	/**
	 * Lay the axis out in a new display order, travelling there from wherever
	 * everything is now.
	 *
	 * `order` lists ids in display order; null means the identity permutation
	 * over `idCount`. `idCount` is how many ids the arrays cover, which may be
	 * more than are displayed: everything not listed is -1 — filtered out by a
	 * transform, or belonging to another table on a shared scale.
	 *
	 * `space` says what an index MEANS: a dim id, or a display position for an
	 * axis that has no identity yet. Crossing that boundary changes what every
	 * entry means. Carrying positions across it hands the id space numbers that
	 * were never id-indexed, and the length alone cannot tell — the two spaces
	 * are usually the same size — so the first real layout of a chart looked like
	 * a reorder and the bars slid in from nowhere. The boundary is therefore
	 * treated as the start of a new axis: state is dropped, and the layout after
	 * it is a first layout, which snaps.
	 *
	 * A dim that merely GROWS is not that case (the Other reservation appends
	 * one). The space is unchanged, existing ids keep their paths, and the copy
	 * on resize is exactly right.
	 */
	layout(space: 'ids' | 'positions', order: ArrayLike<number> | null, idCount: number): void {
		if (space !== this.#space) {
			this.#space = space;
			this.#discard();
		}

		// The plain inverse of the display order: an array walk, no Map.
		const target = this.#resize(idCount);
		target.fill(-1);
		const shown = order ? order.length : idCount;
		for (let slot = 0; slot < shown; slot++) {
			const id = order ? order[slot] : slot;
			if (id >= 0 && id < target.length) target[id] = slot;
		}

		this.#retarget(shown);
	}

	/**
	 * Start a transition without changing what is displayed.
	 *
	 * For a mark whose VALUES changed while the ranking did not — the ordinary
	 * crossfilter step, and the normal case during a drag when re-ranking is held
	 * until release. Nothing reorders, so nothing else would restart the clock,
	 * and the mark's values would jump.
	 *
	 * The slots are a consumer of the clock too, and fold like any other. The
	 * destinations are unchanged, but `t` is about to go back to 0, so `from` has
	 * to become where every id is NOW — or a restart that lands mid-reorder sends
	 * every bar back to where that reorder began.
	 */
	startTransition(): void {
		this.#from.set(this.table);
		this.#restartFolded();
		this.version++;
	}

	/** The arrays, copied, for a debug dump. */
	debugState() {
		return {
			slotCurrent: Array.from(this.table),
			slotTarget: Array.from(this.#target),
			slotFrom: Array.from(this.#from),
			slotTo: Array.from(this.#to),
			exiting: Array.from(this.#exiting),
			// The RENDER t — the one slotCurrent was computed from.
			t: this.clock.t
		};
	}

	/**
	 * Forget everything positional, so the next layout is a first layout.
	 *
	 * Lengths go to zero rather than being refilled: that is what stops
	 * #resize's unchanged-length fast path from preserving the arrays it is being
	 * asked to throw away.
	 */
	#discard(): void {
		this.#target = new Float32Array(0);
		this.#current = new Float32Array(0);
		this.#from = new Float32Array(0);
		this.#to = new Float32Array(0);
		this.#exiting = new Uint8Array(0);
		this.clock.settle();
		this.#hasLaidOut = false;
	}

	/**
	 * Size every array to `length`, returning the target for filling.
	 *
	 * Reuses everything when the length is unchanged, which is every reorder —
	 * the dim only grows when a second table appends.
	 *
	 * On a grow, existing ids KEEP where they currently are and the path they are
	 * on, so a dim append mid-transition does not teleport the categories already
	 * on screen. New ids start at -1, which is "not displayed" and makes them
	 * enter by the same route as any other newcomer. -1 rather than 0 because 0
	 * would mean "at slot 0", and the first paint would animate outward from
	 * there.
	 */
	#resize(length: number): Float32Array {
		if (this.#target.length === length) return this.#target;

		const keep = Math.min(this.#current.length, length);
		const grown = (old: Float32Array) => {
			const next = new Float32Array(length);
			next.fill(-1);
			next.set(old.subarray(0, keep), 0);
			return next;
		};
		this.#current = grown(this.#current);
		this.#from = grown(this.#from);
		this.#to = grown(this.#to);

		const exiting = new Uint8Array(length);
		exiting.set(this.#exiting.subarray(0, keep), 0);
		this.#exiting = exiting;

		this.#target = new Float32Array(length);
		return this.#target;
	}

	/**
	 * Fold, then point every id at its new slot, and wake the loop if anything
	 * has somewhere to go. `shown` is how many slots are displayed.
	 */
	#retarget(shown: number): void {
		// Where everything actually is, before anything is overwritten — the fold's
		// input. Through the getter: #current is computed on demand, and a retarget
		// arriving between frames must see this frame's positions.
		const current = this.table;
		const target = this.#target;
		const from = this.#from;
		const to = this.#to;
		const exiting = this.#exiting;
		// Where an entrance comes from and an exit goes to.
		//
		// Other's slot when the axis has an Other bucket on screen: a category
		// leaving the top N has its value absorbed there, so that IS where it went.
		//
		// Otherwise one past the last displayed slot. Off the end of the axis so
		// the scissor rect clips it, and non-negative so it survives the shader's
		// `slot < 0.0` discard on the way through — that pair is what makes travel
		// expressible at all without a second per-id channel.
		const far = shown;
		const otherId = this.otherId;
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
				// THE FOLD. An id already on screen continues from where it actually
				// is, not from where its last transition began — a result landing at
				// t = 0.4 must not restart the journey. For an id mid-exit this is
				// also what reverses it in place.
				//
				// Entering instead starts at the gateway — except on a first layout,
				// where there is nothing to enter from, so it starts where it lands.
				from[id] = onScreen ? current[id] : settled ? trueTo : gateway;
				to[id] = trueTo;
			} else if (onScreen && !settled) {
				// Leaving. Keep a REAL slot and walk out; the hidden sentinel is
				// applied by #settle once it arrives, not now.
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

		if (shown > 0) this.#hasLaidOut = true;

		// An animation nobody can drive has to be an instant transition, not a lost
		// one: t only advances while the loop holds the clock.
		if (moving && this.#loop) {
			this.#restartFolded();
		} else {
			this.#settle();
		}

		this.version++;
	}

	/**
	 * Write #current = mix(from, to, t).
	 *
	 * Deliberately NOT a function of #target. The fold reads this, and `layout`
	 * has already overwritten the target with the NEW order by then: consulting
	 * it here marked a category that had just left as never on screen, so it
	 * vanished instead of travelling out.
	 */
	#writeCurrent(t: number): void {
		const current = this.#current;
		const from = this.#from;
		const to = this.#to;
		for (let id = 0; id < current.length; id++) {
			current[id] = from[id] + (to[id] - from[id]) * t;
		}
	}

	/**
	 * Land every id exactly on its TRUE target — for a leaver the hidden
	 * sentinel, not the gateway it was walking toward. This is where an exit
	 * completes.
	 *
	 * Snaps t to exactly 1: a spring approaches asymptotically and rest fires at
	 * an epsilon, and a table at rest holding 2.0003 is one whose next retarget
	 * springs from a number that was never a slot.
	 */
	#settle(): void {
		const target = this.#target;
		this.clock.settle();
		this.#currentT = 1;
		for (let i = 0; i < target.length; i++) {
			this.#current[i] = target[i];
			this.#from[i] = target[i];
			this.#to[i] = target[i];
			this.#exiting[i] = 0;
		}
	}

	/**
	 * Restart the clock once `from` already holds where everything is, and join
	 * the loop.
	 *
	 * The restart CARRIES VELOCITY, so a transition interrupted mid-flight
	 * continues at the speed it was travelling. #current is marked stale rather
	 * than written: at t = 0 it equals the folded `from`.
	 */
	#restartFolded(): void {
		this.clock.restart();
		this.#currentT = Number.NaN;
		if (!this.#isAnimating && this.#loop) {
			this.#isAnimating = true;
			this.#loop.addAnimatedSource(this.clock);
		}
	}

	/** The loop settled the clock: land, retire the leavers, and say the tables moved. */
	#onClockRest(): void {
		this.#isAnimating = false;
		this.#settle();
		this.version++;
	}
}
