/**
 * Re-arms a hovered chart's preagg sources once things have settled.
 *
 * Activation runs when the pointer enters a chart, but a filter change made
 * while the pointer stays on it (a Toggle click, then a drag on its brush)
 * invalidates tables that bake the changed clause, and so does a view change
 * (zoom in, resize). Re-running the activators on every change would start
 * builds in the gaps between drag frames and block the frames after them, so
 * this waits for quiet instead: no filter change and no view change for one
 * interval, and no pointer held. That covers clicks, drag ends, pans, zooms,
 * animated domain resets and resizes without listing them.
 *
 * One timer while the chart is hovered, ticking every interval. Changes are
 * not timed individually: filter changes are read as the engine's last-change
 * timestamp, and the view as six numbers compared in place on each tick, so an
 * animated reset that moves the view every frame costs nothing per frame.
 */

export interface HoverSettleOpts {
	/** Quiet time before re-arming, in ms. */
	interval: number;
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
	#lastViewChangeAt = 0;
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
		this.#timer = this.#opts.setTimer(() => this.#tick(), this.#opts.interval);
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

		const lastChange = Math.max(this.#opts.lastFilterChangeAt(), this.#lastViewChangeAt);
		// >= so a change in the same millisecond as entering still re-arms; a spare
		// re-arm costs nothing, since activation skips tables that are still valid.
		if (!this.#held && lastChange >= this.#armedAt && now - lastChange >= this.#opts.interval) {
			this.#armedAt = now;
			this.#opts.settle();
		}
		this.#schedule();
	}
}
