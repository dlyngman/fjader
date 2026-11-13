import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

/** What `shownElsewhere` asks: which charts draw a scale, and which are visible. */
export interface ChartVisibilityPeers {
	chartsUsing(scale: object): readonly string[];
	isChartVisible(chartId: string): boolean;
}

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
	#peers: ChartVisibilityPeers | null;

	constructor(peers: ChartVisibilityPeers | null = null) {
		this.#peers = peers;
	}

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

	/**
	 * Whether a chart other than this one is visible and draws `scale`, so
	 * that changing the scale moves something in view. A chart catching up on
	 * its return snaps its own parts but springs a scale like this: the chart
	 * being watched moves through the scale, as it would for any change.
	 *
	 * Asked when a result lands, not when it was sent: visibility changes
	 * during a scroll. "Visible" is the coordinator's: it includes the 200 px
	 * margin, so a chart in the margin, which nobody sees yet, still counts and
	 * keeps the spring. Untracked: a point-in-time answer, asked from inside
	 * effects that must not re-run when a cell scrolls.
	 */
	shownElsewhere(scale: object): boolean {
		const peers = this.#peers;
		if (!peers) return false;
		return untrack(() => {
			for (const chartId of peers.chartsUsing(scale)) {
				if (this.#cells.has(chartId)) continue;
				if (peers.isChartVisible(chartId)) return true;
			}
			return false;
		});
	}
}
