import { SvelteSet } from 'svelte/reactivity';

/**
 * How long after its last wheel event a wheel zoom still counts as a gesture:
 * wheel events have no end. The tooltip table's debounce after a data change.
 */
export const WHEEL_GESTURE_MS = 300;

/**
 * Whether the pointer is over any of a chart's cells: hover intent, for work
 * worth doing only when someone is about to hover a mark, such as writing its
 * tooltip table.
 *
 * And whether a pan or zoom gesture is under way on any of them: no tooltip is
 * shown and no click resolved while it is, so work for those can wait for its
 * end.
 *
 * Owned by the chart container, which in facet mode holds the marks for many
 * cells, as ChartVisibility is. Cells report pointer enter and leave, a pan's
 * start and stop, and each wheel zoom.
 */
export class ChartHover {
	#cells = new SvelteSet<string>();
	#panning = new SvelteSet<string>();
	#wheeling = $state(false);
	#lastWheel = 0;
	#wheelTimer: ReturnType<typeof setTimeout> | null = null;

	set(cellId: string, hovered: boolean): void {
		if (hovered) this.#cells.add(cellId);
		else this.#cells.delete(cellId);
	}

	/** True while the pointer is over any cell. Reactive. */
	get hovered(): boolean {
		return this.#cells.size > 0;
	}

	/** A cell's pan (or touch zoom) started or stopped. */
	pan(cellId: string, active: boolean): void {
		if (active) this.#panning.add(cellId);
		else this.#panning.delete(cellId);
	}

	/**
	 * A wheel zoom on a cell: a gesture until WHEEL_GESTURE_MS after the last
	 * one. One timer per gesture, pushed back by the events that follow, so a
	 * stream of wheel events sets no timer each.
	 */
	wheel(now: number = performance.now()): void {
		this.#lastWheel = now;
		if (this.#wheelTimer !== null) return;
		this.#wheeling = true;
		const settle = () => {
			const left = this.#lastWheel + WHEEL_GESTURE_MS - performance.now();
			if (left > 0) {
				this.#wheelTimer = setTimeout(settle, left);
				return;
			}
			this.#wheelTimer = null;
			this.#wheeling = false;
		};
		this.#wheelTimer = setTimeout(settle, WHEEL_GESTURE_MS);
	}

	/** True while a pan or zoom gesture is under way on any cell. Reactive. */
	get gesturing(): boolean {
		return this.#panning.size > 0 || this.#wheeling;
	}

	destroy(): void {
		if (this.#wheelTimer !== null) clearTimeout(this.#wheelTimer);
		this.#wheelTimer = null;
	}
}
