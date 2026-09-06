import { describe, it, expect } from 'vitest';
import {
	column as sqlColumn,
	count,
	sum,
	sql,
	avg,
	median,
	frameRows,
	preceding,
	following
} from '@uwdata/mosaic-sql';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { topN } from '$lib/transforms';
import { buildSchemaMap } from '$lib/query-engine/QueryEngine';
import {
	buildQueryParts,
	assembleQuery,
	castNumeric,
	splitWindowSelect,
	buildOuterWindow
} from './query-builder';

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

	describe('verbatim window fragments in channels', () => {
		// mosaic's isAggregateExpression returns 0 for a verbatim fragment
		// containing a window — the same value a plain column ref returns — so
		// without a guard these land in nonAggregateGroupBy and emit
		// `GROUP BY SUM(..) OVER (..)`, which no database accepts.
		it('refuses a verbatim window rather than grouping by it', () => {
			expect(() =>
				buildQueryParts(
					{ x: 'species', y: sql`SUM(${sqlColumn('v')}) OVER (PARTITION BY ${sqlColumn('g')})` },
					undefined,
					false
				)
			).toThrow(/verbatim SQL fragment containing a window function/);
		});

		it('refuses the stack transform shape (FILTER + OVER)', () => {
			const notNaN = sql`NOT isnan(${sqlColumn('v')})`;
			const cumulative = sql`SUM(${sqlColumn('v')}) FILTER (WHERE ${notNaN}) OVER (PARTITION BY ${sqlColumn('g')} ORDER BY ${sqlColumn('s')})`;
			expect(() => buildQueryParts({ x: 'species', y1: cumulative }, undefined, false)).toThrow(
				/cannot analyze/
			);
		});

		it('names the offending channel', () => {
			expect(() =>
				buildQueryParts(
					{ x: 'species', y1: sql`SUM(${sqlColumn('v')}) OVER (PARTITION BY ${sqlColumn('g')})` },
					undefined,
					false
				)
			).toThrow(/"y1"/);
		});

		it('still accepts verbatim fragments with no window', () => {
			const parts = buildQueryParts(
				{ x: 'species', y: sql`${sqlColumn('a')} + ${sqlColumn('b')}` },
				undefined,
				false
			);
			expect(parts.hasAggregates).toBe(false);
			expect(parts.nonAggregateGroupBy).toHaveLength(2);
		});

		it('still accepts structured window nodes', () => {
			const win = (sum(sqlColumn('v')) as any)
				.orderby(sqlColumn('date'))
				.frame(frameRows([preceding(3), following(3)]));
			const parts = buildQueryParts({ x: 'date', y: win }, undefined, false);
			expect(parts.hasWindowAggregates).toBe(true);
			// The window is kept out of GROUP BY, but via the window path.
			expect(parts.nonAggregateGroupBy).toHaveLength(1);
		});
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
		expect(parts.hasWindowAggregates).toBe(true);
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
// castNumeric — the single CAST policy
// ---------------------------------------------------------------------------

describe('castNumeric', () => {
	const schema = buildSchemaMap([
		{ name: 'value', type: 'DOUBLE', nullable: true },
		{ name: 'species', type: 'VARCHAR', nullable: true }
	]);
	const WRAP = /^coalesce\(\(.*\)::REAL, 'NaN'::REAL\)$/;

	it('always wraps aggregates', () => {
		expect(String(castNumeric(count(), schema))).toMatch(WRAP);
		expect(String(castNumeric(sum('revenue'), null))).toMatch(WRAP);
	});

	it('always wraps window functions', () => {
		const w = avg('value').partitionby('series').orderby('date');
		expect(String(castNumeric(w, null))).toMatch(WRAP);
	});

	it('wraps non-column SQL nodes (CASE / bin expressions)', () => {
		const binExpr = sql`(30 + (5 * floor(("weight" - 30) / 5)))`;
		expect(String(castNumeric(binExpr, null))).toMatch(WRAP);
	});

	it('wraps column refs only when the schema says numeric', () => {
		expect(String(castNumeric(sqlColumn('value'), schema))).toMatch(WRAP);
		expect(String(castNumeric(sqlColumn('species'), schema))).toBe('"species"');
		// Unknown schema: column refs pass through untouched
		expect(String(castNumeric(sqlColumn('value'), null))).toBe('"value"');
	});

	it('passes null through', () => {
		expect(castNumeric(null, schema)).toBeNull();
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

	function assemble(
		parts: ReturnType<typeof buildQueryParts>,
		extra: Partial<Parameters<typeof assembleQuery>[0]> = {}
	) {
		return String(assembleQuery({ table: 't', parts, transformCompiler: noopCompiler, ...extra }));
	}

	it('produces a basic SELECT query', () => {
		const s = assemble(simpleParts({ x: 'species', y: count() }));
		expect(s).toContain('SELECT');
		expect(s).toContain('FROM "t"');
	});

	it('adds GROUP BY when aggregates are present', () => {
		expect(assemble(simpleParts({ x: 'species', y: count() }))).toContain('GROUP BY');
	});

	it('omits GROUP BY when no aggregates', () => {
		expect(assemble(simpleParts({ x: 'a', y: 'b' }))).not.toContain('GROUP BY');
	});

	it('uses channel names as aliases for expressions, field names for columns', () => {
		const s = assemble(simpleParts({ x: 'species', y: count() }));
		expect(s).toContain('"species"');
		expect(s).toMatch(/count\(\*\) AS "y"/);
	});

	it('applies filter predicates', () => {
		const s = assemble(simpleParts({ x: 'a', y: 'b' }), { filter: [sql`"a" > 10`] });
		expect(s).toContain('WHERE');
		expect(s).toContain('"a" > 10');
	});

	it('applies null filters', () => {
		const s = assemble(simpleParts({ x: 'a', y: 'b' }), { filterNulls: [sqlColumn('a')] });
		expect(s).toContain('NOT NULL');
	});

	it('adds ORDER BY for connected config', () => {
		const parts = simpleParts(
			{ x: 'date', y: 'value', stroke: 'series' },
			{ seriesChannel: 'stroke', dimensionChannel: 'x' }
		);
		expect(assemble(parts)).toMatch(/ORDER BY "stroke", "x"$/);
	});

	it('applies LIMIT last', () => {
		const parts = simpleParts(
			{ x: 'date', y: 'value', stroke: 'series' },
			{ seriesChannel: 'stroke', dimensionChannel: 'x' }
		);
		expect(assemble(parts, { limit: 500 })).toMatch(/ORDER BY "stroke", "x" LIMIT 500$/);
	});

	it('GROUP BY uses unwrapped expressions when selectDef is CAST-wrapped', () => {
		const parts = simpleParts({ x: 'category', y: count() });
		parts.selectDef = {
			x: castNumeric(parts.selectDef.x, null),
			y: castNumeric(parts.selectDef.y, null)
		};
		const s = assemble(parts);
		expect(s).toMatch(/coalesce\(\(count\(\*\)\)::REAL, 'NaN'::REAL\) AS "y"/);
		expect(s).toMatch(/GROUP BY "category"/);
		expect(s).not.toMatch(/GROUP BY.*coalesce/);
	});

	it('applies filters to the base scan before SQL transform CTEs', () => {
		const compiler = new TransformCompiler([topN(3)], {
			markType: 'bary',
			table: 't',
			x: 'x',
			y: 'y2'
		});
		const parts = buildQueryParts({ x: 'category', y2: sum('revenue') }, undefined, true);
		const s = String(
			assembleQuery({
				table: 't',
				parts,
				filter: [sql`"region" = 'North'`],
				transformCompiler: compiler
			})
		);
		// Predicate appears once, inside the ranked subquery (before its alias).
		expect(s.split(`"region" = 'North'`).length - 1).toBe(1);
		expect(s.indexOf(`"region" = 'North'`)).toBeLessThan(s.indexOf('"__topn_base"'));
		expect(s).toMatch(/ROW_NUMBER/);
	});

	describe('window CTE wrapping', () => {
		const rolling = avg('value')
			.partitionby('series')
			.orderby('date')
			.frame(frameRows([preceding(1), following(1)]));
		const selectDef = { x: sqlColumn('date'), stroke: sqlColumn('series'), y: rolling };
		const passthrough = new Map([
			['x', 'date'],
			['stroke', 'series']
		]);

		function windowed(extra: Partial<Parameters<typeof assembleQuery>[0]> = {}) {
			const parts = buildQueryParts(
				selectDef,
				{ seriesChannel: 'stroke', dimensionChannel: 'x' },
				false,
				passthrough
			);
			const split = splitWindowSelect(selectDef, passthrough, null);
			return String(
				assembleQuery({
					table: 't',
					parts: {
						...parts,
						selectDef: split.innerSelect,
						nonAggregateGroupBy: split.innerGroupBy,
						hasAggregates: true
					},
					transformCompiler: noopCompiler,
					window: { channels: split.windowChannels, cteName: '__window_cte' },
					...extra
				})
			);
		}

		it('splits into inner GROUP BY and outer window over channel aliases', () => {
			const split = splitWindowSelect(selectDef, passthrough, null);
			expect(Object.keys(split.innerSelect)).toEqual(['x', 'stroke', 'y']);
			expect(String(split.innerSelect.y)).toMatch(/coalesce\(\(avg\("value"\)\)::REAL/);
			expect(split.innerGroupBy.map(String)).toEqual(['"x"', '"stroke"']);
			// Outer: AVG-of-means over the channel alias, def rewritten to aliases
			expect(String(split.windowChannels.y)).toMatch(
				/^avg\("y"\) OVER \(PARTITION BY "stroke" ORDER BY "x" ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING\)$/
			);
		});

		it('COUNT maps to SUM in the outer window', () => {
			const w = count().partitionby('series').orderby('date');
			const outer = buildOuterWindow('y', w as never, new Map());
			expect(String(outer)).toMatch(/^sum\("y"\) OVER/);
		});

		it('wraps in a CTE with ORDER BY and LIMIT on the outer query', () => {
			const s = windowed({ limit: 100 });
			expect(s).toMatch(/^WITH "__window_cte" AS \(SELECT .* GROUP BY "x", "stroke"\) SELECT /);
			expect(s).toMatch(/coalesce\(\(avg\("y"\) OVER \(.*\)\)::REAL, 'NaN'::REAL\) AS "y"/);
			expect(s).toMatch(/FROM "__window_cte" ORDER BY "stroke", "x" LIMIT 100$/);
			// Inner query carries no ORDER BY / LIMIT
			expect(s.indexOf('ORDER BY "stroke"')).toBeGreaterThan(s.indexOf('FROM "__window_cte"'));
		});

		it('applies filters inside the CTE, not on the windowed output', () => {
			const s = windowed({ filter: [sql`"series" = 'A'`] });
			expect(s.indexOf(`"series" = 'A'`)).toBeLessThan(s.indexOf(') SELECT'));
		});

		it('rejects a window whose inner aggregate has no outer counterpart', () => {
			// MEDIAN of per-group medians is not a median; there is no valid outer agg.
			const medianWindow = median('value').partitionby('series').orderby('date');
			expect(buildOuterWindow('y', medianWindow as never, new Map())).toBeNull();
			expect(() => splitWindowSelect({ y: medianWindow }, new Map(), null)).toThrow(
				/no outer aggregate/
			);
		});
	});
});
