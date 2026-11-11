import { TransitionClock, type ClockLoop } from '$lib/animation';

/**
 * Stiffness for a selection fade: ~0.25 s to settle, against ~0.32 s for a data
 * transition (TRANSITION_STIFFNESS, 240). A click should feel immediate; the
 * charts it filters take their own time to re-query and morph.
 */
export const SELECTION_STIFFNESS = 400;

/**
 * How visible an inactive category is, by default: marks are drawn at this
 * opacity (the shaders' SELECTION_DIM_STRENGTH is 1 - this), and
 * band labels fade to it.
 */
export const DEFAULT_INACTIVE_OPACITY = 0.25;

/**
 * How visible a category is for its activity: `inactiveOpacity` when
 * unselected, 1 when selected, and in between mid-fade.
 *
 * The CPU twin of the shaders' `selectionDim`, which computes the same thing as
 * `1 - dimStrength * (1 - activity)` with `dimStrength = 1 - inactiveOpacity`.
 * Band labels and legend entries use this, so they match the marks.
 */
export function selectionOpacity(
	activity: number,
	inactiveOpacity: number = DEFAULT_INACTIVE_OPACITY
): number {
	return inactiveOpacity + (1 - inactiveOpacity) * activity;
}

/**
 * Which categories of a scale are selected, and how far each one has faded.
 *
 * One float per identity id: 1 active, 0 inactive. A categorical scale owns one
 * of these beside its slots, and the shaders read it through the same id they
 * already resolve to a slot, so every mark drawn against the scale dims its
 * inactive categories without knowing whether it is the source of the
 * selection, filtered by it, or outside the filter group.
 *
 * The same shape as SlotTransition, on its own clock: `from` and `to` are the
 * two ends of the fade, the value NOW is `mix(from, to, t)`, the GPU computes it
 * for every id, and `activityOf` for the few a CPU consumer asks about. A
 * SEPARATE clock from the slots', because a click changes what is selected
 * without changing any data, and a data update has nothing to do with dimming.
 * One `t` for every id, not a spring per category: everything fading because of
 * one click arrives together, and there is one moment of rest.
 */
export class ActivityTable {
	#from: Float32Array = new Float32Array(0);
	#to: Float32Array = new Float32Array(0);
	/**
	 * Where a new selection is computed before it is compared with `to`. Reused,
	 * because `setActive` is called on every filter update, and most of those
	 * (every brush move on some other field) change nothing here.
	 */
	#scratch: Float32Array = new Float32Array(0);
	/** Whether some categories are selected, which decides what a new id starts as. */
	#selecting = false;

	/**
	 * Bumped whenever `from` or `to` change: a selection, a resize, a settle. The
	 * packer compares this rather than the contents, so a frame where only `t`
	 * moved uploads nothing.
	 */
	version: number = 0;

	readonly clock: TransitionClock;

	#onFrame: (() => void) | null;

	/**
	 * `charts` is required: the loop redraws only the charts a clock names, so a
	 * fade whose clock named none would animate without anything redrawing it.
	 * `loop` is null in unit tests and before a coordinator exists, and then a
	 * fade lands at once. `onFrame` is called for every driven frame and once
	 * more at rest, for CPU consumers such as axis labels.
	 */
	constructor(
		loop: ClockLoop | null,
		options: { charts: () => string[]; onFrame?: () => void; stiffness?: number }
	) {
		this.#onFrame = options.onFrame ?? null;
		this.clock = new TransitionClock({
			loop,
			charts: options.charts,
			stiffness: options.stiffness ?? SELECTION_STIFFNESS,
			onRest: () => this.#onClockRest(),
			onFrame: this.#onFrame ?? undefined
		});
	}

	/** How many ids the table covers. */
	get count(): number {
		return this.#to.length;
	}

	get from(): Float32Array {
		return this.#from;
	}

	get to(): Float32Array {
		return this.#to;
	}

	/** Extrapolated for the frame being drawn. 1 when settled. */
	get t(): number {
		return this.clock.t;
	}

	/** True while the clock is in the loop. */
	get isAnimating(): boolean {
		return this.clock.running;
	}

	/**
	 * How active one id is now, 0..1. An id outside the table is fully active,
	 * the same answer the shader gives for an id past the block's count.
	 */
	activityOf(id: number): number {
		const f = this.#from[id];
		if (f === undefined) return 1;
		return f + (this.#to[id] - f) * this.clock.t;
	}

	/**
	 * Cover `count` ids. Existing ids keep their fade; new ones snap to their
	 * state rather than fading in.
	 *
	 * `active` is the selection the new ids join, as ids: null for none, so
	 * every new id is active. Without it, a new id is inactive while something
	 * is selected, since a category that did not exist when the selection was
	 * made is not part of it. Passing it matters when the selection was made
	 * before the ids existed (before identity landed, or across a reload): the
	 * table has not seen it, and a new id it names must start selected rather
	 * than fade in from 0, and one it does not name must start dim rather than
	 * fade down from 1.
	 *
	 * `resize(0)` drops every id, for ids that stopped meaning their category.
	 *
	 * `trailing`: the last slot is not an id but a slot of its own that stays
	 * last (FieldActivity's free slot). Its fade moves to the new end, and the
	 * slot it leaves is a new id like any other, rather than inheriting it.
	 */
	resize(count: number, active?: readonly number[] | null, trailing = false): void {
		if (count === this.#to.length) return;
		const oldLength = this.#to.length;
		const tail = trailing && oldLength > 0 && count > 0;
		const keep = tail ? Math.min(oldLength - 1, count - 1) : Math.min(oldLength, count);
		const ids = tail ? count - 1 : count;
		const selecting = active === undefined ? this.#selecting : active !== null;
		const fill = selecting ? 0 : 1;
		const grown = (old: Float32Array) => {
			const next = new Float32Array(count);
			next.fill(fill);
			next.set(old.subarray(0, keep), 0);
			if (active) {
				for (const id of active) if (id >= keep && id < ids) next[id] = 1;
			}
			if (tail) next[count - 1] = old[oldLength - 1];
			return next;
		};
		this.#from = grown(this.#from);
		this.#to = grown(this.#to);
		this.#scratch = new Float32Array(count);
		this.version++;
	}

	/**
	 * Select exactly these ids; every other id fades out. Ids outside the table
	 * are ignored. Does nothing when the selection is the one already headed to.
	 */
	setActive(ids: Iterable<number>): void {
		const next = this.#scratch;
		next.fill(0);
		for (const id of ids) {
			if (id >= 0 && id < next.length) next[id] = 1;
		}
		this.#selecting = true;
		this.#retarget(next);
	}

	/** Nothing selected: every id fades back to active. */
	clear(): void {
		const next = this.#scratch;
		next.fill(1);
		this.#selecting = false;
		this.#retarget(next);
	}

	/** Leave the loop, for an owner being torn down. Later changes land at once. */
	destroy(): void {
		this.clock.stop();
	}

	/**
	 * Fold, point every id at its new state, and wake the loop.
	 *
	 * Returns early when `next` equals `to`: the fade already in flight (or the
	 * rest already reached) is headed exactly there, and restarting it would
	 * re-fold and bump the version for nothing, on every filter update.
	 */
	#retarget(next: Float32Array): void {
		const from = this.#from;
		const to = this.#to;
		let changed = false;
		for (let id = 0; id < to.length; id++) {
			if (to[id] !== next[id]) {
				changed = true;
				break;
			}
		}
		if (!changed) return;

		// THE FOLD: every id continues from where it is now, so a click landing
		// mid-fade reverses or redirects it in place instead of jumping.
		const t = this.clock.t;
		for (let id = 0; id < to.length; id++) {
			from[id] += (to[id] - from[id]) * t;
			to[id] = next[id];
		}
		this.clock.restart();
		this.version++;
	}

	/**
	 * Land exactly on `to`. A spring rests at an epsilon, and a table left at
	 * 0.0003 would start its next fold from a value that was never a state.
	 */
	#settle(): void {
		this.clock.settle();
		this.#from.set(this.#to);
	}

	#onClockRest(): void {
		this.#settle();
		this.version++;
		// The last frame, at exactly t = 1, which the loop's final frame was not.
		this.#onFrame?.();
	}
}
