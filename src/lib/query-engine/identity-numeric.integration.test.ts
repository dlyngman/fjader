/**
 * Integration test: a band axis over a NON-VARCHAR column, end to end.
 *
 * A dim is `SELECT DISTINCT <expr>`, so its values keep whatever type that
 * expression produced. `FieldIdentity` declared `string[]` and `Map<string, …>`
 * anyway, and the round trip happened to work because both sides of every
 * lookup come from the same driver — so nothing failed, and nothing tested it
 * either. A band axis over a year, a rating or a zip code is an ordinary chart.
 *
 * The type is load-bearing rather than cosmetic, which is the thing worth
 * pinning: d3's `scaleBand` keys its lookup by the raw domain value, so a
 * numeric domain answers `scale(2021)` and NOT `scale('2021')`. Any well-meant
 * normalization to strings on the way through the dim would leave every axis
 * tick, TextMark label and tooltip position resolving to undefined.
 *
 * Runs against native DuckDB rather than a mock for the same reason §16's tests
 * do: the question is what the driver hands back, which a mock would decide by
 * assumption — the exact assumption that was wrong.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import duckdb from 'duckdb';
import { CategoricalIdentity } from './categorical-identity';
import { BandScaleState } from '$lib/scales/BandScaleState.svelte';

interface DB {
	run(sql: string): Promise<void>;
	all(sql: string): Promise<Record<string, unknown>[]>;
	close(): Promise<void>;
}

function openDB(): DB {
	const db = new duckdb.Database(':memory:');
	return {
		run: (sql: string) =>
			new Promise((res, rej) => db.run(sql, (e: Error | null) => (e ? rej(e) : res()))),
		all: (sql: string) =>
			new Promise((res, rej) =>
				db.all(sql, (e: Error | null, rows: Record<string, unknown>[]) => (e ? rej(e) : res(rows)))
			),
		close: () => new Promise((res, rej) => db.close((e: Error | null) => (e ? rej(e) : res())))
	};
}

describe('band axis over a non-VARCHAR column', () => {
	let db: DB;
	let identity: CategoricalIdentity;

	beforeEach(async () => {
		db = openDB();
		identity = new CategoricalIdentity(
			{
				async exec(sql: string | string[]) {
					for (const stmt of Array.isArray(sql) ? sql : [sql]) await db.run(stmt);
				},
				queryRows: (sql: string) => db.all(sql)
			},
			'ntest'
		);
	});

	afterEach(async () => {
		await db.close();
	});

	/** Build the scale the way setup does: adopt identity, register the domain. */
	async function scaleOver(table: string, field: string, order?: unknown[]) {
		await identity.ensureColumns(table, { categorical: [field] });
		const scale = new BandScaleState(field, [], { sourceField: field });
		scale.setIdentity(identity.identity(field));
		const distinct = await db.all(`SELECT DISTINCT "${field}" AS v FROM "${table}" ORDER BY v`);
		const cats = (order ?? distinct.map((r) => r.v)) as never[];
		scale.addMark(cats, 'mark-1', order ? { explicit: true } : {});
		scale.updateDomainFromExtents();
		return scale;
	}

	describe('INTEGER', () => {
		beforeEach(async () => {
			await db.run(`CREATE TABLE t AS SELECT * FROM (VALUES
				(2021, 5), (2022, 7), (2023, 3), (2021, 1)) v(yr, n)`);
		});

		it('keeps numbers in the dim rather than stringifying them', async () => {
			await identity.ensureColumns('t', { categorical: ['yr'] });
			const values = identity.identity('yr').values;

			expect(values).toEqual([2021, 2022, 2023]);
			expect(values.every((v) => typeof v === 'number')).toBe(true);
		});

		it('resolves value -> id with a numeric key', async () => {
			await identity.ensureColumns('t', { categorical: ['yr'] });
			// The lookup the scale performs on every addMark. A Map keyed by
			// string would miss every one of these and empty the domain.
			expect(identity.identity('yr').ids.get(2022)).toBe(1);
			expect(identity.identity('yr').ids.get('2022' as never)).toBeUndefined();
		});

		it('emits the same id for every row of a value through the view', async () => {
			await identity.ensureColumns('t', { categorical: ['yr'] });
			const rows = await db.all(
				`SELECT yr, "${identity.idColumn('yr')}" AS idx FROM "${identity.sourceFor('t')}" ORDER BY yr, n`
			);
			expect(rows.map((r) => [Number(r.yr), Number(r.idx)])).toEqual([
				[2021, 0],
				[2021, 0],
				[2022, 1],
				[2023, 2]
			]);
		});

		it('builds a domain, permutation and slot table from numeric values', async () => {
			const scale = await scaleOver('t', 'yr');

			expect(scale.effectiveDomain).toEqual([2021, 2022, 2023]);
			expect(Array.from(scale.displayOrder)).toEqual([0, 1, 2]);
			expect(Array.from(scale.slotTable)).toEqual([0, 1, 2]);
		});

		it('decodes a channel id back to a number, not a string', async () => {
			const scale = await scaleOver('t', 'yr');
			expect(scale.categoryAt(2)).toBe(2023);
			expect(scale.categoryAt(2)).not.toBe('2023');
		});

		it('feeds d3 a domain it can actually look up', async () => {
			// The assertion this whole file exists for. scaleBand indexes by the
			// raw domain value, so a stringified domain resolves to undefined and
			// every label pins to pixel 0 — the TextMark bug in a new disguise.
			const scale = await scaleOver('t', 'yr');
			const d3 = scale.getBaseScale('x', 300);
			scale.updateScaleDomain(d3 as never);

			expect(d3(2021 as never)).toBeTypeOf('number');
			expect(d3('2021' as never)).toBeUndefined();
		});

		it('keeps id and slot distinct when the axis is reordered', async () => {
			// Ids stay alphabetical/numeric-ascending from the dim; display order
			// is whatever the mark asked for. Conflating them looks correct on a
			// default chart and fails here.
			const scale = await scaleOver('t', 'yr', [2023, 2021, 2022]);

			expect(scale.effectiveDomain).toEqual([2023, 2021, 2022]);
			expect(Array.from(scale.displayOrder)).toEqual([2, 0, 1]);
			// slotTable[id] = slot: 2021(id 0)->1, 2022(id 1)->2, 2023(id 2)->0
			expect(Array.from(scale.slotTable)).toEqual([1, 2, 0]);
			expect(scale.idAtSlot(0)).toBe(2);
			expect(scale.categoryAt(scale.idAtSlot(0)!)).toBe(2023);
		});

		it('renders a numeric category as a tick label', async () => {
			// tickFormat is the one place a value is deliberately coerced, because
			// it is producing text rather than feeding a lookup.
			const scale = await scaleOver('t', 'yr');
			expect(scale.tickFormat()(0)).toBe('2021');
		});
	});

	describe('BIGINT', () => {
		beforeEach(async () => {
			await db.run(
				`CREATE TABLE big AS SELECT CAST(v AS BIGINT) AS yr FROM (VALUES (2021),(2022)) t(v)`
			);
		});

		it('keeps bigints, and matches them by value', async () => {
			// The driver hands back BigInt for BIGINT. A Map matches these by
			// value (SameValueZero), which is why the round trip holds — but
			// 2021n !== 2021, so a mixed pipeline would silently miss.
			await identity.ensureColumns('big', { categorical: ['yr'] });
			const identityFor = identity.identity('yr');

			expect(identityFor.values.every((v) => typeof v === 'bigint')).toBe(true);
			expect(identityFor.ids.get(2021n)).toBe(0);
			expect(identityFor.ids.get(2021 as never)).toBeUndefined();
		});

		it('carries bigints through to the domain', async () => {
			const scale = await scaleOver('big', 'yr');
			expect(scale.effectiveDomain).toEqual([2021n, 2022n]);
			expect(Array.from(scale.displayOrder)).toEqual([0, 1]);
			expect(scale.tickFormat()(1)).toBe('2022');
		});
	});

	describe('a fixed expression producing numbers (§16)', () => {
		it('dims the expression and keeps its numeric output', async () => {
			await db.run(`CREATE TABLE e AS SELECT * FROM (VALUES (1),(2),(3),(11),(12)) v(n)`);
			// year(ts)-shaped: numeric, tiny distinct set. §16.6 says syntax and
			// result type cannot answer the cardinality question, and this is the
			// shape that makes the point.
			const expr = 'CAST(n / 10 AS INTEGER)';
			await identity.ensureColumns('e', { categorical: [{ key: expr, sql: expr }] });

			expect(identity.identity(expr).values).toEqual([0, 1]);
			expect(identity.identity(expr).ids.get(1)).toBe(1);
		});
	});
});
