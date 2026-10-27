import { describe, it, expect } from 'vitest';
import {
	sum,
	count,
	avg,
	min,
	max,
	div,
	column,
	add,
	sql,
	rank,
	frameRows,
	preceding,
	following,
	type ExprNode,
	type AggregateNode
} from '@uwdata/mosaic-sql';
import { rewriteForPreagg, buildBinExpr, binsFineEnough } from './sufficient-statistics';

// Helper: build a selectDef with the given channel→expression mapping
function selectDef(entries: Record<string, ExprNode>): Record<string, unknown> {
	return entries as Record<string, unknown>;
}

describe('rewriteForPreagg', () => {
	it('handles pure dimension (no aggregates)', () => {
		const result = rewriteForPreagg(selectDef({ x: column('category') }));
		expect(result).not.toBeNull();
		expect(result!.preaggGroupBy).toHaveLength(1);
		// Dimension goes into preagg table as-is
		expect(Object.keys(result!.preaggCols)).toContain('x');
		// Output references the preagg column
		expect(result!.outputSelect.x.toString()).toMatch(/\"x\"/);
	});

	it('rewrites COUNT(*)', () => {
		const result = rewriteForPreagg(
			selectDef({
				x: column('category'),
				y: count() as unknown as ExprNode
			})
		);
		expect(result).not.toBeNull();
		// One partial column for count
		const partials = Object.keys(result!.preaggCols).filter((k) => k.startsWith('__ps'));
		expect(partials).toHaveLength(1);
		// Output: COALESCE(SUM(partial), 0)
		const output = result!.outputSelect.y.toString().toLowerCase();
		expect(output).toMatch(/coalesce/);
		expect(output).toMatch(/sum/);
	});

	it('rewrites SUM(x)', () => {
		const result = rewriteForPreagg(
			selectDef({
				x: column('category'),
				y: sum(column('revenue')) as unknown as ExprNode
			})
		);
		expect(result).not.toBeNull();
		const partials = Object.keys(result!.preaggCols).filter((k) => k.startsWith('__ps'));
		expect(partials).toHaveLength(1);
		// Output: SUM(partial_sum)
		const output = result!.outputSelect.y.toString().toLowerCase();
		expect(output).toMatch(/sum/);
	});

	it('rewrites AVG(x) to SUM/COUNT (two partials)', () => {
		const result = rewriteForPreagg(
			selectDef({
				x: column('category'),
				y: avg(column('revenue')) as unknown as ExprNode
			})
		);
		expect(result).not.toBeNull();
		const partials = Object.keys(result!.preaggCols).filter((k) => k.startsWith('__ps'));
		expect(partials).toHaveLength(2); // sum + count
		// Output should have division
		const output = result!.outputSelect.y.toString();
		expect(output).toMatch(/\//);
	});

	it('rewrites MIN(x)', () => {
		const result = rewriteForPreagg(
			selectDef({
				x: column('category'),
				y: min(column('price')) as unknown as ExprNode
			})
		);
		expect(result).not.toBeNull();
		const output = result!.outputSelect.y.toString().toLowerCase();
		expect(output).toMatch(/min/);
	});

	it('rewrites MAX(x)', () => {
		const result = rewriteForPreagg(
			selectDef({
				x: column('category'),
				y: max(column('price')) as unknown as ExprNode
			})
		);
		expect(result).not.toBeNull();
		const output = result!.outputSelect.y.toString().toLowerCase();
		expect(output).toMatch(/max/);
	});

	it('preserves arithmetic: SUM(x) / COUNT(*)', () => {
		const expr = div(
			sum(column('x')) as unknown as ExprNode,
			count() as unknown as ExprNode
		) as unknown as ExprNode;
		const result = rewriteForPreagg(selectDef({ x: column('cat'), y: expr }));
		expect(result).not.toBeNull();
		// Output should still contain division
		const output = result!.outputSelect.y.toString();
		expect(output).toMatch(/\//);
	});

	it('preserves arithmetic: SUM(x) + SUM(y)', () => {
		const expr = add(
			sum(column('a')) as unknown as ExprNode,
			sum(column('b')) as unknown as ExprNode
		) as unknown as ExprNode;
		const result = rewriteForPreagg(selectDef({ x: column('cat'), y: expr }));
		expect(result).not.toBeNull();
		const partials = Object.keys(result!.preaggCols).filter((k) => k.startsWith('__ps'));
		expect(partials).toHaveLength(2); // two separate SUM partials
	});

	it('returns null for DISTINCT aggregates', () => {
		const expr = (count(column('x')) as AggregateNode).distinct() as unknown as ExprNode;
		const result = rewriteForPreagg(selectDef({ x: column('cat'), y: expr }));
		expect(result).toBeNull();
	});

	it('returns null when selectDef has null expression', () => {
		const result = rewriteForPreagg({ x: null });
		expect(result).toBeNull();
	});

	it('deduplicates identical partial columns', () => {
		// SUM(x) appears in two channels — should produce only one partial
		const result = rewriteForPreagg(
			selectDef({
				x: column('cat'),
				y: sum(column('val')) as unknown as ExprNode,
				z: sum(column('val')) as unknown as ExprNode
			})
		);
		expect(result).not.toBeNull();
		const partials = Object.keys(result!.preaggCols).filter((k) => k.startsWith('__ps'));
		expect(partials).toHaveLength(1);
	});
});

describe('buildBinExpr', () => {
	it('bins a window of one viewport each side, with an edge bin beyond each end', () => {
		const { expr, d0, scaleFactor, bins } = buildBinExpr(column('price'), [0, 100], 800);
		const sql = expr.toString();
		expect(sql).toMatch(/FLOOR/i);
		expect(sql).toMatch(/INTEGER/i);
		expect(sql).toMatch(/CASE WHEN .* < 0 THEN -1 WHEN .* >= 2400 THEN 2400 ELSE/);
		expect(d0).toBe(-100); // one viewport below the domain
		expect(scaleFactor).toBe(8); // 800 / 100
		expect(bins).toBe(2400); // three viewports of 800 px
	});

	it('handles non-zero domain start', () => {
		const { d0, scaleFactor } = buildBinExpr(column('price'), [50, 150], 800);
		expect(d0).toBe(-50);
		expect(scaleFactor).toBe(8); // 800 / 100
	});
});

describe('binsFineEnough', () => {
	it('passes bins at least as fine as the pixels, and an unknown view', () => {
		expect(binsFineEnough(1, 1000, 1000)).toBe(true); // equal
		expect(binsFineEnough(1, 2000, 1000)).toBe(true); // zoomed out
		expect(binsFineEnough(1, 500, 1000)).toBe(false); // zoomed in
		expect(binsFineEnough(1, NaN, 1000)).toBe(true);
		expect(binsFineEnough(1, 1000, 0)).toBe(true);
	});
});

// Helper: build a window expression (aggregate OVER (ORDER BY orderCol ROWS frame))
function windowExpr(agg: ExprNode, orderCol: string) {
	return (agg as any).orderby(column(orderCol)).frame(frameRows([preceding(3), following(3)]));
}

describe('rewriteForPreagg — window expressions', () => {
	it('handles window expression wrapping AVG', () => {
		const result = rewriteForPreagg(
			selectDef({
				x: column('date'),
				y: windowExpr(avg(column('revenue')), 'date')
			})
		);
		expect(result).not.toBeNull();
		expect(result!.windowChannels).not.toBeNull();
		expect(result!.windowChannels!.y).toBeDefined();

		// Two partials for AVG (sum + count)
		const partials = Object.keys(result!.preaggCols).filter((k) => k.startsWith('__ps'));
		expect(partials).toHaveLength(2);

		// outputSelect.y is the recombined aggregate (no window wrapping)
		const outputY = result!.outputSelect.y.toString();
		expect(outputY).toMatch(/\//); // division for AVG decomposition

		// WindowNode keeps original field names (extra dims added to preagg table)
		const windowSQL = result!.windowChannels!.y.toString();
		expect(windowSQL).toMatch(/OVER/i);
		expect(windowSQL).toMatch(/"date"/); // ORDER BY uses original field name
	});

	it('handles window expression wrapping COUNT', () => {
		const result = rewriteForPreagg(
			selectDef({
				x: column('category'),
				y: windowExpr(count() as unknown as ExprNode, 'category')
			})
		);
		expect(result).not.toBeNull();
		expect(result!.windowChannels).not.toBeNull();

		// One partial for COUNT
		const partials = Object.keys(result!.preaggCols).filter((k) => k.startsWith('__ps'));
		expect(partials).toHaveLength(1);

		// Outer func should be SUM(y), not COUNT(y)
		const windowSQL = result!.windowChannels!.y.toString();
		expect(windowSQL).toMatch(/SUM\("y"\)/i);
		expect(windowSQL).not.toMatch(/COUNT\("y"\)/i);
	});

	it('handles window expression wrapping SUM', () => {
		const result = rewriteForPreagg(
			selectDef({
				x: column('date'),
				y: windowExpr(sum(column('amount')) as unknown as ExprNode, 'date')
			})
		);
		expect(result).not.toBeNull();
		expect(result!.windowChannels).not.toBeNull();

		const partials = Object.keys(result!.preaggCols).filter((k) => k.startsWith('__ps'));
		expect(partials).toHaveLength(1);

		// Outer func should be SUM(y) — SUM is idempotent
		const windowSQL = result!.windowChannels!.y.toString();
		expect(windowSQL).toMatch(/SUM\("y"\)/i);
	});

	it('returns null for window with WindowFunctionNode (RANK)', () => {
		const windowNode = rank().orderby(column('date'));
		const result = rewriteForPreagg(
			selectDef({
				x: column('date'),
				y: windowNode as unknown as ExprNode
			})
		);
		expect(result).toBeNull();
	});

	it('returns null for window with DISTINCT inner aggregate', () => {
		const distinctAvg = (avg(column('revenue')) as AggregateNode).distinct();
		const windowNode = windowExpr(distinctAvg as unknown as ExprNode, 'date');
		const result = rewriteForPreagg(
			selectDef({
				x: column('date'),
				y: windowNode
			})
		);
		expect(result).toBeNull();
	});

	it('handles mixed regular aggregate + window aggregate channels', () => {
		const result = rewriteForPreagg(
			selectDef({
				x: column('date'),
				y: count() as unknown as ExprNode,
				z: windowExpr(avg(column('revenue')), 'date')
			})
		);
		expect(result).not.toBeNull();
		// y is a regular aggregate, z is a window aggregate
		expect(result!.windowChannels).not.toBeNull();
		expect(result!.windowChannels!.z).toBeDefined();
		expect(result!.windowChannels!.y).toBeUndefined();

		// All partials present: 1 for count (y) + 2 for avg (z)
		const partials = Object.keys(result!.preaggCols).filter((k) => k.startsWith('__ps'));
		expect(partials).toHaveLength(3);
	});

	it('adds window-referenced columns as extra dimensions', () => {
		// Window orders by 'unknown_col' which is not in selectDef —
		// it gets added as an extra dimension in the preagg table
		const windowNode = (avg(column('revenue')) as any)
			.orderby(column('unknown_col'))
			.frame(frameRows([preceding(3), following(3)]));
		const result = rewriteForPreagg(
			selectDef({
				x: column('date'),
				y: windowNode
			})
		);
		expect(result).not.toBeNull();
		// 'unknown_col' added as extra dimension
		expect(result!.preaggCols.unknown_col).toBeDefined();
		expect(result!.outputSelect.unknown_col).toBeDefined();
	});

	it('returns null windowChannels when no window expressions', () => {
		const result = rewriteForPreagg(
			selectDef({
				x: column('category'),
				y: count() as unknown as ExprNode
			})
		);
		expect(result).not.toBeNull();
		expect(result!.windowChannels).toBeNull();
	});

	it('rewrites window col refs to channel aliases when passthroughChannels covers them', () => {
		// Window orders by 'date' AND partitions by 'region'. Both are covered
		// by passthrough channels (x→date, stroke→region), so they should NOT
		// be added as extra preagg dimensions, and the rewritten window node
		// should reference the channel aliases ("x", "stroke") instead.
		const windowNode = (avg(column('value')) as any)
			.partitionby(column('region'))
			.orderby(column('date'))
			.frame(frameRows([preceding(3), following(3)]));
		const result = rewriteForPreagg(
			selectDef({
				x: column('date'),
				stroke: column('region'),
				y: windowNode
			}),
			new Map([
				['x', 'date'],
				['stroke', 'region']
			])
		);
		expect(result).not.toBeNull();
		// No extra dims added — date and region were folded into x and stroke
		expect(result!.preaggCols.date).toBeUndefined();
		expect(result!.preaggCols.region).toBeUndefined();
		// Channel passthrough dims still present
		expect(result!.preaggCols.x).toBeDefined();
		expect(result!.preaggCols.stroke).toBeDefined();
		// Window def references channel aliases now, not raw column names
		const windowSQL = result!.windowChannels!.y.toString();
		expect(windowSQL).toMatch(/PARTITION BY "stroke"/i);
		expect(windowSQL).toMatch(/ORDER BY "x"/i);
		expect(windowSQL).not.toMatch(/PARTITION BY "region"/i);
		expect(windowSQL).not.toMatch(/ORDER BY "date"/i);
	});

	it('falls back to extra dims when passthroughChannels is missing', () => {
		// No passthroughChannels passed → current behavior (raw col extra dims)
		const result = rewriteForPreagg(
			selectDef({
				x: column('date'),
				y: windowExpr(avg(column('revenue')), 'date')
			})
		);
		expect(result).not.toBeNull();
		// 'date' added as extra dim (no fold-in possible without the map)
		expect(result!.preaggCols.date).toBeDefined();
		// Window def still references the raw column name
		const windowSQL = result!.windowChannels!.y.toString();
		expect(windowSQL).toMatch(/ORDER BY "date"/i);
	});

	it('mixes folded and unfolded window col refs', () => {
		// Window references 'date' (covered by x channel) and 'unknown_col'
		// (NOT covered). Expect 'date' folded to 'x' alias, 'unknown_col' added
		// as extra dim.
		const windowNode = (avg(column('value')) as any)
			.partitionby(column('unknown_col'))
			.orderby(column('date'))
			.frame(frameRows([preceding(3), following(3)]));
		const result = rewriteForPreagg(
			selectDef({
				x: column('date'),
				y: windowNode
			}),
			new Map([['x', 'date']])
		);
		expect(result).not.toBeNull();
		// 'date' folded — not in preaggCols
		expect(result!.preaggCols.date).toBeUndefined();
		// 'unknown_col' added as raw extra dim
		expect(result!.preaggCols.unknown_col).toBeDefined();
		const windowSQL = result!.windowChannels!.y.toString();
		expect(windowSQL).toMatch(/ORDER BY "x"/i);
		expect(windowSQL).toMatch(/PARTITION BY "unknown_col"/i);
	});
});

describe('rewriteForPreagg — verbatim window fragments', () => {
	// A verbatim fragment is not a WINDOW node, so it never reaches the window
	// branch, and mosaic's isAggregateExpression reports 0 for it — the same
	// value a plain column ref reports. Without a guard the pure-dimension
	// branch puts it in preaggGroupBy, producing GROUP BY over a window.
	// Bailing matches this function's documented contract.
	it('returns null rather than grouping by a verbatim window', () => {
		const result = rewriteForPreagg(
			selectDef({
				x: column('category'),
				y: sql`SUM(${column('v')}) OVER (PARTITION BY ${column('g')})` as unknown as ExprNode
			})
		);
		expect(result).toBeNull();
	});

	it('returns null for the stack transform shape (FILTER + OVER)', () => {
		const notNaN = sql`NOT isnan(${column('v')})`;
		const cumulative = sql`SUM(${column('v')}) FILTER (WHERE ${notNaN}) OVER (PARTITION BY ${column('g')} ORDER BY ${column('s')})`;
		const result = rewriteForPreagg(
			selectDef({
				x: column('category'),
				y1: cumulative as unknown as ExprNode
			})
		);
		expect(result).toBeNull();
	});

	it('returns null when the window is nested inside a wrapping fragment', () => {
		const cumulative = sql`SUM(${column('v')}) OVER (PARTITION BY ${column('g')})`;
		const wrapped = sql`CASE WHEN TRUE THEN ${cumulative} ELSE 'NaN'::REAL END`;
		const result = rewriteForPreagg(
			selectDef({ x: column('category'), y1: wrapped as unknown as ExprNode })
		);
		expect(result).toBeNull();
	});

	it('still accepts a verbatim fragment with no window as a dimension', () => {
		const result = rewriteForPreagg(
			selectDef({
				x: sql`${column('a')} + ${column('b')}` as unknown as ExprNode,
				y: sum(column('v'))
			})
		);
		expect(result).not.toBeNull();
		expect(result!.preaggGroupBy).toHaveLength(1);
	});

	it('still accepts structured window nodes', () => {
		const result = rewriteForPreagg(
			selectDef({
				x: column('date'),
				y: windowExpr(avg(column('revenue')), 'date')
			})
		);
		expect(result).not.toBeNull();
		expect(result!.windowChannels).not.toBeNull();
	});
});
