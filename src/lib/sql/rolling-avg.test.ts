import { describe, it, expect } from 'vitest';
import { RollingAvgNode, isRollingAvgExpression } from './rolling-avg';

// The window size and mode may be getters, read each time the expression is
// built. That is what lets shift+scroll re-query a mark instead of recreating
// it: the node stays the same object while its parameters move.

describe('RollingAvgNode', () => {
	it('frames a centered window of the size it is given', () => {
		const node = new RollingAvgNode('value', 'day', null, 2);
		expect(node.windowSize).toBe(2);
		expect(node.resolve().toString()).toContain('ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING');
	});

	it('reads a getter each time it resolves', () => {
		let window = 1;
		let mode: 'centered' | 'trailing' = 'centered';
		const node = new RollingAvgNode(
			'value',
			'day',
			null,
			() => window,
			() => mode
		);
		expect(node.resolve().toString()).toContain('1 PRECEDING AND 1 FOLLOWING');

		window = 4;
		mode = 'trailing';
		expect(node.windowSize).toBe(4);
		expect(node.mode).toBe('trailing');
		expect(node.resolve().toString()).toContain('ROWS BETWEEN 4 PRECEDING AND CURRENT ROW');
	});

	it('partitions by the series field when there is one', () => {
		const node = new RollingAvgNode('value', 'day', 'region', 1);
		const sql = node.resolve().toString();
		expect(sql).toContain('PARTITION BY "region"');
		expect(sql).toContain('ORDER BY "day"');
		expect(isRollingAvgExpression(node)).toBe(true);
	});
});
