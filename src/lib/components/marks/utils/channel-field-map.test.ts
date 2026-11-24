import { describe, it, expect } from 'vitest';
import { avg, column, count } from '@uwdata/mosaic-sql';
import { resolveTip } from './channel-field-map';

const SELECT = { x: column('month_start'), y: avg('v'), fill: column('region') };

describe('resolveTip', () => {
	it('shows a labeled plain column under its label, fetched as an extra column', () => {
		const tip = resolveTip([{ value: 'site', label: 'Site' }] as never, SELECT);
		expect(tip.extraSelect).toEqual({ site: 'site' });
		expect(tip.displayFields).toEqual(['site']);
		expect(tip.displayLabels).toEqual({ site: 'Site' });
	});

	it('shows a labeled channel column under its label, without fetching it again', () => {
		const tip = resolveTip([{ value: 'month_start', label: 'Month' }] as never, SELECT);
		expect(tip.extraSelect).toEqual({});
		expect(tip.displayFields).toEqual(['month_start']);
		expect(tip.displayLabels).toEqual({ month_start: 'Month' });
	});

	it('resolves a labeled channel name to its field', () => {
		const tip = resolveTip([{ value: 'fill', label: 'Region' }] as never, SELECT);
		expect(tip.extraSelect).toEqual({});
		expect(tip.displayFields).toEqual(['region']);
		expect(tip.displayLabels).toEqual({ region: 'Region' });
	});

	it('keeps a labeled expression tooltip-only, under its label', () => {
		const tip = resolveTip([{ value: count(), label: 'N' }] as never, SELECT);
		expect(tip.extraSelect).toEqual({});
		expect(tip.displayFields).toEqual(['N']);
		expect(tip.displayLabels).toBeNull();
	});

	it('resolves unlabeled entries as before, with no labels', () => {
		const tip = resolveTip(['x', 'site', count()] as never, SELECT);
		expect(tip.extraSelect).toEqual({ site: 'site' });
		expect(tip.displayFields).toEqual(['month_start', 'site', 'count()']);
		expect(tip.displayLabels).toBeNull();
	});
});
