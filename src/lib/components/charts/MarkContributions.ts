/**
 * What a chart's marks contributed to its scales, owned by the chart and keyed
 * by mark id: the one identity that lives as long as a mark (unique per mount,
 * kept across the lifecycles the mark rebuilds).
 *
 * A mark's lifecycle is replaced whenever its config or scales change, so it
 * cannot own what it contributed: its successor takes that over, and only the
 * mark's unmount ends it. The chart outlives every lifecycle and knows every
 * mark, so it owns the record:
 *
 * - `place(markId, axis, state)` before a mark writes an extent: where its
 *   extent on that axis now lives. A move to another scale state (a changed
 *   column, a replaced scale) removes the mark from the old one, which may be
 *   shared with other charts and would otherwise stay too wide for good.
 * - `release(markId)` when the mark leaves: removes its extents from every
 *   state they are on, and remembers the id, so a write still in flight (a
 *   domain query landing after unmount) is refused rather than put back where
 *   nothing would remove it. Ids are unique per mount: a departed one never
 *   returns.
 *
 * Scale-type requirements and parallel columns are keyed by mark id where they
 * are stored (ChartScales); the chart unregisters them on release and refuses
 * new ones for a departed id (`departed`).
 *
 * `place` runs on every data update: a lookup, an identity comparison and a
 * set check, the entry per mark kept and updated in place.
 */
export type ExtentAxis = 'x' | 'y' | 'fx';

/** A scale state a mark's extent can be on: linear, time and band all key extents by mark id. */
export interface ExtentHolder {
	removeMark(id: string): unknown;
}

/**
 * A mark's `place`, bound to its chart and id: called before each extent
 * write, false when the mark has left (write nothing).
 */
export type PlaceExtent = (axis: ExtentAxis, state: ExtentHolder) => boolean;

interface MarkExtents {
	x: ExtentHolder | null;
	y: ExtentHolder | null;
	fx: ExtentHolder | null;
}

export class MarkContributions {
	#extents = new Map<string, MarkExtents>();
	#departed = new Set<string>();

	/** Whether this mark has left the chart: its writes are refused. */
	departed(markId: string): boolean {
		return this.#departed.has(markId);
	}

	/**
	 * Record that `markId`'s extent on `axis` is on `state`, before the mark
	 * writes it there. False when the mark has left: write nothing.
	 */
	place(markId: string, axis: ExtentAxis, state: ExtentHolder): boolean {
		if (this.#departed.has(markId)) return false;
		let entry = this.#extents.get(markId);
		if (!entry) {
			entry = { x: null, y: null, fx: null };
			this.#extents.set(markId, entry);
		}
		const previous = entry[axis];
		if (previous !== state) {
			previous?.removeMark(markId);
			entry[axis] = state;
		}
		return true;
	}

	/** The mark left: take its extents off every state they are on, and refuse its later writes. */
	release(markId: string): void {
		this.#departed.add(markId);
		const entry = this.#extents.get(markId);
		if (!entry) return;
		entry.x?.removeMark(markId);
		entry.y?.removeMark(markId);
		entry.fx?.removeMark(markId);
		this.#extents.delete(markId);
	}
}
