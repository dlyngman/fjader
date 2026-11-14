import { sourceDDL } from './source-routing';

/**
 * How soon a statement on the main connection should run, lower first. Only
 * statements still held in JS can be reordered: once sent, DuckDB-WASM runs
 * them in arrival order. Hence a cap on statements in flight, and this order
 * for the rest.
 *
 * - 0: setup a chart's first read waits on (categorical identity, DESCRIBE,
 *   domain and range reads), hover lookups, and interaction tooltip writes
 *   (written on pointer enter: the first hover waits for them). The default
 *   for interaction statements without a caller, an app's own queries too.
 * - 1: a mark's first data read: what its chart's entrance waits on.
 * - 2: a mark's re-queries (brush, params). The default with a caller.
 * - 3: background statements that stay on the main connection (connection-
 *   local ones, or every background statement when no lane opened).
 *
 * At load the worker is saturated, so the order changes who enters first,
 * not when the last chart does: judge it by the spread and the mean entrance.
 */
export type StatementRank = 0 | 1 | 2 | 3;

/**
 * Statements on the main connection at once, by default. A statement already
 * sent cannot be overtaken, so a higher cap lets an urgent one wait behind
 * more; a cap of 1 idles the worker for a main-thread turn between statements.
 */
export const MAIN_IN_FLIGHT_CAP = 1;

/**
 * A rank-2 or rank-3 statement rises one rank per this many ms waited, so a
 * stream that never ends (hover lookups, a brush's re-queries) cannot starve
 * what queues behind it. Ranks 0 and 1 never rise: setup at load is finite,
 * so nothing starves behind it, and a short limit on first reads would put
 * every 2M-row first read back ahead of the setup chain it waits on.
 */
export const MAIN_MAX_WAIT_MS = 100;

export interface MainStatement {
	rank: StatementRank;
	/** The statement's text, matched against barriers' names. */
	sql: string;
	/**
	 * The relations it creates, drops or replaces, when its text does not say
	 * (an Arrow insert creating its table, a batch). Otherwise read from the
	 * text, and only if it has to wait.
	 */
	barrier?: readonly string[];
	/** Aborted while queued: dropped before it is sent. */
	signal?: AbortSignal;
	/**
	 * Sends it, called synchronously when it takes a slot, with the rank it
	 * ran at (lower than `rank` when it rose for its wait). Synchronous on
	 * purpose: a slot freed before a result decodes hands the worker the next
	 * statement before the decode, not a microtask after it.
	 */
	start: (ranAt: StatementRank) => void;
	/** Dropped while queued (aborted, or the queue cleared). */
	drop: (reason: unknown) => void;
}

interface Entry {
	statement: MainStatement;
	/** Lowercased names, or null for a plain statement. */
	barrier: readonly string[] | null;
	/** Lowercased text, made only when a barrier needs it. */
	lower: string | null;
	queuedAt: number;
}

/**
 * The queue in front of the main connection: at most `cap` statements on it,
 * the rest in rank order, first come first served within a rank.
 *
 * BARRIERS. A statement that creates, drops or replaces a relation keeps
 * first-in, first-out for that relation: it does not overtake statements
 * queued before it whose text names the relation, nor do statements queued
 * after it that name it overtake it. Without that, a rank-0 DROP would jump
 * queued reads of what it drops (an identity reset, a notebook reload), and
 * a tooltip write would jump the previous lifecycle's drop of its own TEMP
 * table, which would then drop the new one. Scoped to the name, because
 * every tooltip write begins with a DROP: a global barrier would put the
 * hover write behind every queued brush read.
 * - Barriers keep their send order among themselves, whatever they name. The
 *   text match cannot see a view's dependencies: a read of an identity view
 *   names the view, not its dims, so a dim's DROP is free by name and would
 *   overtake the view's DROP still waiting for that read. In send order the
 *   dims inherit the view's wait.
 * - Names match case-insensitively (DuckDB folds unquoted identifiers), as
 *   whole identifiers (`mentions`): a false match only stops a reorder; a miss
 *   allows one.
 * - Not covered: a relation reached only through an app's own view. A
 *   reload's DROP TABLE flights can overtake a queued read of app_view that
 *   does not name flights. The same race exists between an app's direct
 *   statements without this queue.
 */
export class MainQueue {
	#cap: number;
	#maxWaitMs: number;
	#onGrant: () => void;
	#inFlight = 0;
	#queue: Entry[] = [];

	/** `onGrant` runs as a statement takes a slot, before it is sent. */
	constructor(cap: number, maxWaitMs: number, onGrant: () => void) {
		this.#cap = Math.max(1, cap);
		this.#maxWaitMs = maxWaitMs;
		this.#onGrant = onGrant;
	}

	/** Statements waiting for a slot. */
	get waiting(): number {
		return this.#queue.length;
	}

	/**
	 * Starts the statement now (no queue, a free slot), or once its turn
	 * comes; or drops it, if its signal aborts while queued. Every start is
	 * paired with one `release()`.
	 */
	enqueue(statement: MainStatement): void {
		if (this.#queue.length === 0 && this.#inFlight < this.#cap) {
			this.#grant(statement, statement.rank);
			return;
		}
		this.#queue.push({
			statement,
			barrier: lowerNames(statement.barrier ?? ddlNames(statement.sql)),
			lower: null,
			queuedAt: performance.now()
		});
	}

	/** A statement left the connection (its bytes arrived, or it failed). The next goes now. */
	release(): void {
		this.#inFlight--;
		this.#pump();
	}

	/** Drop everything still queued (the engine is destroyed). */
	clear(reason: unknown): void {
		const queue = this.#queue;
		this.#queue = [];
		for (const entry of queue) entry.statement.drop(reason);
	}

	#grant(statement: MainStatement, rank: StatementRank): void {
		this.#inFlight++;
		this.#onGrant();
		statement.start(rank);
	}

	#pump(): void {
		if (this.#queue.length === 0) return;
		// Aborted while queued: dropped, and no longer anyone's barrier.
		for (let i = this.#queue.length - 1; i >= 0; i--) {
			const entry = this.#queue[i];
			if (entry.statement.signal?.aborted) {
				this.#queue.splice(i, 1);
				entry.statement.drop(new DOMException('Statement aborted', 'AbortError'));
			}
		}
		const now = performance.now();
		while (this.#inFlight < this.#cap && this.#queue.length > 0) {
			const { index, rank } = this.#pick(now);
			const entry = this.#queue.splice(index, 1)[0];
			this.#grant(entry.statement, rank);
		}
	}

	/** The free entry with the lowest rank after its wait, the earliest on a tie. */
	#pick(now: number): { index: number; rank: StatementRank } {
		let best = 0;
		let bestRank = this.#rankOf(this.#queue[0], now);
		for (let i = 1; i < this.#queue.length && bestRank > 0; i++) {
			const rank = this.#rankOf(this.#queue[i], now);
			if (rank < bestRank && !this.#blocked(i)) {
				best = i;
				bestRank = rank;
			}
		}
		// The first entry is never blocked: nothing was queued before it.
		return { index: best, rank: bestRank };
	}

	#rankOf(entry: Entry, now: number): StatementRank {
		const { rank } = entry.statement;
		if (rank < 2) return rank;
		const steps = Math.floor((now - entry.queuedAt) / this.#maxWaitMs);
		return Math.max(0, rank - steps) as StatementRank;
	}

	/** Whether an entry queued earlier must go first (see Barriers). */
	#blocked(i: number): boolean {
		const entry = this.#queue[i];
		for (let j = 0; j < i; j++) {
			const before = this.#queue[j];
			if (!entry.barrier && !before.barrier) continue;
			if (entry.barrier && before.barrier) return true;
			if (entry.barrier && this.#names(before, entry.barrier)) return true;
			if (before.barrier && this.#names(entry, before.barrier)) return true;
		}
		return false;
	}

	#names(entry: Entry, names: readonly string[]): boolean {
		entry.lower ??= entry.statement.sql.toLowerCase();
		const text = entry.lower;
		return names.some((name) => mentions(text, name));
	}
}

/**
 * Whether lowercased `text` names `name` as a whole identifier: no
 * identifier character on either side, so "t" is not found in "other", and
 * a quoted or qualified name ("t", main.t) is.
 */
function mentions(text: string, name: string): boolean {
	for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
		if (!isIdentChar(text.charCodeAt(i - 1)) && !isIdentChar(text.charCodeAt(i + name.length))) {
			return true;
		}
	}
	return false;
}

/** a-z, 0-9, _ and $ (the text is lowercased); NaN, past either end, is not. */
function isIdentChar(c: number): boolean {
	return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 36;
}

/** The relation a statement creates, drops or replaces, by its text (sourceDDL). */
export function ddlNames(sql: string): string[] | null {
	const ddl = sourceDDL(sql);
	return ddl ? [ddl.name] : null;
}

function lowerNames(names: readonly string[] | null): readonly string[] | null {
	return names && names.length > 0 ? names.map((n) => n.toLowerCase()) : null;
}
