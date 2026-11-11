import { describe, it, expect } from 'vitest';
import { sum } from '@uwdata/mosaic-sql';
import { OTHER_IDS_COLUMN, OTHER_VALUES_COLUMN } from '$lib/transforms';
import { OtherRows, type SplitPlan } from './other-rows.svelte';

const col = (values: unknown[]) => ({ at: (row: number) => values[row] });

/** Shown rows 0 and 1, then two Other rows (facet cells 0 and 1) holding b, c, d (ids 1 to 3) and b, c. */
const decode = ['a', 'b', 'c', 'd'];
const columns: Record<string, unknown> = {
	x: col([0, 1, 9, 9]),
	__facet: col([0, 0, 0, 1]),
	[OTHER_IDS_COLUMN]: col([null, null, Int32Array.from([1, 2, 3]), Int32Array.from([1, 2])]),
	[OTHER_VALUES_COLUMN]: col([
		null,
		null,
		Float64Array.from([10, 20, 30]),
		Float64Array.from([5, 5])
	])
};

function make(selected: Set<unknown> | null, plan: Partial<SplitPlan> = {}) {
	const table = {
		numRows: 4,
		getChild: (name: string) => columns[name] ?? null
	};
	return new OtherRows({
		queryEngine: { identityFor: () => ({ values: decode }) },
		filterGroup: { index: 0, activity: () => ({ selectedValues: () => selected }) },
		markId: 'bar-test',
		table: () => table as never,
		dataVersion: () => 1,
		identity: () => ({ x: { otherId: 9 } }) as never,
		identityKey: () => 'species',
		filtered: () => false,
		plan: () => ({
			markType: 'bary',
			length: 'y',
			by: null,
			expr: sum('v'),
			hasOther: true,
			hasJsTransforms: false,
			...plan
		}),
		colorKey: () => null,
		bandScaleKey: () => null
	} as never);
}

describe('OtherRows.statsAt', () => {
	it('finds the Other row a tooltip point names, by band id and facet cell', () => {
		const rows = make(new Set(['b', 'c']));
		expect(rows.statsAt(9, 0)).toEqual({
			picked: 30,
			total: 60,
			pickedCount: 2,
			memberCount: 3,
			active: true
		});
		expect(rows.statsAt(9, 1)).toMatchObject({
			picked: 10,
			total: 10,
			pickedCount: 2,
			memberCount: 2
		});
	});

	it('takes the first Other row when the point names no facet', () => {
		expect(make(null).statsAt(9, null)).toMatchObject({ total: 60, memberCount: 3, active: false });
	});

	it('has none for a row that is not an Other, or a facet cell without one', () => {
		const rows = make(new Set(['a']));
		expect(rows.statsAt(0, 0)).toBeNull();
		expect(rows.statsAt(9, 7)).toBeNull();
	});

	it('has none where the bar does not split', () => {
		expect(make(null, { hasJsTransforms: true }).statsAt(9, 0)).toBeNull();
		expect(make(null, { markType: 'dots' }).statsAt(9, 0)).toBeNull();
	});
});
