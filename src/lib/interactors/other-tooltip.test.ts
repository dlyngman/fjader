import { describe, it, expect } from 'vitest';
import { otherTooltipRows } from './other-tooltip';

const fmt = (v: number) => v.toLocaleString('en-US');
const stats = { picked: 1234, total: 5678, pickedCount: 3, memberCount: 41, active: true };

describe('otherTooltipRows', () => {
	it('always says how many categories Other holds', () => {
		expect(otherTooltipRows({ ...stats, active: false }, fmt)).toEqual([
			{ key: 'categories', value: '41' }
		]);
	});

	it('says how much of it is selected while a selection is active', () => {
		expect(otherTooltipRows(stats, fmt)).toEqual([
			{ key: 'categories', value: '3 of 41' },
			{ key: 'selected', value: '1,234 of 5,678 (22%)' }
		]);
	});

	it('reads a sliver as <1% and nothing as 0%', () => {
		expect(otherTooltipRows({ ...stats, picked: 3 }, fmt)[1].value).toBe('3 of 5,678 (<1%)');
		expect(otherTooltipRows({ ...stats, picked: 0, pickedCount: 0 }, fmt)[1].value).toBe(
			'0 of 5,678 (0%)'
		);
	});

	it('does not divide by a total of 0', () => {
		expect(otherTooltipRows({ ...stats, picked: 0, total: 0 }, fmt)[1].value).toBe('0 of 0 (0%)');
	});
});
