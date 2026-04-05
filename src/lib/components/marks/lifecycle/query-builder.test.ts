import { describe, it, expect } from 'vitest';
import { column as sqlColumn, count, sum, sql, avg } from '@uwdata/mosaic-sql';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { buildQueryParts, assembleQuery } from './query-builder';

// ---------------------------------------------------------------------------
// buildQueryParts
// ---------------------------------------------------------------------------

describe('buildQueryParts', () => {
	it('classifies simple fields as non-aggregates', () => {
		const parts = buildQueryParts({ x: 'species', y: 'count_val' }, undefined, false);
		expect(parts.hasAggregates).toBe(false);
		expect(parts.nonAggregateGroupBy).toHaveLength(2);
		expect(parts.orderChannels).toBeNull();
	});

	it('detects aggregates and excludes them from GROUP BY', () => {
		const parts = buildQueryParts({ x: 'species', y: count() }, undefined, false);
		expect(parts.hasAggregates).toBe(true);
		// Only 'species' in GROUP BY, not count()
		expect(parts.nonAggregateGroupBy).toHaveLength(1);
	});

	it('maps simple column refs to field-name aliases', () => {
		const parts = buildQueryParts({ x: 'species', y: count() }, undefined, false);
		expect(parts.aliasMap.get('x')).toBe('species');
		// count() is an expression -> alias is channel name
		expect(parts.aliasMap.get('y')).toBe('y');
	});

	it('maps expression nodes to channel-name aliases', () => {
		const parts = buildQueryParts({ fill: sum('revenue') }, undefined, false);
		expect(parts.aliasMap.get('fill')).toBe('fill');
	});

	it('excludes window expressions from both aggregates and GROUP BY', () => {
		// Window nodes have type === 'WINDOW'
		const windowNode = sum('x').partitionby('category').orderby('date');
		const parts = buildQueryParts({ x: 'date', y: windowNode }, undefined, false);
		expect(parts.hasAggregates).toBe(false);
		// Only 'date' in GROUP BY, window skipped
		expect(parts.nonAggregateGroupBy).toHaveLength(1);
	});

	it('builds order channels for connected config', () => {
		const parts = buildQueryParts(
			{ x: 'date', y: 'value', stroke: 'series' },
			{ seriesChannel: 'stroke', dimensionChannel: 'x' },
			false
		);
		expect(parts.orderChannels).toEqual(['stroke', 'x']);
	});

	it('includes __facet in order channels when present', () => {
		const parts = buildQueryParts(
			{ x: 'date', y: 'value', __facet: 'region' },
			{ seriesChannel: null, dimensionChannel: 'x' },
			false
		);
		expect(parts.orderChannels).toEqual(['__facet', 'x']);
	});

	it('deduplicates GROUP BY when multiple channels reference same column', () => {
		const parts = buildQueryParts({ x: 'value', x2: 'value' }, undefined, false);
		// Both map to sqlColumn('value') with alias 'value' — deduped
		expect(parts.nonAggregateGroupBy).toHaveLength(1);
	});

	it('skips null select values', () => {
		const parts = buildQueryParts({ x: 'a', y: null }, undefined, false);
		expect(parts.nonAggregateGroupBy).toHaveLength(1);
		expect(parts.aliasMap.size).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// assembleQuery
// ---------------------------------------------------------------------------

describe('assembleQuery', () => {
	const noopCompiler = new TransformCompiler([]);

	function simpleParts(
		select: Record<string, unknown>,
		connected?: { seriesChannel: string | null; dimensionChannel: string }
	) {
		return buildQueryParts(select, connected, false);
	}

	it('produces a basic SELECT query', () => {
		const parts = simpleParts({ x: 'species', y: count() });
		const q = assembleQuery('penguins', parts, [], null, noopCompiler, false);
		const sql = String(q);
		expect(sql).toContain('SELECT');
		expect(sql).toContain('FROM "penguins"');
	});

	it('adds GROUP BY when aggregates are present', () => {
		const parts = simpleParts({ x: 'species', y: count() });
		const q = assembleQuery('penguins', parts, [], null, noopCompiler, false);
		const sql = String(q);
		expect(sql).toContain('GROUP BY');
	});

	it('omits GROUP BY when no aggregates', () => {
		const parts = simpleParts({ x: 'a', y: 'b' });
		const q = assembleQuery('t', parts, [], null, noopCompiler, false);
		const sql = String(q);
		expect(sql).not.toContain('GROUP BY');
	});

	it('translates to field-based aliases when forMosaic=true', () => {
		const parts = simpleParts({ x: 'species', y: count() });
		const qMosaic = assembleQuery('t', parts, [], null, noopCompiler, true);
		const qInternal = assembleQuery('t', parts, [], null, noopCompiler, false);
		const sqlMosaic = String(qMosaic);
		const sqlInternal = String(qInternal);
		// forMosaic uses field name 'species' as alias; internal uses channel 'x'
		expect(sqlMosaic).toContain('"species"');
		expect(sqlInternal).toContain('"x"');
	});

	it('applies filter predicates', () => {
		const parts = simpleParts({ x: 'a', y: 'b' });
		const filter = [sql`"a" > 10`];
		const q = assembleQuery('t', parts, filter, null, noopCompiler, false);
		const s = String(q);
		expect(s).toContain('WHERE');
		expect(s).toContain('"a" > 10');
	});

	it('applies null filters', () => {
		const parts = simpleParts({ x: 'a', y: 'b' });
		const q = assembleQuery('t', parts, [], [sqlColumn('a')], noopCompiler, false);
		const s = String(q);
		expect(s).toContain('NOT NULL');
	});

	it('adds ORDER BY for connected config', () => {
		const parts = simpleParts(
			{ x: 'date', y: 'value', stroke: 'series' },
			{ seriesChannel: 'stroke', dimensionChannel: 'x' }
		);
		const q = assembleQuery('t', parts, [], null, noopCompiler, false);
		const s = String(q);
		expect(s).toContain('ORDER BY');
	});

	it('casts numeric channel expressions to REAL for zero-copy Arrow access', () => {
		const parts = simpleParts({ x: 'date', y: 'value' });
		const numericChannels = new Set(['x', 'y']);
		const q = assembleQuery('t', parts, [], null, noopCompiler, true, numericChannels);
		const s = String(q);
		// COALESCE(CAST(expr AS REAL), 'NaN'::REAL) for null-safe zero-copy
		expect(s).toMatch(/coalesce\(\("value"\)::REAL, 'NaN'::REAL\)/);
		expect(s).toMatch(/coalesce\(\("date"\)::REAL, 'NaN'::REAL\)/);
	});

	it('does not cast channels outside numericCastChannels', () => {
		const parts = simpleParts({ x: 'species', y: count() });
		// No numericCastChannels passed — nothing gets cast
		const q = assembleQuery('t', parts, [], null, noopCompiler, true);
		const s = String(q);
		expect(s).not.toMatch(/::REAL/);
		expect(s).not.toContain('coalesce');
	});

	it('ORDER BY uses field aliases when forMosaic=true', () => {
		const parts = simpleParts(
			{ x: 'date', y: 'value', stroke: 'series' },
			{ seriesChannel: 'stroke', dimensionChannel: 'x' }
		);
		const qMosaic = assembleQuery('t', parts, [], null, noopCompiler, true);
		const s = String(qMosaic);
		// Should use 'series' and 'date' (field names), not 'stroke' and 'x' (channel names)
		expect(s).toContain('"series"');
		expect(s).toContain('"date"');
	});

	// -----------------------------------------------------------------------
	// COALESCE null-safe casting — proposal validation
	// -----------------------------------------------------------------------

	it('wraps aggregates (count, sum, avg) with COALESCE+CAST', () => {
		const parts = simpleParts({ x: 'category', y: count() });
		const q = assembleQuery('t', parts, [], null, noopCompiler, true, new Set(['y']));
		const s = String(q);
		// count() gets COALESCE wrapping; x (band) does not
		expect(s).toMatch(/coalesce\(\(count\(\*\)\)::REAL, 'NaN'::REAL\)/);
		expect(s).not.toMatch(/coalesce\(\("category"\)/);
	});

	it('wraps sum aggregate with COALESCE+CAST', () => {
		const parts = simpleParts({ x: 'region', y: sum('revenue') });
		const q = assembleQuery('t', parts, [], null, noopCompiler, true, new Set(['y']));
		const s = String(q);
		expect(s).toMatch(/coalesce\(\(sum\("revenue"\)\)::REAL, 'NaN'::REAL\)/);
	});

	it('wraps inline SQL expressions with COALESCE+CAST', () => {
		const binExpr = sql`(30 + (5 * floor(("weight" - 30) / 5)))`;
		const parts = simpleParts({ x: binExpr, y: count() });
		const q = assembleQuery('t', parts, [], null, noopCompiler, true, new Set(['x']));
		const s = String(q);
		expect(s).toMatch(/coalesce\(\(\(30 \+ \(5 \* floor\(\("weight" - 30\) \/ 5\)\)\)\)::REAL, 'NaN'::REAL\)/);
	});

	it('preserves field-name aliases when COALESCE wrapping simple columns', () => {
		const parts = simpleParts({ x: 'date', y: 'value' });
		const q = assembleQuery('t', parts, [], null, noopCompiler, true, new Set(['x', 'y']));
		const s = String(q);
		// Aliases should be field names (date, value), not channel names (x, y)
		expect(s).toMatch(/coalesce\(\("date"\)::REAL, 'NaN'::REAL\) AS "date"/);
		expect(s).toMatch(/coalesce\(\("value"\)::REAL, 'NaN'::REAL\) AS "value"/);
	});

	it('preserves channel-name aliases for expression nodes', () => {
		const parts = simpleParts({ x: 'species', y: count() });
		const q = assembleQuery('t', parts, [], null, noopCompiler, true, new Set(['y']));
		const s = String(q);
		// count() alias should be channel name 'y'
		expect(s).toMatch(/coalesce\(\(count\(\*\)\)::REAL, 'NaN'::REAL\) AS "y"/);
	});

	it('GROUP BY uses unwrapped expressions (not COALESCE-wrapped)', () => {
		const parts = simpleParts({ x: 'category', y: count() });
		const q = assembleQuery('t', parts, [], null, noopCompiler, true, new Set(['y']));
		const s = String(q);
		// GROUP BY should reference raw column, not wrapped
		expect(s).toMatch(/GROUP BY "category"/);
		expect(s).not.toMatch(/GROUP BY.*coalesce/);
	});

	it('GROUP BY is correct with COALESCE on non-aggregate numeric channels', () => {
		// Histogram-style: both x channels are non-aggregate expressions, y is count
		const parts = simpleParts({ x: 'bin_start', x2: 'bin_end', y: count() });
		const q = assembleQuery('t', parts, [], null, noopCompiler, true, new Set(['x', 'x2', 'y']));
		const s = String(q);
		// GROUP BY should have both bin columns, unwrapped
		expect(s).toMatch(/GROUP BY "bin_start", "bin_end"/);
		// SELECT should have COALESCE wrappers
		expect(s).toMatch(/coalesce\(\("bin_start"\)::REAL/);
		expect(s).toMatch(/coalesce\(\("bin_end"\)::REAL/);
		expect(s).toMatch(/coalesce\(\(count\(\*\)\)::REAL/);
	});

	it('does not COALESCE-wrap when forMosaic=false (sidecar queries)', () => {
		const parts = simpleParts({ x: 'date', y: 'value' });
		const q = assembleQuery('t', parts, [], null, noopCompiler, false, new Set(['x', 'y']));
		const s = String(q);
		expect(s).not.toContain('coalesce');
		expect(s).not.toMatch(/::REAL/);
	});

	it('selectively wraps only numericCastChannels, leaving others untouched', () => {
		const parts = simpleParts({ x: 'species', y: 'value', stroke: 'series' });
		// Only y is numeric
		const q = assembleQuery('t', parts, [], null, noopCompiler, true, new Set(['y']));
		const s = String(q);
		expect(s).toMatch(/coalesce\(\("value"\)::REAL, 'NaN'::REAL\)/);
		expect(s).not.toMatch(/coalesce\(\("species"\)/);
		expect(s).not.toMatch(/coalesce\(\("series"\)/);
	});

	it('ORDER BY works correctly alongside COALESCE-wrapped SELECT', () => {
		const parts = simpleParts(
			{ x: 'date', y: 'value', stroke: 'series' },
			{ seriesChannel: 'stroke', dimensionChannel: 'x' }
		);
		const q = assembleQuery('t', parts, [], null, noopCompiler, true, new Set(['x', 'y']));
		const s = String(q);
		// ORDER BY uses field aliases (not COALESCE-wrapped)
		expect(s).toMatch(/ORDER BY "series", "date"/);
		// SELECT has COALESCE wrapping
		expect(s).toMatch(/coalesce\(\("date"\)::REAL/);
		expect(s).toMatch(/coalesce\(\("value"\)::REAL/);
	});

	it('COALESCE wrapping a REAL column is harmless (no double-cast)', () => {
		// CAST(REAL AS REAL) is a no-op in DuckDB; COALESCE just adds null check
		const parts = simpleParts({ x: 'already_real_col', y: count() });
		const q = assembleQuery('t', parts, [], null, noopCompiler, true, new Set(['x']));
		const s = String(q);
		// Should produce exactly one layer of COALESCE(CAST(...))
		expect(s).toMatch(/coalesce\(\("already_real_col"\)::REAL, 'NaN'::REAL\)/);
		// No nested coalesce
		expect(s).not.toMatch(/coalesce\(coalesce/);
	});
});
