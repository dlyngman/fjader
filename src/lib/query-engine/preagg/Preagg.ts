/**
 * Preagg state and routing: the preagg tables each mark holds, one per
 * activated selection source, and which of them a query reads.
 *
 * Activating a source plans a table for every aggregate mark it filters and
 * queues its build (BuildQueue). A query reads the first of the mark's tables
 * whose basis still holds; the table that answers moves to the front, so the
 * next frame of the same gesture checks it first. There is no engine-wide
 * "active source": validity alone picks the table.
 */

import type { Table } from '@uwdata/flechette';
import { binsFineEnough } from '../sufficient-statistics';
import type { QueryDescriptor } from '../QueryEngine';
import type { MarkHandle } from '../MarkHandle.svelte';
import type { FilterGroup } from '../FilterGroup.svelte';
import {
	planPreagg,
	preaggSelectSQL,
	preaggQuerySQL,
	bakedClausesHold,
	markKeys,
	estimateGroups,
	activeDimsKeyOf,
	binFitsView,
	fnvHash,
	type ActiveDim,
	type ActivationSource,
	type GroupKey,
	type PreaggIdentity,
	type PreaggState
} from './plan';
import { BuildQueue, type QueuedBuild } from './BuildQueue';

/**
 * How many preagg tables no mark uses are kept. Every settle after a filter or
 * view change can build a new table (its baked filters or window differ), so a
 * long session would otherwise accumulate them without bound. Kept rather than
 * dropped at once: returning to a source or filter state finds its table.
 */
const MAX_UNUSED_TABLES = 32;

/** Flip to false to bypass preagg routing and force base-table queries, to
 *  benchmark preagg against the base table. */
const PREAGG_ENABLED = true;

/** A registered mark, as preagg sees it. */
export interface PreaggMark {
	descriptor: QueryDescriptor;
	handle: MarkHandle;
	filterGroup: FilterGroup;
}

/** What Preagg needs from the engine. */
export interface PreaggHost {
	exec(sql: string): Promise<void>;
	query(sql: string, opts: { cache: boolean }): Promise<Table>;
	/** Whether a mark query is running or waiting. */
	busy(): boolean;
	identity: PreaggIdentity;
	/** The mark's current registration, which a re-setup replaces. */
	mark(markId: string): PreaggMark | undefined;
	marks(): Iterable<[string, PreaggMark]>;
}

/** One mark's tables. */
interface MarkTables {
	/**
	 * Built preagg tables, one per activated source. A query reads the first
	 * whose basis holds and moves it to the front, so the next frame of the
	 * same gesture checks it first.
	 */
	tables: Map<string, PreaggState>;
	/** The latest build started per source. A finished build is installed only
	 *  if it is still this one, so a superseded or dropped build never lands. */
	building: Map<string, PreaggState>;
}

export class Preagg {
	#host: PreaggHost;
	#destroyed = false;
	/** Each mark's tables, by mark id. Dropped when the mark re-registers or goes. */
	#marks = new Map<string, MarkTables>();
	/** Preagg builds, sent one at a time while no mark query needs the connection. */
	#builds: BuildQueue;
	/**
	 * Hash-named preagg tables created this session, least recently planned
	 * first: for the cap on unused tables, and for cleanup on reload and destroy.
	 */
	#tables = new Set<string>();
	/**
	 * Row count per base table, for the size guard: a number once read, the
	 * read in flight before that. Read once per table when its first mark
	 * registers, outside any interaction.
	 */
	#rowCounts = new Map<string, number | Promise<void>>();
	/** Scratch for a source's view, reused by every query's resolution check. */
	#viewScratch = new Float64Array(6);

	constructor(host: PreaggHost, buildMaxWaitMs: number) {
		this.#host = host;
		this.#builds = new BuildQueue(
			{
				exec: (sql) => host.exec(sql),
				busy: () => host.busy(),
				stillWanted: (item) => this.#stillWanted(item),
				dropped: ({ markId, sourceId, build }) => {
					const own = this.#marks.get(markId);
					if (own?.building.get(sourceId) === build) own.building.delete(sourceId);
				},
				built: ({ markId, sourceId, build }) => {
					const own = this.#marks.get(markId);
					if (own?.building.get(sourceId) !== build) return;
					own.building.delete(sourceId);
					own.tables.set(sourceId, build);
				},
				failed: ({ markId, sourceId, build }, e) => {
					console.warn(`[QueryEngine] preagg failed for ${markId}:`, e);
					const own = this.#marks.get(markId);
					if (own?.building.get(sourceId) === build) own.building.delete(sourceId);
				}
			},
			buildMaxWaitMs
		);
	}

	/** A mark registered on `baseTable`: read the table's row count once, for the size guard. */
	trackTable(baseTable: string): void {
		this.#countRows(baseTable);
	}

	/** Forget a mark's tables and builds in flight: it re-registered or went. Does NOT drop the
	 *  tables — hash-named tables are reused via CREATE TABLE IF NOT EXISTS. */
	dropMark(markId: string): void {
		this.#marks.delete(markId);
	}

	/**
	 * Pre-aggregate marks for a filter group before a source is used.
	 * Called through the source's handle on pointerenter — before the first drag.
	 *
	 * Builds materialized preagg tables for all aggregate marks in the filter
	 * group that the source filters, one per source, next to any the mark holds
	 * for other sources. Each table bakes in every clause except the source's
	 * own and groups by the source's active dims as well as the mark's own, so
	 * a change to the source is a filter on a table of thousands of rows: pixel
	 * bins for a brush, the field's ids (or values) for a toggle or legend.
	 *
	 * The source is named by its ID rather than inferred: before the first drag
	 * it has no clause yet, and other clauses on the same chart (a Toggle)
	 * exclude the same marks a brush does.
	 */
	async activate(filterGroup: FilterGroup, source: ActivationSource): Promise<void> {
		const { sourceId: activeSourceId, excludedByAll, dims } = source;
		if (this.#destroyed || dims.length === 0) return;
		// An activation outside batch() (a legend's hover) is a batch of one.
		this.#builds.ensureBatch();

		const { selection } = filterGroup;
		const dimsKey = activeDimsKeyOf(dims);
		const promises: Promise<void>[] = [];

		for (const [markId, reg] of this.#host.marks()) {
			if (reg.filterGroup !== filterGroup) continue;
			// A mark the source never filters gets no table for it, and keeps
			// the tables it holds for other sources.
			if (excludedByAll.has(markId)) continue;
			const own = this.#of(markId);

			// Skip if the latest build, finished or in flight, still matches
			const latest = own.building.get(activeSourceId) ?? own.tables.get(activeSourceId);
			if (latest) {
				const { basis } = latest;
				if (
					basis.parts === reg.descriptor.parts &&
					basis.activeSourceId === activeSourceId &&
					basis.dimsKey === dimsKey &&
					this.#binsFitDims(latest, dims) &&
					bakedClausesHold(markId, selection, latest)
				) {
					continue;
				}
			}

			// Drop this source's stale table; other sources' stay.
			own.tables.delete(activeSourceId);
			own.building.delete(activeSourceId);

			const plan = planPreagg(reg.descriptor, dims, this.#host.identity);
			if (!plan) continue;
			if (this.#tooLarge(reg, plan.activeKeys)) continue;

			// Bake every other clause into the preagg table. Sorted by source ID,
			// so the same filters always give the same SQL, and so the same table.
			const bakedClauses = selection.bakedClauses(markId, activeSourceId);
			const staticFilters = selection.bakedPredicates(markId, activeSourceId);

			// Hash-based naming: identical preagg SQL reuses the same table (like Mosaic).
			// CREATE TABLE IF NOT EXISTS avoids rebuilding when switching charts.
			const preaggSQL = preaggSelectSQL(plan.creation, staticFilters);
			const preaggTable = `__dplot_preagg_${fnvHash(preaggSQL).toString(16)}`;
			const createSQL = `CREATE TABLE IF NOT EXISTS "${preaggTable}" AS ${preaggSQL}`;

			// The basis is captured now, not when the build finishes: a filter
			// that changes while the CREATE runs must still read as a mismatch.
			const build: PreaggState = {
				table: preaggTable,
				sql: preaggSQL,
				basis: {
					parts: reg.descriptor.parts,
					activeSourceId,
					dimsKey,
					bakedClauses,
					view: source.view ?? null
				},
				creation: plan.creation,
				mismatch: null,
				outputSelect: plan.outputSelect,
				activeMeta: plan.activeMeta,
				windowChannels: plan.windowChannels
			};
			own.building.set(activeSourceId, build);

			// Most recently planned last, for the cap on unused tables.
			this.#tables.delete(preaggTable);
			this.#tables.add(preaggTable);
			promises.push(this.#builds.push({ markId, sourceId: activeSourceId, build, createSQL }));
		}

		this.#builds.pump();
		this.#evictUnused();
		await Promise.all(promises);
	}

	/**
	 * Run a hover's activations as one batch: builds still queued from an earlier
	 * batch are dropped (see BuildQueue).
	 */
	batch(activations: () => void): void {
		this.#builds.runBatch(activations);
	}

	/** A mark query settled: the connection may be free for a build, and for dropping
	 *  unused tables. */
	pump(): void {
		this.#builds.pump();
		this.#evictUnused();
	}

	/**
	 * The query a mark runs on one of its preagg tables, or null for the base
	 * table, which applies every clause: no table answers, or the one that does
	 * cannot express this query (a brush end past its window, a toggled value
	 * with no id). Names the table read, for readFailed.
	 */
	sqlFor(markId: string, reg: PreaggMark): { sql: string; table: string } | null {
		const preagg = this.#usable(markId, reg);
		if (!preagg) return null;
		const sql = preaggQuerySQL(
			markId,
			reg.descriptor,
			reg.filterGroup.selection,
			preagg,
			reg.handle.params,
			this.#host.identity
		);
		return sql ? { sql, table: preagg.table } : null;
	}

	/**
	 * A mark's query on a preagg table failed: stop reading that table, so its
	 * frames go to the base table until the source activates again and rebuilds
	 * it. Not dropped here; a query already queued may still name it, and once
	 * unused it goes through #evictUnused.
	 */
	readFailed(markId: string, table: string, error: unknown): void {
		console.warn(`[QueryEngine] preagg read failed for ${markId}, using the base table:`, error);
		const own = this.#marks.get(markId);
		if (!own) return;
		for (const [sourceId, state] of own.tables) {
			if (state.table === table) own.tables.delete(sourceId);
		}
	}

	/**
	 * Forget a source's tables on every mark of its group: its last registration
	 * is gone, so nothing can use them. Called by FilterGroup. Does NOT drop the
	 * tables; hash-named tables are reused via CREATE TABLE IF NOT EXISTS.
	 */
	forgetSource(filterGroup: FilterGroup, sourceId: string): void {
		for (const [markId, reg] of this.#host.marks()) {
			if (reg.filterGroup !== filterGroup) continue;
			const own = this.#marks.get(markId);
			own?.tables.delete(sourceId);
			own?.building.delete(sourceId);
		}
	}

	/**
	 * A data reload: drop every queued build, every mark's tables and the tables
	 * themselves (CREATE TABLE IF NOT EXISTS would otherwise keep serving
	 * pre-reload aggregates), and the row counts.
	 */
	reset(): void {
		this.#builds.clear();
		this.#marks.clear();
		for (const table of this.#tables) {
			this.#host.exec(`DROP TABLE IF EXISTS "${table}"`).catch(() => {});
		}
		this.#tables.clear();
		this.#rowCounts.clear();
	}

	/**
	 * The engine is going: settle waiting activations and drop this session's
	 * tables. Resolves once the drops have run; call it while the engine can
	 * still exec. A build already running is ahead of the drops on the one
	 * connection, so its table is dropped too.
	 */
	async destroy(): Promise<void> {
		this.#destroyed = true;
		// Settle activations still waiting on queued builds
		this.#builds.destroy();
		this.#marks.clear();
		// Drop all preagg tables created this session
		const drops = [...this.#tables].map((table) =>
			this.#host.exec(`DROP TABLE IF EXISTS "${table}"`).catch(() => {})
		);
		this.#tables.clear();
		await Promise.all(drops);
	}

	/**
	 * Drop the oldest tables no mark uses, past MAX_UNUSED_TABLES. A table is in
	 * use while a mark's built or building map holds it, so a running build is
	 * never dropped. Only while no mark query is running or waiting: a pending
	 * query is already assembled, and the table it names may have stopped being
	 * used since (a rebuild replaced the mark's entry); a DROP sent ahead of it
	 * would fail it. A dropped table planned again is rebuilt by its CREATE
	 * TABLE IF NOT EXISTS.
	 */
	#evictUnused(): void {
		if (this.#destroyed || this.#tables.size <= MAX_UNUSED_TABLES || this.#host.busy()) return;
		const used = new Set<string>();
		for (const own of this.#marks.values()) {
			for (const state of own.tables.values()) used.add(state.table);
			for (const state of own.building.values()) used.add(state.table);
		}
		let excess = this.#tables.size - used.size - MAX_UNUSED_TABLES;
		for (const table of this.#tables) {
			if (excess <= 0) break;
			if (used.has(table)) continue;
			this.#tables.delete(table);
			this.#host.exec(`DROP TABLE IF EXISTS "${table}"`).catch(() => {});
			excess--;
		}
	}

	#of(markId: string): MarkTables {
		let own = this.#marks.get(markId);
		if (!own) {
			own = { tables: new Map(), building: new Map() };
			this.#marks.set(markId, own);
		}
		return own;
	}

	/**
	 * Whether a queued build is still wanted when it would be sent: checked
	 * against the mark's current registration, which a re-setup replaces,
	 * against the view now (a zoom in or a long pan while it waited means a
	 * table settling would only rebuild), and against the filters now: a clause
	 * baked into the table may have changed.
	 */
	#stillWanted({ markId, sourceId, build }: QueuedBuild): boolean {
		const reg = this.#host.mark(markId);
		return (
			!!reg &&
			this.#marks.get(markId)?.building.get(sourceId) === build &&
			reg.descriptor.parts === build.basis.parts &&
			this.#binsFitCurrentView(build) &&
			bakedClausesHold(markId, reg.filterGroup.selection, build)
		);
	}

	/**
	 * The size guard: whether a planned table would hold more than a quarter of
	 * its base table's rows (a fixed 100,000 until the row count has been read).
	 *
	 * Measured on 1M rows (DuckDB-WASM, one thread): a toggle click on a table a
	 * quarter the size of the base table is still ~3.7× faster than on the base
	 * table, and its build costs ~2.5 base queries; at 43% the click is 2.1×
	 * faster and the build ~3.5 base queries; at 69%, 1.4× and ~4. Builds run
	 * when the connection is idle, so their cost shows only as the wait of a
	 * click that lands mid-build, and as memory; past a quarter that outweighs
	 * the gain. The groups are estimated by estimateGroups; an unknown estimate
	 * builds.
	 */
	#tooLarge(reg: PreaggMark, activeKeys: GroupKey[]): boolean {
		const groups = estimateGroups(
			markKeys(reg.descriptor, reg.handle, this.#host.identity),
			activeKeys
		);
		if (groups == null) return false;
		const rows = this.#rowCounts.get(reg.descriptor.baseTable);
		const cap = typeof rows === 'number' ? rows / 4 : 100_000;
		return groups > cap;
	}

	/** Read a base table's row count once, for the size guard. */
	#countRows(table: string): void {
		if (this.#rowCounts.has(table)) return;
		const escaped = table.replace(/"/g, '""');
		this.#rowCounts.set(
			table,
			this.#host
				.query(`SELECT count(*)::DOUBLE AS n FROM "${escaped}"`, { cache: false })
				.then((result) => {
					const n = Number((result.get(0) as { n?: unknown } | null)?.n);
					if (Number.isFinite(n)) this.#rowCounts.set(table, n);
					else this.#rowCounts.delete(table);
				})
				.catch(() => {
					// Unknown: the guard keeps its fixed cap, and a later registration retries.
					this.#rowCounts.delete(table);
				})
		);
	}

	/**
	 * The preagg table a mark's query can read: the first whose query parts
	 * match and whose baked clauses are still in force, or null for the base
	 * table, which applies every clause.
	 *
	 * The table that answers moves to the front. One hover activates several
	 * sources, so the table for the source being dragged need not come first;
	 * a table ahead of it bakes that source's moving clause and fails, possibly
	 * through the SQL comparison in bakedClausesHold. Moving the answering
	 * table to the front limits that to the first frame of a gesture. When no
	 * table answers, the frame queries the base table, which costs far more.
	 */
	#usable(markId: string, reg: PreaggMark): PreaggState | null {
		const own = this.#marks.get(markId);
		if (!PREAGG_ENABLED || !own || own.tables.size === 0) return null;
		const { selection } = reg.filterGroup;
		let first = true;
		for (const [sourceId, state] of own.tables) {
			if (
				state.basis.parts === reg.descriptor.parts &&
				this.#binsFineEnough(state) &&
				bakedClausesHold(markId, selection, state)
			) {
				// A Map keeps the first insertion position of a key, so listing
				// this entry first and spreading the rest moves it to the front.
				if (!first) own.tables = new Map([[sourceId, state], ...own.tables]);
				return state;
			}
			first = false;
		}
		return null;
	}

	/**
	 * Whether a table's pixel bins are still at least as fine as the current
	 * view's pixels. Bin indexes are floor((v - d0) * scale) with the stored d0
	 * and scale, and the brush filter uses the same pair, so a brush inside the
	 * table's window is answered at any view; only precision depends on bin
	 * width. A pan keeps the width (off by at most one bin edge, one pixel) and
	 * a zoom out makes the bins finer than the pixels, so both keep the table.
	 * Only a zoom in or a larger chart past the built resolution fails here; a
	 * brush past the window is caught where the filter is built. Reads the view
	 * into a reused array: no allocation.
	 */
	#binsFineEnough(state: PreaggState): boolean {
		const { view } = state.basis;
		if (!view) return true;
		const out = this.#viewScratch;
		out.fill(NaN);
		view(out);
		let bin = 0;
		for (const meta of state.activeMeta) {
			if (meta.kind !== 'bin') continue;
			const d0 = out[bin * 3];
			const d1 = out[bin * 3 + 1];
			const extent = out[bin * 3 + 2];
			bin++;
			if (!binsFineEnough(meta.scaleFactor, d1 - d0, extent)) return false;
		}
		return true;
	}

	/**
	 * Whether a queued bin build still suits its source's view, read through the
	 * source's view callback. An unknown view keeps it.
	 */
	#binsFitCurrentView(state: PreaggState): boolean {
		const { view } = state.basis;
		if (!view) return true;
		const out = this.#viewScratch;
		out.fill(NaN);
		view(out);
		return this.#binsFitScratch(state);
	}

	/**
	 * Whether a table's bins suit an activation's dims, so activating keeps it.
	 * The dims are written into the view scratch, as a view callback writes it,
	 * and checked by the same loop; the caller has matched the dims key, so the
	 * table has a bin dim for each of the dims' bin dims, in order.
	 */
	#binsFitDims(state: PreaggState, dims: ActiveDim[]): boolean {
		const out = this.#viewScratch;
		out.fill(NaN);
		let bin = 0;
		for (const dim of dims) {
			if (dim.kind !== 'bin') continue;
			const i = 3 * bin++;
			out[i] = dim.domain[0];
			out[i + 1] = dim.domain[1];
			out[i + 2] = dim.pixelExtent;
		}
		return this.#binsFitScratch(state);
	}

	/**
	 * The one bin-view rule over the view scratch, `[d0, d1, pixel extent]` per
	 * bin dim: each bin dim fits its view (binFitsView). Kept tables are judged
	 * by it on activation (#binsFitDims) and before a queued build is sent
	 * (#binsFitCurrentView).
	 */
	#binsFitScratch(state: PreaggState): boolean {
		const out = this.#viewScratch;
		let bin = 0;
		for (const meta of state.activeMeta) {
			if (meta.kind !== 'bin') continue;
			const i = 3 * bin++;
			if (!binFitsView(meta, out[i], out[i + 1], out[i + 2])) return false;
		}
		return true;
	}
}
