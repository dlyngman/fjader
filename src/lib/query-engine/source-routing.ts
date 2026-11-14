/**
 * Where an interaction read runs, by the source it reads: the main connection
 * (`runQuery`: no polling, no chunked fetch) or a sliced lane, where a slow
 * read interleaves with everyone else's instead of holding the worker.
 *
 * A COST RECORD PER SOURCE (the table a statement actually reads: a base table,
 * a view, or a preagg table): unknown, fast or slow.
 *
 * - Unknown and slow sources read on a lane; fast ones on the main connection.
 * - LANES ARE FOR SLOW SOURCES ONLY. A lane read costs 20-27 ms where the main
 *   connection takes 2-5 ms (measured on /test/entrance at load): it needs at
 *   least three round trips (start, fetch, a final empty fetch), and each
 *   waits behind a slice of every other busy lane, a cost that grows with the
 *   number of busy lanes (so the pool stays small).
 * - Hence the PRIOR, set before a source's first read is routed (from
 *   QueryEngine.describe): a base or temporary table in an in-memory catalog
 *   starts fast, its cost bounded by its size; a view, or a table in an
 *   attached remote or file database, starts unknown and is read sliced. A
 *   preagg table, which fjader builds in memory, starts fast. fjader's own
 *   identity views are never a source: a mark's reads name its base table.
 *   An app can override the prior (QueryEngine.sourceCost), and a
 *   measurement corrects either.
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
	/** Set by the app (`hint`): the prior no longer applies. */
	hinted: boolean;
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
			r = { cost: 'unknown', hinted: false, mainSlow: 0, lane };
			this.#records.set(source, r);
		}
		return r;
	}

	cost(source: string): SourceCost {
		return this.#records.get(source)?.cost ?? 'unknown';
	}

	/**
	 * The prior for a source not yet measured: what it is (see the module
	 * comment). Applies only while its record is unknown and not hinted.
	 */
	prior(source: string, cost: SourceCost): void {
		const r = this.#of(source);
		if (r.cost === 'unknown' && !r.hinted) r.cost = cost;
	}

	/**
	 * The source was dropped or replaced by something else: back to unknown,
	 * unless the app hinted it.
	 */
	forget(source: string): void {
		const r = this.#records.get(source);
		if (!r || r.hinted) return;
		r.cost = 'unknown';
		r.mainSlow = 0;
	}

	/** The app knows better than the prior: a slow table, a cheap view. */
	hint(source: string, cost: 'fast' | 'slow'): void {
		const r = this.#of(source);
		r.cost = cost;
		r.hinted = true;
		r.mainSlow = 0;
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

	/**
	 * A data reload: every measured cost is unknown again (the prior is set
	 * again by the next describe); an app's hint stays.
	 */
	reset(): void {
		for (const r of this.#records.values()) {
			if (r.hinted) continue;
			r.cost = 'unknown';
			r.mainSlow = 0;
		}
	}
}

/**
 * What a statement does to the set of sources, read from its text: a table or
 * view created under a plain name, or one dropped. Narrow on purpose: a wrong
 * "table" (fast) is the expensive mistake, a wrong "unknown" costs one sliced
 * read (~20 ms) before the first quick one corrects it. Qualified names
 * (an attached database), CREATE MACRO, TYPE, SEQUENCE and anything else
 * return null.
 */
export function sourceDDL(
	sql: string
): { kind: 'table' | 'view'; name: string } | { kind: 'drop'; name: string } | null {
	const name = String.raw`("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
	const end = String.raw`(?=\s|\(|;|$)`;
	const create = new RegExp(
		String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY)\s+)?(TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?` +
			name +
			end,
		'i'
	).exec(sql);
	if (create)
		return {
			kind: create[1].toUpperCase() === 'TABLE' ? 'table' : 'view',
			name: unquote(create[2])
		};
	const drop = new RegExp(
		String.raw`^\s*DROP\s+(?:TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?` + name + end,
		'i'
	).exec(sql);
	if (drop) return { kind: 'drop', name: unquote(drop[1]) };
	return null;
}

function unquote(name: string): string {
	return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name;
}
