/**
 * A statement log for measuring what reaches DuckDB: attach it to an engine,
 * use the page, then read `report()` or `download()` the raw log.
 *
 * Built on `QueryEngine.observeStatements`, so it sees every statement the
 * engine sends (queries, statements, DESCRIBE, Arrow inserts) with its class.
 * Times are taken on the main thread when a statement is handed over and when
 * it settles; while the main thread is busy (decoding, GPU uploads) they read
 * high. The queue-wait estimate assumes each connection serves its statements
 * first-in, first-out: a statement starts when it was sent or when the
 * previous one ON ITS CONNECTION finished, whichever is later. Statements on a
 * sliced lane interleave with the main connection's in the worker, so their
 * "work" includes slices spent serving the other.
 */
import type { QueryEngine, StatementRecord } from '../QueryEngine';

/** What a statement is for, from its text: a coarse grouping for reports. */
export type StatementPurpose = 'describe' | 'ddl' | 'insert' | 'range' | 'data';

export interface LoggedStatement extends StatementRecord {
	purpose: StatementPurpose;
	/** The first table the statement reads, or '?'. */
	table: string;
}

export interface QueryLog {
	readonly statements: readonly LoggedStatement[];
	/** Print a summary to the console and return it as rows. */
	report(): ReportRow[];
	/** Download the raw log as JSON (to the browser's downloads folder). */
	download(name: string, extra?: Record<string, unknown>): void;
	reset(): void;
	detach(): void;
}

export interface ReportRow {
	group: string;
	n: number;
	workMs: number;
	waitMs: number;
}

function purposeOf(record: StatementRecord): StatementPurpose {
	if (record.kind === 'describe') return 'describe';
	if (record.kind === 'insert') return 'insert';
	const s = record.sql.trimStart().toUpperCase();
	if (/^(CREATE|DROP|INSERT|ALTER|DELETE|UPDATE)/.test(s)) return 'ddl';
	// A scalar summary: min/max aggregates, no GROUP BY, no window.
	if (/^SELECT/.test(s) && !/GROUP BY/.test(s) && /(MIN|MAX)\(/.test(s) && !/ OVER \(/.test(s)) {
		return 'range';
	}
	return 'data';
}

function tableOf(sql: string): string {
	const m = /FROM\s+"?([A-Za-z_][\w]*)"?/i.exec(sql);
	return m ? m[1] : '?';
}

/** Attach a statement log to an engine. Costs nothing once detached. */
export function attachQueryLog(engine: QueryEngine): QueryLog {
	const statements: LoggedStatement[] = [];
	const detach = engine.observeStatements((record) => {
		statements.push({ ...record, purpose: purposeOf(record), table: tableOf(record.sql) });
	});

	const report = (): ReportRow[] => {
		const sorted = [...statements].sort((a, b) => a.start - b.start);
		if (sorted.length === 0) return [];
		const lastEndOn = { main: 0, lane: 0 };
		let lastEnd = 0;
		const groups = new Map<string, ReportRow>();
		let work = 0;
		for (const s of sorted) {
			const conn = s.connection ?? 'main';
			const start = Math.max(s.start, lastEndOn[conn]);
			lastEndOn[conn] = Math.max(lastEndOn[conn], s.end);
			lastEnd = Math.max(lastEnd, s.end);
			const key = `${conn} ${s.class} ${s.purpose} ${s.table}`;
			const g = groups.get(key) ?? { group: key, n: 0, workMs: 0, waitMs: 0 };
			g.n++;
			g.workMs += s.end - start;
			g.waitMs += start - s.start;
			work += s.end - start;
			groups.set(key, g);
		}
		const span = lastEnd - sorted[0].start;
		const rows = [...groups.values()]
			.map((g) => ({ ...g, workMs: +g.workMs.toFixed(1), waitMs: +g.waitMs.toFixed(1) }))
			.sort((a, b) => b.workMs - a.workMs);
		console.log(
			`[query-log] ${sorted.length} statements, span ${span.toFixed(0)} ms, work ${work.toFixed(0)} ms`
		);
		console.table(rows);
		return rows;
	};

	const download = (name: string, extra: Record<string, unknown> = {}) => {
		const json = JSON.stringify({ ...extra, statements }, null, 1);
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
		a.download = name;
		a.click();
		URL.revokeObjectURL(a.href);
	};

	return {
		statements,
		report,
		download,
		reset: () => {
			statements.length = 0;
		},
		detach
	};
}
