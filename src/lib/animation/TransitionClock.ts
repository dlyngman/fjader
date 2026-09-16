import { Spring } from './Spring';

/**
 * One data-update transition: a spring driving a normalised `t` from 0 to 1.
 *
 * Everything affected by the same data update runs on one of these, and shares
 * it. That is the feature rather than a compromise — elements with different
 * displacements move at proportionally different speeds and ARRIVE TOGETHER,
 * where independent springs finish raggedly. In a racing bar chart it is the
 * difference between a bar reaching its new rank as it finishes growing, and
 * reaching it visibly before or after.
 *
 * NOT THE SAME THING AS A PAN OR ZOOM SPRING, which is the distinction worth
 * holding on to. A continuous scale animates its domain because the VIEWPORT
 * moved; that spring belongs to the scale, drives its GPU state directly, and
 * has nothing to do with data. This one exists because a query RESULT landed.
 * They are both springs living near scales, which makes them look like one
 * concept, and driving a data morph from a pan spring would make panning morph
 * the data.
 *
 * WHO OWNS ONE. A data transition belongs to the mark whose data changed. The
 * exception is a categorical scale, which owns a SHARED clock that every mark
 * drawn against that axis adopts — because where a category sits is a property
 * of the axis and has to be arbitrated across the marks and facet cells that
 * share it. A mark adopts that clock when there is one and owns a clock
 * otherwise; never both, because two springs with two velocities are exactly
 * what the arrive-together property exists to prevent.
 *
 * WHY SHARING IS SAFE. A consumer folds when the clock restarts — its current
 * position becomes its new start. A consumer with no new data folds to where it
 * already is, so its start and destination are equal and it does not move,
 * whatever the clock does. That is why a dozen facet cells landing at a dozen
 * different times all behave, and it is a property of the fold rather than of
 * timing.
 *
 * THE COST, stated because it is real and nobody designed it: a consumer's
 * transition duration is decided by whoever restarts the clock. A sibling
 * restarting it every frame makes this consumer re-fold every frame, so it
 * converges by decelerating rather than along the curve the spring intended.
 */
export class TransitionClock {
	#spring: Spring;
	#precision: number;
	/**
	 * Where the driver is for the frame being DRAWN — extrapolated ahead of the
	 * last physics step, and clamped, since a read ahead of that step can cross
	 * 1 near the end of a transition.
	 */
	#renderT: number = 1;

	/**
	 * Bumped on every restart, and only on a restart.
	 *
	 * Consumers compare it to decide whether to fold. It deliberately does NOT
	 * move on settle: settling is not a new transition, and folding there is a
	 * copy of a buffer onto values equal to themselves — harmless, but work done
	 * for a reason that is not true.
	 */
	version: number = 0;

	constructor(stiffness: number, precision: number) {
		this.#precision = precision;
		this.#spring = new Spring(1, stiffness, precision);
	}

	/** Where the transition is, for the frame being drawn. 1 when settled. */
	get t(): number {
		return this.#renderT;
	}

	/**
	 * Begin again from 0, CARRYING VELOCITY.
	 *
	 * Assigning the fields rather than calling `set()`, which zeroes velocity: a
	 * result landing mid-flight continues at the speed it was travelling instead
	 * of stalling and re-accelerating.
	 *
	 * `t` is normalised, so a restart is continuous in `t` and not in world
	 * space — an element retargeted nearer decelerates abruptly, one retargeted
	 * further jumps. That is the other face of arriving together, not a defect.
	 */
	restart(): void {
		this.#spring.current = 0;
		this.#spring.target = 1;
		this.#renderT = 0;
		this.version++;
	}

	/**
	 * Land exactly on 1, with no interpolation.
	 *
	 * Snapped rather than left wherever the spring got to: a spring approaches
	 * asymptotically and rest is declared at an epsilon, so leaving `t` fractionally
	 * short would leave every element fractionally short of its destination —
	 * and a staggered `t`, which divides by `(1 - phase)`, shorter still.
	 */
	settle(): void {
		this.#spring.set(1);
		this.#renderT = 1;
	}

	/** Advance physics by one fixed timestep. Must not touch render state. */
	step(): void {
		this.#spring.step();
	}

	/** Record where the driver is for this frame, extrapolated and clamped. */
	updateRenderState(extrapolationDt: number): void {
		const t = this.#spring.getRenderable(extrapolationDt);
		this.#renderT = t < 0 ? 0 : t > 1 ? 1 : t;
	}

	/**
	 * Charts to redraw while this runs. Set by whoever owns the clock.
	 *
	 * A scale's clock does not use this — the scale is what the loop drives, and
	 * it supplies its own usage set. A clock owned by a mark is registered
	 * directly, and this is how it says what to repaint.
	 */
	_affectedChartsArray: string[] = [];

	/** Called by the loop when this stops. Lands exactly on 1. */
	_markAtRest(): void {
		this.settle();
	}

	/**
	 * Whether the loop can stop driving this.
	 *
	 * One comparison, not a scan over everything animating — which is the
	 * practical payoff of one clock, and why rest arrives for every consumer at
	 * the same moment.
	 */
	isAtRest(): boolean {
		return this.#spring.isAtRest(this.#precision);
	}
}
