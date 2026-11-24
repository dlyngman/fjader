import { describe, it, expect } from 'vitest';
import { avg, column, count, sum } from '@uwdata/mosaic-sql';
import { resolveSortChannel } from './index';
import { buildChannelFieldMap } from './channel-field-map';

const desc = (axis: 'x' | 'y', channel: string) => ({ axis, channel, direction: 'desc' as const });

describe('resolveSortChannel', () => {
	// bar_x(x="importance", y="feature", sort={"y": "importance", "order": "desc"})
	const barX = buildChannelFieldMap({ x: 'importance', y: 'feature' });

	it('keeps a channel name', () => {
		expect(resolveSortChannel(desc('y', 'x'), barX)).toEqual({
			sort: desc('y', 'x'),
			problem: null
		});
	});

	it('resolves a column name to the channel that reads it', () => {
		expect(resolveSortChannel(desc('y', 'importance'), barX)).toEqual({
			sort: desc('y', 'x'),
			problem: null
		});
	});

	it('resolves the column inside an aggregate, and count by its name', () => {
		const fields = buildChannelFieldMap({
			x: column('feature'),
			y: sum('importance'),
			fill: column('group')
		});
		expect(resolveSortChannel(desc('x', 'importance'), fields).sort).toEqual(desc('x', 'y'));
		const counted = buildChannelFieldMap({ x: column('feature'), y: count() });
		expect(resolveSortChannel(desc('x', 'count'), counted).sort).toEqual(desc('x', 'y'));
	});

	it('prefers a value channel over the sorted axis', () => {
		// bar_x(x=sum("v"), y="v"): sorting y by v means by the summed x
		const fields = buildChannelFieldMap({ x: sum('v'), y: 'v' });
		expect(resolveSortChannel(desc('y', 'v'), fields, new Set(['y'])).sort).toEqual(desc('y', 'x'));
	});

	it('skips an ordinal colour reading the same column, for the axis itself', () => {
		// fill="feature" is an ordinal colour: categorical, so y itself is used
		const fields = buildChannelFieldMap({ x: 'importance', y: 'feature', fill: 'feature' });
		expect(resolveSortChannel(desc('y', 'feature'), fields, new Set(['y', 'fill'])).sort).toEqual(
			desc('y', 'y')
		);
	});

	it("falls back to the axis's own channel (sorting categories by themselves)", () => {
		expect(resolveSortChannel(desc('y', 'feature'), barX).sort).toEqual(desc('y', 'y'));
	});

	it('keeps an extent channel name the rank transform resolves (x → x2)', () => {
		const rect = buildChannelFieldMap({ x1: 'start', x2: 'end', y: 'feature' });
		expect(resolveSortChannel(desc('y', 'x'), rect)).toEqual({
			sort: desc('y', 'x'),
			problem: null
		});
	});

	it('flags a name that is neither a channel nor a column, unchanged', () => {
		expect(resolveSortChannel(desc('y', 'nope'), barX)).toEqual({
			sort: desc('y', 'nope'),
			problem: 'unknown'
		});
	});

	it('never resolves a column to a categorical channel', () => {
		// bar_y(x="feature", y=count(), fill="group", sort={"x": "group"}): fill
		// carries category ids, so summing it per band would rank nothing
		const fields = buildChannelFieldMap({ x: 'feature', y: count(), fill: 'group' });
		expect(resolveSortChannel(desc('x', 'group'), fields, new Set(['x', 'fill']))).toEqual({
			sort: desc('x', 'group'),
			problem: 'categorical'
		});
		// a value channel reading the same column is chosen over it
		const both = buildChannelFieldMap({ x: 'feature', y: sum('v'), fill: 'v' });
		expect(resolveSortChannel(desc('x', 'v'), both, new Set(['x', 'fill'])).sort).toEqual(
			desc('x', 'y')
		);
	});

	it('takes the first value channel in select order when several read the column', () => {
		const fields = buildChannelFieldMap({ x: 'feature', y: sum('v'), r: avg('v') });
		expect(resolveSortChannel(desc('x', 'v'), fields).sort).toEqual(desc('x', 'y'));
	});

	it('passes no sort through', () => {
		expect(resolveSortChannel(null, barX)).toEqual({ sort: null, problem: null });
	});
});
