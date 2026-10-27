/**
 * Re-arms a hovered chart's preagg sources once things have settled.
 *
 * Activation runs when the pointer enters a chart, but a filter change made
 * while the pointer stays on it (a Toggle click, then a drag on its brush)
 * invalidates tables that bake the changed clause, and so does a view change
 * (zoom in, resize). Re-running the activators on every change would start
 * builds in the gaps between drag frames and block the frames after them, so
 * this waits for quiet instead: no filter change for one interval, no view
 * change for a shorter one, and no pointer held. That covers clicks, drag
 * ends, pans, zooms, animated domain resets and resizes without listing them.
 *
 * Filters wait longer because clicks come in bursts (a multi-select has
 * 100–200 ms between clicks). A pan or zoom has no such gaps: wheel and
 * momentum events keep moving the view until the gesture ends. The view
 * should be where it is heading (a domain's spring target), not where it is
 * on screen, so the wait starts when the input stops rather than when the
 * spring comes to rest.
 *
 * One timer while the chart is hovered, ticking at `tick`, well under either
 * interval, so quiet is noticed promptly. Changes are not timed individually:
 * filter changes are read as the engine's last-change timestamp, and the view
 * as six numbers compared in place on each tick, so an animated reset that
 * moves the view every frame costs nothing per frame.
 */

export interface HoverSettleOpts {
	/** Quiet time after a filter change before re-arming, in ms. */
	filterInterval: number;
	/** Quiet time after a view change before re-arming, in ms. */
	viewInterval: number;
	/** How often to check, in ms. */
	tick: number;
	/** When a filter last changed, on the same clock as `now`. */
	lastFilterChangeAt: () => number;
	/** Writes the chart's view (x/y domains and inner size) into `out`. */
	view: (out: Float64Array) => void;
	/** Re-runs the chart's activators. */
	settle: () => void;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

export class HoverSettle {
	#opts: Required<HoverSettleOpts>;
	#timer: unknown = null;
	#held = false;
	#view = new Float64Array(6);
	#lastView = new Float64Array(6);
	#lastViewChangeAt = -Infinity;
	/** When the activators last ran: on entering, or the last settle. */
	#armedAt = 0;

	constructor(opts: HoverSettleOpts) {
		this.#opts = {
			now: () => performance.now(),
			setTimer: (fn, ms) => setTimeout(fn, ms),
			clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
			...opts
		};
	}

	/** The pointer entered the chart; its activators have just run. */
	enter(): void {
		this.#armedAt = this.#opts.now();
		this.#readView(this.#lastView);
		this.#schedule();
	}

	/** The pointer left the chart. */
	leave(): void {
		if (this.#timer != null) this.#opts.clearTimer(this.#timer);
		this.#timer = null;
		this.#held = false;
	}

	/** A pointer is pressed on the chart, or released (up, cancel, lost capture). */
	hold(held: boolean): void {
		this.#held = held;
	}

	#schedule(): void {
		this.#timer = this.#opts.setTimer(() => this.#tick(), this.#opts.tick);
	}

	#readView(out: Float64Array): void {
		out.fill(NaN);
		this.#opts.view(out);
	}

	#tick(): void {
		const now = this.#opts.now();

		this.#readView(this.#view);
		for (let i = 0; i < 6; i++) {
			if (Object.is(this.#view[i], this.#lastView[i])) continue;
			this.#lastViewChangeAt = now;
			this.#lastView.set(this.#view);
			break;
		}

		const lastFilter = this.#opts.lastFilterChangeAt();
		const lastView = this.#lastViewChangeAt;
		// >= so a change in the same millisecond as entering still re-arms; a spare
		// re-arm costs nothing, since activation skips tables that are still valid.
		const changed = Math.max(lastFilter, lastView) >= this.#armedAt;
		const quiet =
			now - lastFilter >= this.#opts.filterInterval && now - lastView >= this.#opts.viewInterval;
		if (!this.#held && changed && quiet) {
			this.#armedAt = now;
			this.#opts.settle();
		}
		this.#schedule();
	}
}
