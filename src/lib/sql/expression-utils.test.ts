import { describe, it, expect } from 'vitest';
import {
	column,
	sum,
	avg,
	sql,
	frameRows,
	preceding,
	following,
	isAggregateExpression,
	type ExprNode
} from '@uwdata/mosaic-sql';
import { isWindowExpression, isVerbatimWindowExpression } from './expression-utils';

// A structured window node, the shape the query engine can analyze.
// Matches the helper in sufficient-statistics.test.ts.
function windowExpr(agg: ExprNode, orderCol: string): ExprNode {
	return (agg as unknown as { orderby: (c: unknown) => { frame: (f: unknown) => ExprNode } })
		.orderby(column(orderCol))
		.frame(frameRows([preceding(3), following(3)]));
}

describe('isWindowExpression', () => {
	it('is true for a structured window node', () => {
		expect(isWindowExpression(windowExpr(sum(column('v')), 'date'))).toBe(true);
	});

	it('is false for plain columns and aggregates', () => {
		expect(isWindowExpression(column('species'))).toBe(false);
		expect(isWindowExpression(sum(column('v')))).toBe(false);
	});

	it('is false for a verbatim fragment containing a window', () => {
		// The gap this whole module exists to close: a tagged fragment is not a
		// WINDOW node, so type-based detection cannot see the window inside it.
		expect(isWindowExpression(sql`SUM(${column('v')}) OVER (PARTITION BY ${column('g')})`)).toBe(
			false
		);
	});
});

describe('isVerbatimWindowExpression', () => {
	it('detects a window inside a verbatim fragment', () => {
		const frag = sql`SUM(${column('v')}) OVER (PARTITION BY ${column('g')})`;
		expect(isVerbatimWindowExpression(frag)).toBe(true);
	});

	it('detects a window inside a FILTER + OVER fragment (the stack transform shape)', () => {
		const notNaN = sql`NOT isnan(${column('v')})`;
		const frag = sql`SUM(${column('v')}) FILTER (WHERE ${notNaN}) OVER (PARTITION BY ${column('g')} ORDER BY ${column('s')})`;
		expect(isVerbatimWindowExpression(frag)).toBe(true);
	});

	it('detects a window nested inside a wrapping fragment', () => {
		const cumulative = sql`SUM(${column('v')}) OVER (PARTITION BY ${column('g')})`;
		const wrapped = sql`CASE WHEN TRUE THEN ${cumulative} ELSE 'NaN'::REAL END`;
		expect(isVerbatimWindowExpression(wrapped)).toBe(true);
	});

	it('is false for verbatim fragments with no window', () => {
		expect(isVerbatimWindowExpression(sql`${column('a')} + ${column('b')}`)).toBe(false);
		expect(isVerbatimWindowExpression(sql`SUM(${column('v')})`)).toBe(false);
		expect(isVerbatimWindowExpression(sql`CASE WHEN ${column('a')} > 0 THEN 1 ELSE 0 END`)).toBe(
			false
		);
	});

	it('is false for structured nodes, including real window nodes', () => {
		// Structured windows have their own branch upstream; this predicate is
		// only about fragments the analyzer cannot see into.
		expect(isVerbatimWindowExpression(windowExpr(avg(column('v')), 'date'))).toBe(false);
		expect(isVerbatimWindowExpression(column('species'))).toBe(false);
		expect(isVerbatimWindowExpression(sum(column('v')))).toBe(false);
	});

	it('is false for non-nodes', () => {
		expect(isVerbatimWindowExpression(null)).toBe(false);
		expect(isVerbatimWindowExpression(undefined)).toBe(false);
		expect(isVerbatimWindowExpression('SUM(x) OVER ()')).toBe(false);
		expect(isVerbatimWindowExpression(42)).toBe(false);
	});

	it('ignores window text that only appears inside a scalar subquery', () => {
		// Mirrors mosaic's walker, which strips subquery content before testing.
		const frag = sql`${column('a')} + (SELECT SUM(x) OVER (PARTITION BY y) FROM t)`;
		expect(isVerbatimWindowExpression(frag)).toBe(false);
	});
});

describe('the conflation this guard exists to break', () => {
	it('mosaic reports the same aggregate flag for a plain column and a verbatim window', () => {
		// This is the whole problem: 0 means both "provably a dimension" and
		// "stopped early on something I do not understand". Callers that read 0
		// as "pure dimension" put a window into GROUP BY.
		const plain = column('species');
		const verbatimWindow = sql`SUM(${column('v')}) OVER (PARTITION BY ${column('g')})`;

		expect(isAggregateExpression(plain as ExprNode)).toBe(0);
		expect(isAggregateExpression(verbatimWindow as unknown as ExprNode)).toBe(0);

		// The new predicate is what separates them.
		expect(isVerbatimWindowExpression(plain)).toBe(false);
		expect(isVerbatimWindowExpression(verbatimWindow)).toBe(true);
	});
});
