import { SvelteSet } from 'svelte/reactivity';

/**
 * Whether the pointer is over any of a chart's cells: hover intent, for work
 * worth doing only when someone is about to hover a mark, such as writing its
 * tooltip table.
 *
 * Owned by the chart container, which in facet mode holds the marks for many
 * cells, as ChartVisibility is. Cells report pointer enter and leave.
 */
export class ChartHover {
	#cells = new SvelteSet<string>();

	set(cellId: string, hovered: boolean): void {
		if (hovered) this.#cells.add(cellId);
		else this.#cells.delete(cellId);
	}

	/** True while the pointer is over any cell. Reactive. */
	get hovered(): boolean {
		return this.#cells.size > 0;
	}
}
