import { SvelteMap } from 'svelte/reactivity';

/**
 * Whether any of a chart's cells is on screen, for its marks to stop
 * re-querying while it is not (see MarkHandle.active).
 *
 * Owned by the chart container, which in facet mode holds the marks for many
 * cells: the marks stay active while any cell is visible. Each cell reports
 * what the GPU coordinator's IntersectionObserver and page visibility say
 * about it; the observer has a 200 px margin, so a chart counts as visible
 * just before it scrolls in. A cell that has not reported counts as visible,
 * as it does for the coordinator, so nothing is held back before the first
 * report.
 */
export class ChartVisibility {
	#cells = new SvelteMap<string, boolean>();

	/** A cell's visibility changed. */
	set(cellId: string, visible: boolean): void {
		this.#cells.set(cellId, visible);
	}

	/** A cell unmounted. */
	remove(cellId: string): void {
		this.#cells.delete(cellId);
	}

	/**
	 * True while any cell is visible, or none has reported. Reactive: it reads
	 * the SvelteMap. A getter, not a derived, since a chart has few cells.
	 */
	get visible(): boolean {
		if (this.#cells.size === 0) return true;
		for (const v of this.#cells.values()) if (v) return true;
		return false;
	}
}
