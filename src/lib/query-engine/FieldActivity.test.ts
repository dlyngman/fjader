import { describe, it, expect } from 'vitest';
import { FieldActivity, type FieldActivityHost } from './FieldActivity.svelte';
import { FieldIdentity } from './categorical-identity';
import { DEFAULT_INACTIVE_OPACITY, type ActivityTable } from '$lib/scales/ActivityTable';

/**
 * A field's selection activity, per filter group: the cases #9 pinned on the
 * scales (selection before identity, reload, growth), now on the field.
 */

const loop = { addAnimatedSource: () => {}, removeAnimatedSource: () => {} };

/** A host whose live identity the test swaps, as the engine's reset does. */
function hostWith(identity: FieldIdentity | null, withLoop = false) {
	const host = {
		identity,
		loop: withLoop ? loop : null,
		chartsFor: (_key: string, out: string[]) => {
			out.push('chart-1');
			return out;
		},
		identityOf: () => host.identity
	};
	return host as FieldActivityHost & { identity: FieldIdentity | null };
}

const table = (activity: FieldActivity, group = 0) => activity.fadeOf(group) as ActivityTable;
/** Each id's activity now: the free slot past them is left out (see its own tests). */
const now = (activity: FieldActivity, group = 0) =>
	Array.from({ length: table(activity, group).count - 1 }, (_, id) =>
		table(activity, group).activityOf(id)
	);
/** A table's from or to, without the free slot. */
const ids = (array: Float32Array) => Array.from(array).slice(0, -1);
const values = (...v: string[]) => new Set<unknown>(v);

describe('FieldActivity', () => {
	it('covers every id, all active, with nothing selected', () => {
		const activity = new FieldActivity('f', hostWith(new FieldIdentity(['a', 'b', 'c'], 'f')));
		activity.set(0, null);
		expect(now(activity)).toEqual([1, 1, 1]);
	});

	it('dims the ids of unselected values, and several stay selected together', () => {
		const activity = new FieldActivity('f', hostWith(new FieldIdentity(['a', 'b', 'c'], 'f')));
		activity.set(0, values('a', 'c'));
		expect(now(activity)).toEqual([1, 0, 1]);
	});

	it('maps values through identity and ignores values the dim does not hold', () => {
		const activity = new FieldActivity('f', hostWith(new FieldIdentity(['c', 'b', 'a'], 'f')));
		activity.set(0, values('a', 'zzz'));
		expect(now(activity)).toEqual([0, 0, 1]);
	});

	it('restores every id on clear', () => {
		const activity = new FieldActivity('f', hostWith(new FieldIdentity(['a', 'b', 'c'], 'f')));
		activity.set(0, values('b'));
		activity.set(0, null);
		expect(now(activity)).toEqual([1, 1, 1]);
	});

	it('keeps groups apart: a selection in one group dims nothing in another', () => {
		const activity = new FieldActivity('f', hostWith(new FieldIdentity(['a', 'b', 'c'], 'f')));
		activity.set(1, values('a'));
		activity.set(0, null);
		expect(now(activity, 1)).toEqual([1, 0, 0]);
		expect(now(activity, 0)).toEqual([1, 1, 1]);
		expect(activity.opacityOfValue(0, 'b')).toBe(1);
		expect(activity.opacityOfValue(2, 'b')).toBe(1);
	});

	it('applies a selection made before identity landed, without fading it in', () => {
		const host = hostWith(null, true);
		const activity = new FieldActivity('f', host);
		activity.set(0, values('b'));
		expect(table(activity).count).toBe(0);

		host.identity = new FieldIdentity(['a', 'b', 'c'], 'f');
		expect(activity.reconcile()).toBe(true);
		expect(ids(table(activity).from)).toEqual([0, 1, 0]);
		expect(ids(table(activity).to)).toEqual([0, 1, 0]);
	});

	it('reconciles to nothing when nothing moved', () => {
		const activity = new FieldActivity('f', hostWith(new FieldIdentity(['a', 'b'], 'f')));
		activity.set(0, values('a'));
		const version = table(activity).version;
		expect(activity.reconcile()).toBe(false);
		expect(table(activity).version).toBe(version);
	});

	it('drops per-id activity when a reload empties the identity', () => {
		const identity = new FieldIdentity(['a', 'b', 'c'], 'f');
		const host = hostWith(identity);
		const activity = new FieldActivity('f', host);
		activity.set(0, values('c'));

		// The engine's reset empties the identity in place and forgets it.
		identity.reset([]);
		host.identity = null;
		activity.reconcile();
		expect(activity.count).toBe(0);
		expect(table(activity).count).toBe(0);
		// Readers fall back to the values alone.
		expect(activity.opacityOfValue(0, 'a')).toBe(DEFAULT_INACTIVE_OPACITY);
		expect(activity.opacityOfValue(0, 'c')).toBe(1);
	});

	it('snaps to the new ids after a reload renumbers the dim, rather than fading from the old ones', () => {
		const host = hostWith(new FieldIdentity(['a', 'b', 'c'], 'f'), true);
		const activity = new FieldActivity('f', host);
		activity.set(0, values('a'));
		table(activity).clock._markAtRest();
		expect(now(activity)).toEqual([1, 0, 0]);

		host.identity = new FieldIdentity(['c', 'b', 'a'], 'f');
		activity.reconcile();
		expect(ids(table(activity).from)).toEqual([0, 0, 1]);
		expect(ids(table(activity).to)).toEqual([0, 0, 1]);
	});

	it('keeps existing fades when the dim grows, and a new id starts in its state', () => {
		const identity = new FieldIdentity(['a', 'b'], 'f');
		const activity = new FieldActivity('f', hostWith(identity, true));
		activity.set(0, values('a'));
		// Mid-fade: b is on its way out.
		expect(table(activity).clock.running).toBe(true);

		identity.reset(['a', 'b', 'c']);
		activity.reconcile();
		// Three ids and the free slot past them.
		expect(table(activity).count).toBe(4);
		expect(ids(table(activity).from)).toEqual([1, 1, 0]);
		expect(ids(table(activity).to)).toEqual([1, 0, 0]);
		// The free slot's own fade (1 -> 0: something is now selected) moved to the
		// new end; 'c' did not inherit it.
		expect(table(activity).from[3]).toBe(1);
		expect(table(activity).to[3]).toBe(0);
	});

	it('gives a reader the inactive opacity at rest, and a fade in between', () => {
		const activity = new FieldActivity('f', hostWith(new FieldIdentity(['a', 'b'], 'f'), true));
		expect(activity.opacityOfValue(0, 'b')).toBe(1);
		activity.set(0, values('a'));
		const clock = table(activity).clock;
		for (let i = 0; i < 20; i++) {
			clock.step();
			clock.updateRenderState(0);
		}
		const midway = activity.opacityOfValue(0, 'b');
		expect(midway).toBeLessThan(1);
		expect(midway).toBeGreaterThan(DEFAULT_INACTIVE_OPACITY);
		expect(activity.opacityOfValue(0, 'a')).toBe(1);
		clock._markAtRest();
		expect(activity.opacityOfValue(0, 'b')).toBeCloseTo(DEFAULT_INACTIVE_OPACITY, 6);
	});

	it('a reader never reconciles, and does not trust a table from an identity no longer live', () => {
		const host = hostWith(new FieldIdentity(['a', 'b', 'c'], 'f'));
		const activity = new FieldActivity('f', host);
		activity.set(0, values('a'));
		const version = table(activity).version;

		// A reload renumbered the dim, and nothing has reconciled yet.
		host.identity = new FieldIdentity(['c', 'b', 'a'], 'f');
		expect(activity.opacityOfValue(0, 'a')).toBe(1);
		expect(activity.opacityOfValue(0, 'c')).toBe(DEFAULT_INACTIVE_OPACITY);
		expect(table(activity).version).toBe(version);
	});

	it('names the charts drawing the field to the fade clock', () => {
		const activity = new FieldActivity('f', hostWith(new FieldIdentity(['a'], 'f')));
		activity.set(0, values('a'));
		expect(table(activity).clock._affectedChartsArray).toEqual(['chart-1']);
	});

	describe('opacityOfId', () => {
		/** a, b, then an Other bucket (id 2) labelled 'Other'. */
		const withBucket = () => new FieldIdentity(['a', 'b', 'Other'], 'f');
		// Built through reset, as #refreshValues does, so the bucket is flagged.
		const identity = () => {
			const i = withBucket();
			i.reset(['a', 'b', 'Other'], [2]);
			return i;
		};

		it('reads the fade at the id, as opacityOfValue does at the value', () => {
			const activity = new FieldActivity('f', hostWith(identity()));
			activity.set(0, values('a'));
			expect(activity.opacityOfId(0, 0)).toBe(1);
			expect(activity.opacityOfId(0, 1)).toBe(DEFAULT_INACTIVE_OPACITY);
			expect(activity.opacityOfId(0, 1)).toBe(activity.opacityOfValue(0, 'b'));
		});

		it('reaches an Other bucket, which no value names', () => {
			const id = identity();
			expect(id.ids.has('Other')).toBe(false);
			const activity = new FieldActivity('f', hostWith(id));
			activity.set(0, values('a'));
			// The bucket's fade is read at its id. By value it falls back to the
			// selected set, where its label never is.
			expect(activity.opacityOfId(0, 2)).toBe(DEFAULT_INACTIVE_OPACITY);
			activity.set(0, null);
			expect(activity.opacityOfId(0, 2)).toBe(1);
		});

		it('never dims on a guess: an identity that is not live reads fully visible', () => {
			const host = hostWith(identity());
			const activity = new FieldActivity('f', host);
			activity.set(0, values('a'));
			host.identity = null;
			expect(activity.opacityOfId(0, 1)).toBe(1);
		});
	});

	describe('the free slot', () => {
		/** The slot past every id: 1 while nothing is selected, 0 while anything is. */
		const free = (activity: FieldActivity, group = 0) =>
			table(activity, group).activityOf(table(activity, group).count - 1);

		it('is 1 with nothing selected, 0 with anything selected, and 1 again once cleared', () => {
			const activity = new FieldActivity('f', hostWith(new FieldIdentity(['a', 'b'], 'f')));
			activity.set(0, null);
			expect(table(activity).count).toBe(3);
			expect(free(activity)).toBe(1);
			activity.set(0, values('a'));
			expect(free(activity)).toBe(0);
			activity.set(0, null);
			expect(free(activity)).toBe(1);
		});

		it('is per group, and is no id: a value never maps to it', () => {
			const activity = new FieldActivity('f', hostWith(new FieldIdentity(['a', 'b'], 'f')));
			activity.set(1, values('b'));
			activity.set(0, null);
			expect(free(activity, 1)).toBe(0);
			expect(free(activity, 0)).toBe(1);
			expect(activity.opacityOfValue(1, 'b')).toBe(1);
		});
	});
});
