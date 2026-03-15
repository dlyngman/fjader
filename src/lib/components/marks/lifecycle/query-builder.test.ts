import { describe, it, expect } from 'vitest';
import { column as sqlColumn, count, sum, sql } from '@uwdata/mosaic-sql';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { buildFieldInfoRequests, buildQueryParts, assembleQuery } from './query-builder';

// ---------------------------------------------------------------------------
// buildFieldInfoRequests
// ---------------------------------------------------------------------------

describe('buildFieldInfoRequests', () => {
	it('creates requests for numeric scale columns', () => {
		const requests = buildFieldInfoRequests(
			{ x: 'price', y: 'quantity' },
			'products',
			'linear',
			'linear'
		);
		expect(requests).toHaveLength(2);
		expect(requests[0]).toMatchObject({ table: 'products', stats: ['min', 'max'] });
		expect(requests[1]).toMatchObject({ table: 'products', stats: ['min', 'max'] });
	});

	it('skips aggregate expressions', () => {
		const requests = buildFieldInfoRequests(
			{ x: 'species', y: count() },
			'penguins',
			'band',
			'linear'
		);
		// x is band (not numeric) -> skipped; y is aggregate -> skipped
		expect(requests).toHaveLength(0);
	});

	it('skips time scale columns', () => {
		const requests = buildFieldInfoRequests(
			{ x: 'date', y: 'value' },
			'timeseries',
			'time',
			'linear'
		);
		// x is time -> skipped; y is linear -> included
		expect(requests).toHaveLength(1);
	});

	it('deduplicates same field used in multiple channels', () => {
		const requests = buildFieldInfoRequests({ x: 'value', y: 'value' }, 't', 'linear', 'linear');
		expect(requests).toHaveLength(1);
	});

	it('skips null select values', () => {
		const requests = buildFieldInfoRequests({ x: 'price', y: null }, 't', 'linear', 'linear');
		expect(requests).toHaveLength(1);
	});
});

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
});
