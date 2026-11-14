import { describe, it, expect } from 'vitest';
import { SourceRouting, sourceDDL } from './source-routing';

describe('SourceRouting', () => {
	it('reads an unknown source on a lane, and a fast one on the main connection', () => {
		const r = new SourceRouting(4);
		expect(r.route('flights')).not.toBeNull();
		r.noteLaneRead('flights', 0, 3, 100);
		expect(r.cost('flights')).toBe('fast');
		expect(r.route('flights')).toBeNull();
	});

	it('marks a source slow when a lane read takes more than two slices', () => {
		const r = new SourceRouting(4);
		r.noteLaneRead('slow_view', 40, 200, 1);
		expect(r.cost('slow_view')).toBe('slow');
		expect(r.route('slow_view')).not.toBeNull();
	});

	it('turns a cold source fast again on its next quick lane read (a view slow only the first time)', () => {
		const r = new SourceRouting(4);
		r.noteLaneRead('cold', 40, 200, 10);
		expect(r.cost('cold')).toBe('slow');
		r.noteLaneRead('cold', 1, 8, 10);
		expect(r.cost('cold')).toBe('fast');
		expect(r.route('cold')).toBeNull();
	});

	it('keeps a large result on the main connection when its execution is short', () => {
		const r = new SourceRouting(4);
		// 2M rows: many slices on transfer, but executed in 60 ms.
		r.noteLaneRead('dots', 12, 60, 2_000_000);
		expect(r.cost('dots')).toBe('fast');
	});

	it('slices a large result whose execution alone is long', () => {
		const r = new SourceRouting(4);
		r.noteLaneRead('dots', 40, 250, 2_000_000);
		expect(r.cost('dots')).toBe('slow');
	});

	it('needs two consecutive slow reads on the main connection to turn a fast source slow', () => {
		const r = new SourceRouting(4);
		r.noteLaneRead('t', 0, 2, 10);
		r.noteMainRead('t', 80, 10);
		expect(r.cost('t')).toBe('fast');
		r.noteMainRead('t', 5, 10);
		r.noteMainRead('t', 80, 10);
		expect(r.cost('t')).toBe('fast');
		r.noteMainRead('t', 80, 10);
		expect(r.cost('t')).toBe('slow');
	});

	it('judges a large main-connection read against the longer limit', () => {
		const r = new SourceRouting(4);
		r.noteLaneRead('dots', 0, 2, 10);
		r.noteMainRead('dots', 90, 2_000_000);
		r.noteMainRead('dots', 90, 2_000_000);
		expect(r.cost('dots')).toBe('fast');
	});

	it('spreads sources over the lanes and keeps each on its own', () => {
		const r = new SourceRouting(2);
		const a = r.route('a');
		const b = r.route('b');
		expect(a).not.toBe(b);
		expect(r.route('a')).toBe(a);
	});

	it('forgets costs on a reload', () => {
		const r = new SourceRouting(4);
		r.noteLaneRead('t', 0, 2, 10);
		r.reset();
		expect(r.cost('t')).toBe('unknown');
		expect(r.route('t')).not.toBeNull();
	});

	it('applies a prior only to an unmeasured, unhinted source', () => {
		const r = new SourceRouting(4);
		r.prior('flights', 'fast');
		expect(r.route('flights')).toBeNull();
		r.noteLaneRead('view', 40, 200, 1);
		r.prior('view', 'fast');
		expect(r.cost('view')).toBe('slow');
	});

	it("keeps an app's hint over the prior and across a reload, and still lets a read correct it", () => {
		const r = new SourceRouting(4);
		r.hint('big_table', 'slow');
		r.prior('big_table', 'fast');
		expect(r.cost('big_table')).toBe('slow');
		r.reset();
		expect(r.cost('big_table')).toBe('slow');
		r.noteLaneRead('big_table', 0, 2, 10);
		expect(r.cost('big_table')).toBe('fast');
	});
});

describe('sourceDDL', () => {
	it.each([
		['CREATE TABLE flights AS SELECT 1', { kind: 'table', name: 'flights', temp: false }],
		[
			'create or replace temp table "My ""T""" (a INT)',
			{ kind: 'table', name: 'My "T"', temp: true }
		],
		['CREATE TEMPORARY TABLE IF NOT EXISTS t2(a INT)', { kind: 'table', name: 't2', temp: true }],
		[
			'  CREATE OR REPLACE VIEW slow_rule AS SELECT 1',
			{ kind: 'view', name: 'slow_rule', temp: false }
		],
		['CREATE VIEW IF NOT EXISTS v AS SELECT 1', { kind: 'view', name: 'v', temp: false }],
		['CREATE TEMP VIEW tv AS SELECT 1', { kind: 'view', name: 'tv', temp: true }],
		['DROP TABLE IF EXISTS "__dplot_preagg_1"', { kind: 'drop', name: '__dplot_preagg_1' }],
		['DROP VIEW v', { kind: 'drop', name: 'v' }]
	])('reads %s', (sql, expected) => {
		expect(sourceDDL(sql)).toEqual(expected);
	});

	it.each([
		'CREATE TABLE remote.flights AS SELECT 1',
		'CREATE TABLE "db"."t" (a INT)',
		'CREATE MACRO m(x) AS x + 1',
		"CREATE TYPE mood AS ENUM ('a')",
		'CREATE SEQUENCE s',
		'CREATE UNIQUE INDEX i ON t (a)',
		'SELECT * FROM t',
		'DROP SCHEMA s',
		'INSERT INTO t VALUES (1)'
	])('leaves %s alone', (sql) => {
		expect(sourceDDL(sql)).toBeNull();
	});
});
