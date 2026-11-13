/**
 * Holds a chart's entrance until its marks have their first data.
 *
 * Without it the entrance started on the FIRST mark to land, which had two
 * visible costs. Later marks widened the domain while the chart was entering,
 * so its axes animated to the wider extent: a small version of the camera
 * move the entrance replaced. And a mark landing mid-entrance joined it part
 * way. Held, every mark's extent is in before anything shows, the scales snap
 * to the union, and the chart enters once, whole.
 *
 * A data mark HOLDS when it mounts and RELEASES when its first result has
 * registered its domains, when its query fails, or when it unmounts. A mark
 * the author knows to be slow can opt out (`holdsEntrance={false}`): it then
 * joins the entrance where it is, or appears after it.
 *
 * Nothing needs hiding while a chart waits: before its entrance starts the
 * chart's entrance value is 0, so marks that have landed draw at zero height
 * or zero opacity.
 *
 * OPEN is one-way. The gate opens when its last hold is released, when the
 * coordinator starts the entrance (a chart that never had a hold), or on a
 * timeout. The timeout is armed by the FIRST release rather than the first
 * hold: the wait for DuckDB to start, which can take seconds on a cold page,
 * is not a slow mark, and a chart that has not answered at all has nothing to
 * show yet anyway. A gate stuck closed would leave a chart invisible, which is
 * far worse than a late mark appearing after the rest.
 */

/** How long the rest of a chart waits for its slowest mark, from its fastest. */
export const ENTRANCE_HOLD_TIMEOUT_MS = 1000;

export class EntranceGate {
	#holds = new Set<string>();
	#opened = false;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#listeners = new Set<() => void>();

	/** True once the gate has opened. One-way. */
	get opened(): boolean {
		return this.#opened;
	}

	/**
	 * Whether the chart may enter: open, or nothing is holding it. The second
	 * covers a chart with no data marks, which the coordinator then opens.
	 */
	get canEnter(): boolean {
		return this.#opened || this.#holds.size === 0;
	}

	/** A mark waits on its first data. Ignored once the gate has opened. */
	hold(id: string): void {
		if (this.#opened) return;
		this.#holds.add(id);
	}

	/** A mark has its first data, failed, or left. Unknown ids are ignored. */
	release(id: string): void {
		if (!this.#holds.delete(id)) return;
		if (this.#holds.size === 0) this.open();
		else this.#timer ??= setTimeout(() => this.open(), ENTRANCE_HOLD_TIMEOUT_MS);
	}

	/** Open now, and tell whoever is waiting. Idempotent. */
	open(): void {
		if (this.#opened) return;
		this.#opened = true;
		this.#holds.clear();
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		for (const fn of this.#listeners) fn();
		this.#listeners.clear();
	}

	/**
	 * Run `fn` when the gate opens: at once if it already has. Returns an
	 * unsubscribe, for a listener torn down first.
	 */
	onOpen(fn: () => void): () => void {
		if (this.#opened) {
			fn();
			return () => {};
		}
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	/** Drop the timer and listeners, for a chart being torn down. */
	destroy(): void {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		this.#listeners.clear();
	}
}
