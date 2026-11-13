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
/**
 * Stiffness for a data-update transition, and how to think about changing it.
 *
 * The spring is critically damped, so it never overshoots and the only knob is
 * how fast it converges: `omega = sqrt(stiffness)`, and it is within about a
 * percent of its destination after roughly `5 / omega` seconds. So 120 settles
 * in ~0.46s, 240 in ~0.32s, 400 in ~0.25s. Quadrupling the number halves the
 * time; it is not a linear dial.
 *
 * ONE NUMBER FOR SLOT AND VALUE, deliberately. A bar's position and its height
 * share a clock so they arrive together — separate springs desynchronise on a
 * retarget and the bar reaches its rank visibly before or after it finishes
 * growing. Wanting them to differ is a design change, not a constant.
 *
 * Note this is also the floor on how responsive a drag feels: `t` is
 * normalised, so settle DURATION is independent of distance and a one-pixel
 * correction takes as long as a full reorder.
 */
export const TRANSITION_STIFFNESS = 240;

/**
 * Stiffness for an entrance FADE: softer than a transition, since opacity has
 * no distance to travel and a fast fade reads as a pop. From rest it is a
 * gentle S-curve: 30% at 100 ms, 64% at 200 ms, 96% by 450 ms.
 */
export const ENTRANCE_FADE_STIFFNESS = 120;

/**
 * Stiffness for an entrance's GROWTH, launched at its own speed (see
 * `restartEaseOut`): 1 − e^(−ωt), 67% at 100 ms, 89% at 200 ms, 96% by 300 ms.
 * Slower than a data transition: growing from nothing is the chart's first
 * statement of magnitude, and at TRANSITION_STIFFNESS it was over before the
 * eye had settled on it.
 */
export const ENTRANCE_GROW_STIFFNESS = 120;

/** Sub-pixel, so rest is declared when the difference stops being visible. */
export const TRANSITION_PRECISION = 0.0005;

/**
 * The animation loop, as a clock sees it. The coordinator's fixed-timestep loop
 * is the one implementation; structurally typed so this module does not import
 * the GPU layer.
 */
export interface ClockLoop {
	addAnimatedSource(source: TransitionClock): void;
	removeAnimatedSource(source: TransitionClock): void;
}

/**
 * The empty redraw list, shared.
 *
 * A clock whose owner supplies no charts is asked for this on every frame the
 * loop drives it, so a fresh array here was an allocation per frame for a
 * reason that never changes. Never mutated: the loop only reads it.
 */
const NO_CHARTS: string[] = [];

export class TransitionClock {
	#spring: Spring;
	#precision: number;
	/**
	 * What drives this clock, or null when nothing can — a unit test, or a
	 * scale built without a coordinator. Then a restart lands immediately:
	 * `t` only advances while the loop holds the clock, so waiting for it would
	 * leave every consumer at t = 0 for good.
	 */
	#loop: ClockLoop | null;
	/** True from a restart until the loop settles or `stop` removes the clock. */
	#running = false;
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

	/**
	 * Called once the loop has settled this clock — after `t` has landed on 1.
	 *
	 * For an owner with state of its own to finish, which is what lets the loop
	 * drive the clock rather than the owner: a band scale retires its departing
	 * categories here.
	 */
	#onRest: (() => void) | null;
	/** Called after each frame's render t is recorded. */
	#onFrame: (() => void) | null;

	constructor(
		options: {
			loop?: ClockLoop | null;
			stiffness?: number;
			precision?: number;
			onRest?: () => void;
			onFrame?: () => void;
			charts?: () => string[];
		} = {}
	) {
		this.#loop = options.loop ?? null;
		this.#precision = options.precision ?? TRANSITION_PRECISION;
		this.#spring = new Spring(1, options.stiffness ?? TRANSITION_STIFFNESS, this.#precision);
		this.#onRest = options.onRest ?? null;
		this.#onFrame = options.onFrame ?? null;
		this.#charts = options.charts ?? null;
	}

	/** Where the transition is, for the frame being drawn. 1 when settled. */
	get t(): number {
		return this.#renderT;
	}

	/** True while the loop is driving this clock. */
	get running(): boolean {
		return this.#running;
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
	 *
	 * JOINS THE LOOP, so no owner has to remember to. The loop drops a clock
	 * when it settles, so this rejoins on every restart after that. With no loop
	 * the transition is over at once: settled, and `onRest` called before this
	 * returns — the same end state the loop would reach, reached now.
	 */
	restart(): void {
		this.#spring.current = 0;
		this.#spring.target = 1;
		this.#renderT = 0;
		this.version++;

		if (!this.#loop) {
			this._markAtRest();
			return;
		}
		if (!this.#running) {
			this.#running = true;
			this.#loop.addAnimatedSource(this);
		}
	}

	/**
	 * Begin from 0 at the spring's own speed, ω, for an ENTRANCE.
	 *
	 * From rest a critically damped spring starts slowly: its position grows as
	 * t² for the first frames, about 18% after 50 ms at the default stiffness.
	 * Between two states that is the right shape; for something appearing it
	 * reads as lag. Launched at ω the same spring follows 1 − e^(−ωt) exactly:
	 * an exponential ease-out, 54% after 50 ms, still never overshooting, and
	 * settling in the same time.
	 */
	restartEaseOut(): void {
		this.restart();
		this.#spring.velocity = this.#spring.omega;
	}

	/**
	 * Leave the loop without settling, for an owner being torn down. Nothing
	 * reads the clock afterwards, so there is nothing to land.
	 *
	 * TERMINAL, by releasing the loop rather than by a flag. `restart` already
	 * has the right behaviour for a clock with nothing to drive it — land at
	 * once — so a stopped clock reaches it by the path that was already there
	 * and already tested, instead of a second way of saying the same thing.
	 *
	 * Terminal matters because the owners that stop a clock are finished with
	 * it: a mark adopting a scale's clock stops the one it owned, and a scale
	 * the registry has dropped stops its own. Neither is reachable again, but
	 * a scale a component still holds can be laid out after that, and without
	 * this its clock would rejoin a loop whose owner is gone and animate for
	 * nobody. It now snaps instead, which is what a dead scale should do, and
	 * its slots still settle onto the new layout rather than being left mid
	 * transition.
	 */
	stop(): void {
		if (this.#running) {
			this.#running = false;
			this.#loop?.removeAnimatedSource(this);
		}
		this.#loop = null;
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
		this.#onFrame?.();
	}

	/**
	 * Charts to redraw while this runs, asked of the owner rather than written
	 * into the clock.
	 *
	 * The loop reads this on every frame it drives, so asking is also what
	 * makes it current: a facet grid registers its cells after the mark's
	 * first data has landed, and a value captured at construction would name
	 * the charts that existed before the grid did.
	 */
	get _affectedChartsArray(): string[] {
		return this.#charts?.() ?? NO_CHARTS;
	}

	#charts: (() => string[]) | null;

	/**
	 * Called by the loop when this stops, after removing it. Lands exactly on 1,
	 * then tells the owner — which may restart it, and rejoin, from `onRest`.
	 */
	_markAtRest(): void {
		this.#running = false;
		this.settle();
		this.#onRest?.();
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
