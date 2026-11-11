import { describe, it, expect } from 'vitest';
import { FieldActivity, type FieldActivityHost } from './FieldActivity.svelte';
import { FieldIdentity } from './categorical-identity';
import { FilterGroup } from './FilterGroup.svelte';

/**
 * A click on an Other bucket selects what it holds: the members its marks
 * registered, as values. The same Other clicked again takes them back, unless
 * every mark under it is filtered by the selection, where it drills down.
 */

/** a, b, c, d, NULL (4), and the Other bucket (5). */
function identity(): FieldIdentity {
	const id = new FieldIdentity([], 'f');
	id.reset(['a', 'b', 'c', 'd', null, 'Other'], [5]);
	return id;
}

function host(fi: FieldIdentity): FieldActivityHost {
	return {
		loop: null,
		chartsFor: (_key: string, out: string[]) => out,
		identityOf: () => fi
	} as unknown as FieldActivityHost;
}

const OTHER = 5;

describe('FieldActivity.otherClick', () => {
	const make = () => {
		const activity = new FieldActivity('f', host(identity()));
		activity.setOther(OTHER, 'bar', { group: 0, rows: [{ facetId: null, ids: [2, 3, 4] }] });
		return activity;
	};
	const none = new Set<unknown>();

	it('selects the members as values, the NULL category among them', () => {
		const click = make().otherClick(0, OTHER, null, none, false)!;
		expect(click.action).toBe('replace');
		expect(new Set(click.values)).toEqual(new Set(['c', 'd', null]));
	});

	it('takes them back on a second plain click, while they are still selected', () => {
		const activity = make();
		activity.otherClick(0, OTHER, null, none, false);
		const again = activity.otherClick(0, OTHER, null, new Set(['c', 'd', null]), false)!;
		expect(again.action).toBe('remove');
		expect(new Set(again.values)).toEqual(new Set(['c', 'd', null]));
	});

	it('selects afresh when the selection has moved on since', () => {
		const activity = make();
		activity.otherClick(0, OTHER, null, none, false);
		// A legend click elsewhere replaced the selection with 'a'.
		const again = activity.otherClick(0, OTHER, null, new Set(['a']), false)!;
		expect(again.action).toBe('replace');
	});

	it('adds on shift-click, and a second shift-click takes back only what it added', () => {
		const activity = make();
		const add = activity.otherClick(0, OTHER, null, new Set(['a']), true)!;
		expect(add.action).toBe('add');
		const back = activity.otherClick(0, OTHER, null, new Set(['a', 'c', 'd', null]), true)!;
		expect(back.action).toBe('remove');
		expect(back.values).not.toContain('a');
	});

	it('drills down when every mark under it is filtered by the selection', () => {
		const activity = new FieldActivity('f', host(identity()));
		activity.setOther(OTHER, 'bar', { group: null, rows: [{ facetId: null, ids: [2, 3, 4] }] });
		activity.otherClick(0, OTHER, null, none, false);
		// The chart re-ranked within the selection: its Other now holds the rest.
		activity.setOther(OTHER, 'bar', { group: null, rows: [{ facetId: null, ids: [4] }] });
		const deeper = activity.otherClick(0, OTHER, null, new Set(['c', 'd', null]), false)!;
		expect(deeper).toEqual({ action: 'replace', values: [null] });
	});

	it("reads only the clicked facet cell's members", () => {
		const activity = new FieldActivity('f', host(identity()));
		activity.setOther(OTHER, 'bar', {
			group: 0,
			rows: [
				{ facetId: 0, ids: [2] },
				{ facetId: 1, ids: [3] }
			]
		});
		expect(activity.otherClick(0, OTHER, 1, none, false)!.values).toEqual(['d']);
		// A band label is no cell: every row.
		expect(new Set(activity.otherClick(0, OTHER, null, none, false)!.values)).toEqual(
			new Set(['c', 'd'])
		);
	});

	it('never selects a synthetic id, and does nothing before any result', () => {
		const activity = new FieldActivity('f', host(identity()));
		expect(activity.otherClick(0, OTHER, null, none, false)).toBeNull();
		activity.setOther(OTHER, 'bar', { group: 0, rows: [{ facetId: null, ids: [5, 1] }] });
		expect(activity.otherClick(0, OTHER, null, none, false)!.values).toEqual(['b']);
	});

	it('forgets what it added once the id has no rows left, so a reused id starts afresh', () => {
		const activity = make();
		activity.otherClick(0, OTHER, null, none, false);
		activity.setOther(OTHER, 'bar', null);
		activity.setOther(OTHER, 'other-chart', {
			group: 0,
			rows: [{ facetId: null, ids: [2, 3, 4] }]
		});
		// Still selected, but this is a new holder of the id: a fresh select.
		const click = activity.otherClick(0, OTHER, null, new Set(['c', 'd', null]), false)!;
		expect(click.action).toBe('replace');
	});
});

describe('ToggleHandle.toggleOther', () => {
	it("writes the members into the toggle's clause, and takes them back", () => {
		const activity = new FieldActivity('f', host(identity()));
		const group = new FilterGroup(0, () => activity);
		activity.setOther(OTHER, 'bar', { group: 0, rows: [{ facetId: null, ids: [2, 3, 4] }] });
		const toggle = group.registerToggle('f');

		toggle.toggleOther(OTHER, null, false);
		expect(new Set(toggle.values)).toEqual(new Set(['c', 'd', null]));
		// Its predicate selects NULL with IS NOT DISTINCT FROM, beside the IN list.
		const predicate = String(group.selection.items[0].predicate);
		expect(predicate).toContain(`IN ('c', 'd')`);
		expect(predicate).toContain('IS NOT DISTINCT FROM NULL');

		toggle.toggleOther(OTHER, null, false);
		expect(toggle.active).toBe(false);
	});

	it('keeps a value picked before when shift-clicking Other', () => {
		const activity = new FieldActivity('f', host(identity()));
		const group = new FilterGroup(0, () => activity);
		activity.setOther(OTHER, 'bar', { group: 0, rows: [{ facetId: null, ids: [2, 3] }] });
		const toggle = group.registerToggle('f');
		toggle.toggle(['a'], false);
		toggle.toggleOther(OTHER, null, true);
		expect(new Set(toggle.values)).toEqual(new Set(['a', 'c', 'd']));
		toggle.toggleOther(OTHER, null, true);
		expect(new Set(toggle.values)).toEqual(new Set(['a']));
	});
});

describe('FieldActivity: an Other bucket is lit while the selection reaches into it', () => {
	const fade = (activity: FieldActivity, id: number) =>
		(activity.fadeOf(0) as { activityOf(id: number): number }).activityOf(id);

	it('lights the bucket when a member is selected, and dims it when none is', () => {
		const activity = new FieldActivity('f', host(identity()));
		activity.setOther(OTHER, 'bar', { group: 0, rows: [{ facetId: null, ids: [2, 3] }] });
		activity.set(0, new Set(['c']));
		expect(fade(activity, OTHER)).toBe(1);
		expect(fade(activity, 0)).toBe(0);
		activity.set(0, new Set(['a']));
		expect(fade(activity, OTHER)).toBe(0);
		activity.set(0, null);
		expect(fade(activity, OTHER)).toBe(1);
	});

	it("is not lit by a mark that is filtered by the selection ('filter')", () => {
		const activity = new FieldActivity('f', host(identity()));
		activity.setOther(OTHER, 'bar', { group: null, rows: [{ facetId: null, ids: [2, 3] }] });
		activity.set(0, new Set(['c']));
		expect(fade(activity, OTHER)).toBe(0);
	});

	it('follows a new result: the same selection lights it once the bucket holds a member', () => {
		const activity = new FieldActivity('f', host(identity()));
		activity.setOther(OTHER, 'bar', { group: 0, rows: [{ facetId: null, ids: [2, 3] }] });
		activity.set(0, new Set(['a']));
		expect(fade(activity, OTHER)).toBe(0);
		// A brush elsewhere re-ranked the chart: 'a' now falls into Other.
		activity.setOther(OTHER, 'bar', { group: 0, rows: [{ facetId: null, ids: [0, 3] }] });
		expect(fade(activity, OTHER)).toBe(1);
		// The bucket goes: nothing lights it.
		activity.setOther(OTHER, 'bar', null);
		expect(fade(activity, OTHER)).toBe(0);
	});

	it('leaves no stale mark between updates', () => {
		const activity = new FieldActivity('f', host(identity()));
		activity.setOther(OTHER, 'bar', { group: 0, rows: [{ facetId: null, ids: [2] }] });
		activity.set(0, new Set(['c']));
		expect(fade(activity, OTHER)).toBe(1);
		// 'c' is no longer selected; a mask left set at id 2 would keep Other lit.
		activity.set(0, new Set(['a']));
		expect(fade(activity, OTHER)).toBe(0);
	});
});
