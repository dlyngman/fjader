/**
 * The preagg build queue.
 *
 * Builds are speculative full scans on the one connection, which runs
 * statements in arrival order, so sending them as they are planned would put a
 * click's queries behind all of them. The queue holds them instead and sends
 * one at a time, only while no mark query is waiting or running, or once the
 * oldest has waited the wait limit.
 *
 * Builds are queued in hover batches: one chart hover activates several
 * sources (a brush, a Toggle field, a band-label field), so the batch, not the
 * source, is what a newer hover supersedes; builds still queued from an older
 * batch are dropped. A batch's sources can belong to different filter groups,
 * which is why batches live here and not in FilterGroup.
 */

import type { PreaggState } from './plan';

/** A preagg build waiting in the queue. */
export interface QueuedBuild {
	markId: string;
	sourceId: string;
	build: PreaggState;
	createSQL: string;
	/** The hover batch that queued it. */
	batch: number;
	/** When it was queued, for the wait limit. */
	queuedAt: number;
	/** Settles the activation that queued it. */
	done: () => void;
}

/** What the queue needs from its owner. */
export interface BuildQueueHost {
	exec(sql: string, signal: AbortSignal): Promise<void>;
	/**
	 * Whether an interaction statement is on the connection, or a mark query is
	 * waiting to be sent. Background statements (other builds, tooltip writes)
	 * do not count.
	 */
	busy(): boolean;
	/**
	 * Whether a build is still wanted, checked when it would be sent: a mark
	 * re-registered, the view moved or a baked filter changed while it waited.
	 */
	stillWanted(item: QueuedBuild): boolean;
	/** A queued build was dropped before it ran, so the next activation plans it again. */
	dropped(item: QueuedBuild): void;
	built(item: QueuedBuild): void;
	failed(item: QueuedBuild, error: unknown): void;
}

export class BuildQueue {
	#host: BuildQueueHost;
	#maxWaitMs: number;
	/** Waiting builds, oldest first. */
	#queue: QueuedBuild[] = [];
	#running = false;
	/** The build being sent, and how to cancel it. */
	#current: { item: QueuedBuild; abort: AbortController } | null = null;
	#destroyed = false;
	/** Pumps the queue when the oldest build's wait runs out, if no query does first. */
	#waitTimer: ReturnType<typeof setTimeout> | null = null;
	/** The current hover batch. Builds still queued from an older one are dropped. */
	#batch = 0;
	#inBatch = false;

	/**
	 * @param maxWaitMs how long a build waits behind mark queries before it is
	 *   sent anyway. During a drag on the base table a mark query is always
	 *   waiting (each one takes longer than a frame), so without a limit the
	 *   build that would make the drag fast never runs. Past it, one frame waits
	 *   behind the build instead.
	 */
	constructor(host: BuildQueueHost, maxWaitMs: number) {
		this.#host = host;
		this.#maxWaitMs = maxWaitMs;
	}

	/** Run a hover's activations as one batch. Nested calls join the outer batch. */
	runBatch(activations: () => void): void {
		if (this.#inBatch) {
			activations();
			return;
		}
		this.#startBatch();
		this.#inBatch = true;
		try {
			activations();
		} finally {
			this.#inBatch = false;
		}
	}

	/** Start a batch unless one is running: an activation outside runBatch() is a batch of one. */
	ensureBatch(): void {
		if (!this.#inBatch) this.#startBatch();
	}

	/** Queue a build in the current batch. Settles when it has run or been dropped. */
	push(build: Omit<QueuedBuild, 'batch' | 'queuedAt' | 'done'>): Promise<void> {
		return new Promise<void>((done) => {
			this.#queue.push({ ...build, batch: this.#batch, queuedAt: performance.now(), done });
		});
	}

	/**
	 * Send the next queued build if nothing someone waits for is on the
	 * connection: no build running, no interaction statement in flight, and no
	 * mark query waiting. Called when a build is queued, when one finishes, when
	 * a mark query settles, and when the last interaction statement settles.
	 * Background statements (tooltip-table writes, cleanup) do not hold builds
	 * back.
	 *
	 * Mark queries hold a build back for at most the wait limit. A drag that
	 * starts before its source's tables are built reads the base table, each
	 * read slower than a frame, so a query is always waiting and the build would
	 * never run; past the limit it is sent anyway, and one frame waits for it.
	 */
	pump(): void {
		while (!this.#running && !this.#destroyed) {
			const head = this.#queue[0];
			if (!head) return;
			if (this.#host.busy()) {
				const waited = performance.now() - head.queuedAt;
				if (waited < this.#maxWaitMs) {
					this.#waitTimer ??= setTimeout(() => {
						this.#waitTimer = null;
						this.pump();
					}, this.#maxWaitMs - waited);
					return;
				}
			}
			const item = this.#queue.shift()!;
			if (!this.#host.stillWanted(item)) {
				this.#drop(item);
				continue;
			}

			this.#running = true;
			const abort = new AbortController();
			this.#current = { item, abort };
			this.#host
				.exec(item.createSQL, abort.signal)
				.then(() => {
					// Cancelled but finished anyway (the cancel lost the race): the
					// caller gave it up, so it does not land.
					if (abort.signal.aborted) this.#host.dropped(item);
					else this.#host.built(item);
				})
				.catch((e) => {
					if (abort.signal.aborted) this.#host.dropped(item);
					else this.#host.failed(item, e);
				})
				.finally(() => {
					this.#running = false;
					this.#current = null;
					item.done();
					this.pump();
				});
			return;
		}
	}

	/**
	 * Cancel the running build if `unwanted` says so. On a lane it is
	 * interrupted and rolls back (no table); on a shared connection it cannot
	 * be, and finishes, but is not registered.
	 */
	abortRunning(unwanted: (item: QueuedBuild) => boolean): void {
		const current = this.#current;
		if (current && unwanted(current.item)) current.abort.abort();
	}

	/** Drop every queued build and cancel the running one (a data reload). */
	clear(): void {
		for (const item of this.#queue) this.#drop(item);
		this.#queue = [];
		this.abortRunning(() => true);
	}

	/** Stop for good: settle every waiting activation and send nothing more. */
	destroy(): void {
		this.#destroyed = true;
		this.abortRunning(() => true);
		if (this.#waitTimer) clearTimeout(this.#waitTimer);
		this.#waitTimer = null;
		for (const item of this.#queue) item.done();
		this.#queue = [];
	}

	#startBatch(): void {
		this.#batch++;
		const keep: QueuedBuild[] = [];
		for (const item of this.#queue) {
			if (item.batch === this.#batch) keep.push(item);
			else this.#drop(item);
		}
		this.#queue = keep;
	}

	#drop(item: QueuedBuild): void {
		this.#host.dropped(item);
		item.done();
	}
}
