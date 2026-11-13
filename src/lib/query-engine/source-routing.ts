/**
 * Where an interaction read runs, by the source it reads: the main connection
 * (`runQuery`: no polling, no chunked fetch) or a sliced lane, where a slow
 * read interleaves with everyone else's instead of holding the worker.
 *
 * A COST RECORD PER SOURCE (the table a statement actually reads: a base table,
 * a view, or a preagg table): unknown, fast or slow.
 *
 * - Unknown and slow sources read on a lane; fast ones on the main connection.
 *   At load every source is unknown, so first reads are sliced: a slow source
 *   no longer holds up the other charts' setup.
 * - Only DATA reads update the record. A source's first statements are a
 *   DESCRIBE or a range query, quick even when its data query (a GROUP BY, a
 *   window, dense padding) is not.
 * - On a lane the measure is the poll count, taken in the worker: finished in
 *   its first slice or the next marks the source FAST, whatever its record
 *   was. Symmetric on purpose: the usual slow read is a cold one (remote
 *   parquet, a view slow the first time), and brushing that source later is
 *   quick; a "slow" that stuck would slice every brush frame for the session.
 * - More slices than that marks it SLOW, unless the result was large and its
 *   execution short: a 2M-row read passes two 5 ms slices on transfer and
 *   decode alone, the fetch phase barely holds the worker, and on a lane it
 *   would come back in ~1000 chunks (+~40 ms a frame). Large results stay on
 *   the main connection unless execution alone is long.
 * - On the main connection the measure is send-to-bytes time, taken on the
 *   main thread, so a busy frame inflates it: a fast source turns slow only
 *   after TWO consecutive slow reads.
 *
 * ORDER when a source changes lane. Its next read may go to the main
 * connection while an earlier one is still queued on its lane. Mark data
 * cannot overtake itself: execute-latest keeps at most one read of a mark in
 * flight, and the next waits for it. Setup reads are cached and order-free.
 * A future read without a callerId that cares about order must keep its
 * source's lane.
 */

export type SourceCost = 'unknown' | 'fast' | 'slow';

/** Past this many polls (slices after the first) a lane read was slow. */
export const FAST_POLLS = 1;
/** A main-connection read slower than this, twice running, turns its source slow. */
export const SLOW_MAIN_MS = 50;
/** A result this large is "large": it stays on the main connection... */
export const LARGE_ROWS = 200_000;
/** ...unless its execution alone takes longer than this. */
export const LARGE_EXEC_MS = 100;

interface Record {
	cost: SourceCost;
	/** Consecutive slow reads on the main connection. */
	mainSlow: number;
	/** The lane it sticks to while not fast. */
	lane: number;
}

export class SourceRouting {
	#records = new Map<string, Record>();
	#laneCount: number;
	/** Sources per lane, to place a new one on the least used. */
	#laneLoad: number[];

	constructor(laneCount: number) {
		this.#laneCount = laneCount;
		this.#laneLoad = new Array(laneCount).fill(0);
	}

	#of(source: string): Record {
		let r = this.#records.get(source);
		if (!r) {
			let lane = 0;
			for (let i = 1; i < this.#laneCount; i++) {
				if (this.#laneLoad[i] < this.#laneLoad[lane]) lane = i;
			}
			this.#laneLoad[lane]++;
			r = { cost: 'unknown', mainSlow: 0, lane };
			this.#records.set(source, r);
		}
		return r;
	}

	cost(source: string): SourceCost {
		return this.#records.get(source)?.cost ?? 'unknown';
	}

	/** The lane index to read `source` on, or null for the main connection. */
	route(source: string): number | null {
		const r = this.#of(source);
		return r.cost === 'fast' ? null : r.lane;
	}

	/**
	 * A data read finished on a lane: `polls` slices after the first, `execMs`
	 * until its result header, `rows` in the result.
	 */
	noteLaneRead(source: string, polls: number, execMs: number, rows: number): void {
		const r = this.#of(source);
		r.mainSlow = 0;
		if (polls <= FAST_POLLS) r.cost = 'fast';
		else if (rows > LARGE_ROWS && execMs <= LARGE_EXEC_MS) r.cost = 'fast';
		else r.cost = 'slow';
	}

	/** A data read finished on the main connection, `ms` from send to its bytes. */
	noteMainRead(source: string, ms: number, rows: number): void {
		const r = this.#of(source);
		const slow = rows > LARGE_ROWS ? ms > LARGE_EXEC_MS : ms > SLOW_MAIN_MS;
		if (!slow) {
			r.mainSlow = 0;
			if (r.cost === 'unknown') r.cost = 'fast';
			return;
		}
		if (++r.mainSlow >= 2) {
			r.cost = 'slow';
			r.mainSlow = 0;
		}
	}

	/** A data reload: every source's cost is unknown again. */
	reset(): void {
		for (const r of this.#records.values()) {
			r.cost = 'unknown';
			r.mainSlow = 0;
		}
	}
}
