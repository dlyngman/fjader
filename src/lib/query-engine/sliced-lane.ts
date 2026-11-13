/**
 * A sliced lane: one DuckDB-WASM connection whose statements run through the
 * pending-query API, so the worker executes them in slices and serves other
 * connections' messages in between. A slow read on a lane no longer holds up a
 * quick one on another connection.
 *
 * ONE STATEMENT AT A TIME, enforced here. A connection holds one pending query,
 * and a second one, or a `runQuery`, on the same connection silently resets the
 * first (measured in Phase 0). So the lane queues: first in, first out.
 *
 * ABORT (an AbortSignal per statement) has three cases:
 * - queued: dropped, rejected with AbortError, never sent;
 * - running, before the result header: `cancelPendingQuery`, rejected with
 *   AbortError. Only an abort we asked for becomes AbortError; any other error
 *   passes through unchanged;
 * - after the header, fetching chunks: the query has finished executing, so
 *   there is nothing to cancel. Fetching stops and the statement rejects; the
 *   next `startPendingQuery` resets the leftover result.
 * A cancel that loses the race (the query finished as it arrived, so the next
 * poll returns the header) still rejects with AbortError: the caller sees one
 * outcome for one abort.
 *
 * SLICE LENGTH is the database's `queryPollingInterval`, set when it is opened
 * (`initDuckDB` uses 5 ms). At the default, ~100 ms, a quick statement on
 * another connection can wait ~50 ms for a slice to end. It cannot be read
 * back. When the opener knows it (`connectionFrom`'s `pollingIntervalMs`),
 * the lane trusts that; otherwise it measures, and warns once per page when
 * the MEDIAN slice over its first sliced statements runs long. A median, not
 * one reading: each poll waits for a main-thread turn, and during load a busy
 * main thread stretches round trips past the threshold with short slices.
 */

/** The DuckDB-WASM bindings a lane drives; `AsyncDuckDB` has them. */
export interface PendingQueryBindings {
	startPendingQuery(
		conn: number,
		text: string,
		allowStreamResult?: boolean
	): Promise<Uint8Array | null>;
	pollPendingQuery(conn: number): Promise<Uint8Array | null>;
	cancelPendingQuery(conn: number): Promise<boolean>;
	fetchQueryResults(conn: number): Promise<Uint8Array | null>;
}

export interface SlicedLane {
	/**
	 * Run a query sliced. `ipc` is the Arrow IPC stream as the worker returned
	 * it, `[header, ...record batches]`, for flechette's `tableFromIPC` (each
	 * buffer holds whole messages). `polls`: how many slices it took past the
	 * first, the cost signal (0 or 1: a quick read).
	 */
	query(sql: string, signal?: AbortSignal): Promise<{ ipc: Uint8Array[]; polls: number }>;
	/**
	 * Run a statement sliced, discarding any result. The result is left
	 * pending on the connection, unfetched, until the next statement resets
	 * it (as after an abort past the header): the connection is NOT idle
	 * between statements, so never send a `runQuery` on it from outside.
	 */
	exec(sql: string, signal?: AbortSignal): Promise<{ polls: number }>;
	/**
	 * Reject what is queued (AbortError), cancel what runs, then close the
	 * connection. Statements sent after it reject with AbortError.
	 */
	close(): Promise<void>;
}

/** Slices longer than this warn once: the polling interval is long. */
const SLOW_SLICE_MS = 25;
/** Enough polls in one statement to measure its slices. */
const MEASURE_POLLS = 3;
/** Statements measured before judging: the median of these. */
const MEASURE_STATEMENTS = 5;
let warnedSlowSlices = false;

function abortError(): DOMException {
	return new DOMException('Statement aborted', 'AbortError');
}

interface Job {
	sql: string;
	signal: AbortSignal | undefined;
	fetch: boolean;
	phase: 'queued' | 'running' | 'fetching';
	aborted: boolean;
	resolve: (r: { ipc: Uint8Array[]; polls: number }) => void;
	reject: (e: unknown) => void;
	onAbort: (() => void) | null;
}

export class PendingQueryLane implements SlicedLane {
	#bindings: PendingQueryBindings;
	#conn: number;
	#closeConnection: () => Promise<void>;
	#queue: Job[] = [];
	#running: Job | null = null;
	#runningDone: Promise<void> | null = null;
	#closed = false;
	/** Per-statement slice lengths, until judged; null when not measuring. */
	#slices: number[] | null = [];

	constructor(
		bindings: PendingQueryBindings,
		conn: number,
		closeConnection: () => Promise<void>,
		/** The database's polling interval, when the opener knows it. */
		options: { pollingIntervalMs?: number } = {}
	) {
		this.#bindings = bindings;
		this.#conn = conn;
		this.#closeConnection = closeConnection;
		const known = options.pollingIntervalMs;
		if (known != null) {
			this.#slices = null;
			if (known > SLOW_SLICE_MS) warnSlowSlices(known);
		}
	}

	query(sql: string, signal?: AbortSignal): Promise<{ ipc: Uint8Array[]; polls: number }> {
		return this.#enqueue(sql, signal, true);
	}

	async exec(sql: string, signal?: AbortSignal): Promise<{ polls: number }> {
		const { polls } = await this.#enqueue(sql, signal, false);
		return { polls };
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const job of this.#queue) this.#settleAborted(job);
		this.#queue = [];
		if (this.#running) this.#abort(this.#running);
		await this.#runningDone;
		await this.#closeConnection();
	}

	#enqueue(
		sql: string,
		signal: AbortSignal | undefined,
		fetch: boolean
	): Promise<{ ipc: Uint8Array[]; polls: number }> {
		if (this.#closed || signal?.aborted) return Promise.reject(abortError());
		return new Promise((resolve, reject) => {
			const job: Job = {
				sql,
				signal,
				fetch,
				phase: 'queued',
				aborted: false,
				resolve,
				reject,
				onAbort: null
			};
			if (signal) {
				job.onAbort = () => this.#abort(job);
				signal.addEventListener('abort', job.onAbort, { once: true });
			}
			this.#queue.push(job);
			this.#pump();
		});
	}

	#abort(job: Job): void {
		if (job.aborted) return;
		job.aborted = true;
		if (job.phase === 'queued') {
			const i = this.#queue.indexOf(job);
			if (i >= 0) this.#queue.splice(i, 1);
			this.#settleAborted(job);
		} else if (job.phase === 'running') {
			// Interrupts execution; the poll in flight rejects or, if the query
			// just finished, returns the header. Either way #run sees `aborted`.
			this.#bindings.cancelPendingQuery(this.#conn).catch(() => {});
		}
		// 'fetching': the query has finished; #run stops at its next fetch.
	}

	#settleAborted(job: Job): void {
		job.aborted = true;
		this.#detach(job);
		job.reject(abortError());
	}

	#detach(job: Job): void {
		if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort);
		job.onAbort = null;
	}

	#pump(): void {
		if (this.#running) return;
		const job = this.#queue.shift();
		if (!job) return;
		this.#running = job;
		this.#runningDone = this.#run(job).finally(() => {
			this.#running = null;
			this.#runningDone = null;
			this.#pump();
		});
	}

	async #run(job: Job): Promise<void> {
		const b = this.#bindings;
		const conn = this.#conn;
		job.phase = 'running';
		const t0 = performance.now();
		let polls = 0;
		try {
			let header: Uint8Array | null;
			try {
				header = await b.startPendingQuery(conn, job.sql, false);
				while (header == null) {
					if (job.aborted) throw abortError();
					polls++;
					header = await b.pollPendingQuery(conn);
				}
			} catch (e) {
				// The cancel's own rejection, or anything else after an abort: one
				// outcome for the caller. Not asked for: passed through as is.
				throw job.aborted ? abortError() : e;
			}
			// Finished just as a cancel arrived: aborted all the same.
			if (job.aborted) throw abortError();

			const ipc: Uint8Array[] = [header];
			if (job.fetch) {
				job.phase = 'fetching';
				for (;;) {
					if (job.aborted) throw abortError();
					const chunk = await b.fetchQueryResults(conn);
					if (!chunk || chunk.byteLength === 0) break;
					ipc.push(chunk);
				}
			}
			if (job.aborted) throw abortError();
			this.#noteSlices(polls, performance.now() - t0);
			this.#detach(job);
			job.resolve({ ipc, polls });
		} catch (e) {
			this.#detach(job);
			job.reject(e);
		}
	}

	#noteSlices(polls: number, ms: number): void {
		const slices = this.#slices;
		if (!slices || polls < MEASURE_POLLS) return;
		slices.push(ms / polls);
		if (slices.length < MEASURE_STATEMENTS) return;
		this.#slices = null;
		const median = [...slices].sort((x, y) => x - y)[slices.length >> 1];
		if (median > SLOW_SLICE_MS) warnSlowSlices(median);
	}
}

function warnSlowSlices(ms: number): void {
	if (warnedSlowSlices) return;
	warnedSlowSlices = true;
	console.warn(
		`[Fjader] DuckDB runs sliced statements in ~${Math.round(ms)} ms slices, so a quick ` +
			'query can wait that long behind a slow one. Open the database with ' +
			'db.open({ query: { queryPollingInterval: 5 } }) and pass ' +
			'connectionFrom(conn, { pollingIntervalMs: 5 }) (initDuckDB does both).'
	);
}

/** For tests: the once-per-page slice warning, rearmed. */
export function _resetSliceWarning(): void {
	warnedSlowSlices = false;
}
