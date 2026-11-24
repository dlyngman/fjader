import { describe, it, expect } from 'vitest';
import { column, count, sum } from '@uwdata/mosaic-sql';
import { resolveSortChannel } from './index';
import { buildChannelFieldMap } from './channel-field-map';

const desc = (axis: 'x' | 'y', channel: string) => ({ axis, channel, direction: 'desc' as const });

describe('resolveSortChannel', () => {
	// bar_x(x="importance", y="feature", sort={"y": "importance", "order": "desc"})
	const barX = buildChannelFieldMap({ x: 'importance', y: 'feature' });

	it('keeps a channel name', () => {
		expect(resolveSortChannel(desc('y', 'x'), barX)).toEqual({
			sort: desc('y', 'x'),
			unresolved: false
		});
	});

	it('resolves a column name to the channel that reads it', () => {
		expect(resolveSortChannel(desc('y', 'importance'), barX)).toEqual({
			sort: desc('y', 'x'),
			unresolved: false
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

	it('prefers a channel other than the sorted axis', () => {
		// fill and y both read 'feature'; sorting y by it means by fill
		const fields = buildChannelFieldMap({ x: 'importance', y: 'feature', fill: 'feature' });
		expect(resolveSortChannel(desc('y', 'feature'), fields).sort).toEqual(desc('y', 'fill'));
	});

	it("falls back to the axis's own channel (sorting categories by themselves)", () => {
		expect(resolveSortChannel(desc('y', 'feature'), barX).sort).toEqual(desc('y', 'y'));
	});

	it('keeps an extent channel name the rank transform resolves (x → x2)', () => {
		const rect = buildChannelFieldMap({ x1: 'start', x2: 'end', y: 'feature' });
		expect(resolveSortChannel(desc('y', 'x'), rect)).toEqual({
			sort: desc('y', 'x'),
			unresolved: false
		});
	});

	it('flags a name that is neither a channel nor a column, unchanged', () => {
		expect(resolveSortChannel(desc('y', 'nope'), barX)).toEqual({
			sort: desc('y', 'nope'),
			unresolved: true
		});
	});

	it('passes no sort through', () => {
		expect(resolveSortChannel(null, barX)).toEqual({ sort: null, unresolved: false });
	});
});
