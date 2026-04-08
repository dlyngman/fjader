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
	type ExprNode,
	type AggregateNode
} from '@uwdata/mosaic-sql';
import { rewriteForPreagg, buildBinExpr } from './sufficient-statistics';

// Helper: build a selectDef with the given channel→expression mapping
function selectDef(entries: Record<string, ExprNode>): Record<string, unknown> {
	return entries as Record<string, unknown>;
}

describe('rewriteForPreagg', () => {
	it('handles pure dimension (no aggregates)', () => {
		const result = rewriteForPreagg(selectDef({ x: column('category') }));
		expect(result).not.toBeNull();
		expect(result!.cubeGroupBy).toHaveLength(1);
		// Dimension goes into cube as-is
		expect(Object.keys(result!.cubeCols)).toContain('x');
		// Output references the cube column
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
		const partials = Object.keys(result!.cubeCols).filter((k) => k.startsWith('__ps'));
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
		const partials = Object.keys(result!.cubeCols).filter((k) => k.startsWith('__ps'));
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
		const partials = Object.keys(result!.cubeCols).filter((k) => k.startsWith('__ps'));
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
		const partials = Object.keys(result!.cubeCols).filter((k) => k.startsWith('__ps'));
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
		const partials = Object.keys(result!.cubeCols).filter((k) => k.startsWith('__ps'));
		expect(partials).toHaveLength(1);
	});
});

describe('buildBinExpr', () => {
	it('produces a CAST(FLOOR(...) AS INTEGER) expression', () => {
		const { expr, d0, scaleFactor } = buildBinExpr(column('price'), [0, 100], 800);
		const sql = expr.toString();
		expect(sql).toMatch(/FLOOR/i);
		expect(sql).toMatch(/INTEGER/i);
		expect(d0).toBe(0);
		expect(scaleFactor).toBe(8); // 800 / 100
	});

	it('handles non-zero domain start', () => {
		const { d0, scaleFactor } = buildBinExpr(column('price'), [50, 150], 800);
		expect(d0).toBe(50);
		expect(scaleFactor).toBe(8); // 800 / 100
	});
});
