import { describe, it, expect } from 'vitest';
import { FilterGroup } from './FilterGroup.svelte';
import { FilterGroupRegistry } from './FilterGroupRegistry.svelte';
import { DEFAULT_INACTIVE_OPACITY } from '$lib/scales/ActivityTable';

/**
 * A group's selection on a field is computed from its categorical clauses,
 * never written directly. Read here through the by-value path, since these
 * groups have no engine and so no identity.
 */
const DIM = DEFAULT_INACTIVE_OPACITY;
const opacity = (group: FilterGroup, key: string, values: string[]) =>
	values.map((v) => group.activity(key).opacityOfValue(group.index, v));

describe('FilterGroup selection activity', () => {
	it('follows a toggle on the field, and clears with it', () => {
		const group = new FilterGroup();
		const toggle = group.registerToggle('carrier', { excludeMarkIds: () => new Set() });
		toggle.set([['UA']]);
		expect(opacity(group, 'carrier', ['UA', 'DL'])).toEqual([1, DIM]);
		toggle.clear();
		expect(opacity(group, 'carrier', ['UA', 'DL'])).toEqual([1, 1]);
	});

	it('intersects two categorical clauses on one field, since the filters AND', () => {
		const source = new FilterGroup();
		const group = new FilterGroup();
		group.registerToggle('carrier', { excludeMarkIds: () => new Set() }).set([['UA'], ['DL']]);
		source.registerToggle('carrier', { excludeMarkIds: () => new Set() }).set([['DL'], ['AA']]);
		group.relayClause('relay:toggle-carrier', source.selection.get('toggle-carrier')!);

		expect(opacity(group, 'carrier', ['UA', 'DL', 'AA'])).toEqual([DIM, 1, DIM]);

		group.removeManual('relay:toggle-carrier');
		expect(opacity(group, 'carrier', ['UA', 'DL', 'AA'])).toEqual([1, 1, DIM]);
	});

	it('ignores brushes, tuples and other fields', () => {
		const group = new FilterGroup();
		group.register('brush', { excludeMarkIds: () => new Set() }).update('x > 0', [0, 1]);
		group
			.registerToggle(['carrier', 'origin'], { excludeMarkIds: () => new Set() })
			.set([['UA', 'JFK']]);
		group.registerToggle('origin', { excludeMarkIds: () => new Set() }).set([['JFK']]);
		expect(opacity(group, 'carrier', ['UA', 'DL'])).toEqual([1, 1]);
	});

	it('clearAll clears every field it selected on', () => {
		const group = new FilterGroup();
		group.registerToggle('carrier', { excludeMarkIds: () => new Set() }).set([['UA']]);
		group.registerToggle('origin', { excludeMarkIds: () => new Set() }).set([['JFK']]);
		group.clearAll();
		expect(opacity(group, 'carrier', ['DL'])).toEqual([1]);
		expect(opacity(group, 'origin', ['LGA'])).toEqual([1]);
	});

	it('keeps groups of one page apart on a shared field', () => {
		const registry = new FilterGroupRegistry();
		const a = registry.get('a');
		const b = registry.get('b');
		expect([registry.get().index, a.index, b.index]).toEqual([2, 0, 1]);
		expect(a.activity('carrier')).toBe(b.activity('carrier'));

		a.registerToggle('carrier', { excludeMarkIds: () => new Set() }).set([['UA']]);
		expect(opacity(a, 'carrier', ['DL'])).toEqual([DIM]);
		expect(opacity(b, 'carrier', ['DL'])).toEqual([1]);
		expect(registry.fields.map((f) => f.key)).toEqual(['carrier']);
	});
});
