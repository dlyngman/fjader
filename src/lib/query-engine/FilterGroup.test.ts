import { describe, it, expect, vi } from 'vitest';
import { FilterGroup } from './FilterGroup.svelte';
import type { ActivationSource, QueryEngine } from './QueryEngine';
import type { MarkRoute } from './CrossfilterSelection.svelte';

/** The parts of QueryEngine FilterGroup calls, recording activations. */
function mockEngine(sqlFor: Record<string, string> = {}) {
	const activations: ActivationSource[] = [];
	const engine = {
		activate: vi.fn((_group: FilterGroup, source: ActivationSource) => {
			activations.push(source);
			return Promise.resolve();
		}),
		onFilterChange: vi.fn(),
		onClauseChange: vi.fn(),
		forgetSource: vi.fn(),
		identitySqlFor: (field: string) => sqlFor[field] ?? null
	};
	return {
		engine: engine as unknown as QueryEngine,
		activations,
		onClauseChange: engine.onClauseChange
	};
}

/** Charts are compared by reference, as ChartConfig objects are. */
const CHART = { name: 'chart' };
const OTHER = { name: 'other' };
const inChart = (chart: object | null): MarkRoute => ({ reads: [], chart });
const filterIn = (chart: object | null): MarkRoute => ({ reads: [], chart, response: 'filter' });

const sqlOf = (group: FilterGroup, chart: object | null) =>
	group.selection.predicate(inChart(chart)).map((p) => String(p));

describe('FilterGroup', () => {
	describe('register', () => {
		it('returns a handle that updates the selection', () => {
			const group = new FilterGroup();
			const handle = group.register('brush-x', { chart: CHART });

			handle.update('x BETWEEN 10 AND 20', [10, 20]);

			expect(group.selection.isActive('brush-x')).toBe(true);
			expect(group.selection.predicate(inChart(OTHER))).toEqual(['x BETWEEN 10 AND 20']);
			expect(group.selection.predicate(inChart(CHART))).toEqual([]);
		});

		it('clear removes the clause', () => {
			const group = new FilterGroup();
			const handle = group.register('brush-x', { chart: CHART });

			handle.update('x > 0', null);
			handle.clear();

			expect(group.selection.isActive('brush-x')).toBe(false);
			expect(group.activeCount).toBe(0);
		});

		it('destroy removes the clause and the augmenter', () => {
			const group = new FilterGroup();
			const augment = vi.fn(() => ({ kind: 'range', column: 'x' }));
			const handle = group.register('brush-x', { augment });

			handle.update('x > 0', [0, 100]);
			expect(group.items).toHaveLength(1);

			handle.destroy();
			expect(group.items).toHaveLength(0);
			expect(group.selection.isActive('brush-x')).toBe(false);
		});

		it('the last destroy drops preagg tables before clearing, and only once', () => {
			const { engine, onClauseChange } = mockEngine();
			const forget = engine.forgetSource as ReturnType<typeof vi.fn>;
			const group = new FilterGroup();
			group.setEngine(engine);
			const handle = group.register('brush-x', {});
			handle.update('x > 0', null);
			onClauseChange.mockClear();

			handle.destroy();
			expect(forget).toHaveBeenCalledTimes(1);
			expect(onClauseChange).toHaveBeenCalledTimes(1);
			expect(forget.mock.invocationCallOrder[0]).toBeLessThan(
				onClauseChange.mock.invocationCallOrder[0]
			);

			// A newer registration under the same id survives a second destroy.
			const again = group.register('brush-x', {});
			again.update('x > 1', null);
			handle.destroy();
			expect(group.selection.isActive('brush-x')).toBe(true);
			expect(forget).toHaveBeenCalledTimes(1);
		});

		it('several registrations are one source: a chart one of them skips skips every write', () => {
			const group = new FilterGroup();
			const legend = group.register('toggle-region', {});
			const chart = group.register('toggle-region', { chart: CHART });

			legend.update("region IN ('North')", [['North']]);
			expect(group.selection.predicate(inChart(CHART))).toEqual([]);

			chart.update("region IN ('South')", [['South']]);
			expect(group.selection.predicate(inChart(CHART))).toEqual([]);
			expect(group.selection.predicate(inChart(OTHER))).toEqual(["region IN ('South')"]);
		});

		it('only the last registration to go removes the clause', () => {
			const group = new FilterGroup();
			const a = group.register('brush-x', {});
			const b = group.register('brush-x', {});
			a.update('x > 0', null);

			a.destroy();
			expect(group.selection.isActive('brush-x')).toBe(true);
			b.destroy();
			expect(group.selection.isActive('brush-x')).toBe(false);
		});
	});

	describe('clearSource', () => {
		it('re-queries only when there was a clause to remove', () => {
			const { engine, onClauseChange } = mockEngine();
			const group = new FilterGroup();
			group.setEngine(engine);
			const handle = group.register('brush-x', {});

			handle.clear();
			handle.destroy();
			expect(onClauseChange).not.toHaveBeenCalled();

			const again = group.register('brush-x', {});
			again.update('x > 0', null);
			again.destroy();
			expect(onClauseChange).toHaveBeenCalledTimes(2);
		});
	});

	describe('categorical selections', () => {
		it('a single-field toggle states its field and values on every clause it writes', () => {
			const group = new FilterGroup();
			const toggle = group.registerToggle('carrier');
			toggle.set([['UA'], ['DL']]);

			const clause = group.selection.get('toggle-carrier')!;
			expect(clause.categorical?.key).toBe('carrier');
			expect(clause.categorical?.values).toEqual(new Set(['UA', 'DL']));
			// The handle's selection is that same set, not a copy.
			expect(toggle.values).toBe(clause.categorical!.values);
		});

		it('a tuple toggle, a brush and a manual clause state none', () => {
			const group = new FilterGroup();
			group.registerToggle(['a', 'b'], {}).set([[1, 2]]);
			group.register('brush', {}).update('x > 0', [0, 1]);
			group.upsertManual('m', 'y > 0', null);

			expect(group.selection.get('toggle-["a","b"]')!.categorical).toBeNull();
			expect(group.selection.get('brush')!.categorical).toBeNull();
			expect(group.selection.get('manual:m')!.categorical).toBeNull();
		});
	});

	describe('items with augmentation', () => {
		it('applies augmenter to produce schema metadata', () => {
			const group = new FilterGroup();
			const augment = vi.fn((value: unknown) => ({
				kind: 'range',
				column: 'price',
				label: 'Price',
				values: value as unknown[]
			}));
			const handle = group.register('brush-x', { augment });

			handle.update('price BETWEEN 10 AND 50', [10, 50]);

			const items = group.items;
			expect(items).toHaveLength(1);
			expect(items[0].schema).toEqual({
				kind: 'range',
				column: 'price',
				label: 'Price',
				values: [10, 50]
			});
			// On the raw clause too, computed once per write rather than per read.
			expect(group.selection.get('brush-x')!.schema).toBe(items[0].schema);
			void group.items;
			expect(augment).toHaveBeenCalledTimes(1);
		});

		it('takes the schema from another registration when the writer has no augment', () => {
			const group = new FilterGroup();
			group.register('brush-x', {
				augment: () => ({ kind: 'range', column: 'x' })
			});
			const plain = group.register('brush-x', {});

			plain.update('x > 0', [0, 1]);
			expect(group.selection.get('brush-x')!.schema).toEqual({ kind: 'range', column: 'x' });
		});

		it('labels a toggle’s filter item with its field', () => {
			const group = new FilterGroup();
			group.registerToggle('region').toggle(['North'], false);

			expect(group.items[0].schema).toEqual({ kind: 'toggle', column: 'region', label: 'region' });
		});
	});

	describe('activate', () => {
		it('hands the engine the source, its categorical field and its dims', () => {
			const { engine, activations } = mockEngine();
			const group = new FilterGroup();
			group.setEngine(engine);

			group.registerToggle('region', { chart: CHART }).activate();
			expect(activations.at(-1)).toEqual({
				sourceId: 'toggle-region',
				categoricalKey: 'region',
				dims: [{ kind: 'value', field: 'region' }]
			});

			// A brush has no categorical field.
			const dims = [{ kind: 'value' as const, field: 'x' }];
			group.register('brush-x', { activeDims: () => dims }).activate();
			expect(activations.at(-1)).toEqual({ sourceId: 'brush-x', categoricalKey: null, dims });
		});

		it('does nothing without an engine', () => {
			const group = new FilterGroup();
			const handle = group.register('brush-x', {});
			expect(() => handle.activate()).not.toThrow();
		});
	});

	describe('manual entries', () => {
		it('upsertManual adds a clause', () => {
			const group = new FilterGroup();
			group.upsertManual('derived-1', 'x BETWEEN 100 AND 200', [100, 200], {
				kind: 'range',
				column: 'x'
			});

			expect(group.selection.isActive('manual:derived-1')).toBe(true);
			// No registration, so no chart skips it.
			expect(group.selection.predicate(inChart(CHART))).toEqual(['x BETWEEN 100 AND 200']);
		});

		it('removeManual removes the clause', () => {
			const group = new FilterGroup();
			group.upsertManual('derived-1', 'x > 0', null);
			group.removeManual('derived-1');

			expect(group.selection.isActive('manual:derived-1')).toBe(false);
		});
	});

	describe('clearAll', () => {
		it('removes all clauses, so every toggle reads nothing selected', () => {
			const group = new FilterGroup();
			const handle = group.register('brush-x', {});
			handle.update('x > 0', null);

			const species = group.registerToggle('species');
			species.toggle(['Adelie'], false);

			group.clearAll();

			expect(group.selection.activeCount).toBe(0);
			expect(species.values.size).toBe(0);
		});
	});
});

describe('registerToggle', () => {
	it('single-select replaces the selection, and toggling the only value clears it', () => {
		const group = new FilterGroup();
		const toggle = group.registerToggle('species', {});

		toggle.toggle(['Adelie'], false);
		expect(toggle.values).toEqual(new Set(['Adelie']));
		toggle.toggle(['Gentoo'], false);
		expect(toggle.values).toEqual(new Set(['Gentoo']));
		toggle.toggle(['Gentoo'], false);
		expect(toggle.active).toBe(false);
		expect(group.selection.isActive('toggle-species')).toBe(false);
	});

	it('multi-select adds and removes values', () => {
		const group = new FilterGroup();
		const toggle = group.registerToggle('species', {});

		toggle.toggle(['Adelie'], true);
		toggle.toggle(['Gentoo'], true);
		expect(toggle.values).toEqual(new Set(['Adelie', 'Gentoo']));
		toggle.toggle(['Adelie'], true);
		expect(toggle.values).toEqual(new Set(['Gentoo']));
	});

	it('a multi-select that would select every one of `total` values clears instead', () => {
		const group = new FilterGroup();
		const toggle = group.registerToggle('species', {});

		toggle.toggle(['Adelie'], true, 2);
		toggle.toggle(['Gentoo'], true, 2);
		expect(toggle.active).toBe(false);
		expect(group.selection.isActive('toggle-species')).toBe(false);
	});

	it('toggles on the same field share one selection, read from the clause', () => {
		const group = new FilterGroup();
		const legend = group.registerToggle('region', {});
		const chart = group.registerToggle('region', { chart: CHART });

		legend.toggle(['North'], false);
		expect(chart.values).toEqual(new Set(['North']));

		// A multi-select on the chart starts from the legend's selection.
		chart.toggle(['South'], true);
		expect(legend.values).toEqual(new Set(['North', 'South']));
	});

	it('writes the clause as tuples, and the chart a toggle sits in skips it, whoever writes', () => {
		const group = new FilterGroup();
		const legend = group.registerToggle('region', {});
		const chart = group.registerToggle('region', { chart: CHART });

		legend.toggle(['North'], false);
		expect(sqlOf(group, CHART)).toEqual([]);
		expect(sqlOf(group, OTHER)).toEqual([`("region" IN ('North'))`]);
		expect(group.selection.get('toggle-region')!.value).toEqual([['North']]);

		chart.toggle(['South'], false);
		expect(sqlOf(group, CHART)).toEqual([]);
		expect(sqlOf(group, OTHER)).toEqual([`("region" IN ('South'))`]);
		expect(group.selection.get('toggle-region')!.value).toEqual([['South']]);
	});

	it('reads the same selection object while its clause is unchanged, and one shared empty set without one', () => {
		const group = new FilterGroup();
		const brush = group.register('brush-x', {});
		const unselected = group.registerToggle('species', {});
		const selected = group.registerToggle('region', {});
		selected.toggle(['North'], false);

		const empty = unselected.values;
		const north = selected.values;
		// Brush frames touch neither toggle's clause.
		brush.update('x > 0', [0, 1]);
		brush.update('x > 1', [1, 2]);
		expect(unselected.values).toBe(empty);
		expect(selected.values).toBe(north);
		expect(group.registerToggle('carrier', {}).values).toBe(empty);
	});

	it("filters a 'filter' mark in a chart holding the same Toggle, one field or several", () => {
		const group = new FilterGroup();
		for (const fields of ['region', ['region', 'year']]) {
			const elsewhere = group.registerToggle(fields, { chart: OTHER });
			group.registerToggle(fields, { chart: CHART });
			elsewhere.toggle(Array.isArray(fields) ? ['North', 2024] : ['North'], false);
		}
		expect(group.selection.predicate(filterIn(CHART))).toHaveLength(2);
		expect(group.selection.predicate(inChart(CHART))).toEqual([]);
	});

	it('uses separate clauses for a field tuple and its first field', () => {
		const group = new FilterGroup();
		const pair = group.registerToggle(['region', 'category'], {});
		const region = group.registerToggle('region', {});

		pair.toggle(['North', 'Books'], false);
		expect(region.active).toBe(false);
	});

	it('builds an OR of IS NOT DISTINCT FROM tuples for several fields', () => {
		const group = new FilterGroup();
		const toggle = group.registerToggle(['region', 'category'], {});

		toggle.set([
			['North', 'Books'],
			['South', null]
		]);
		const [sql] = sqlOf(group, null);
		expect(sql).toContain(`"region" IS NOT DISTINCT FROM 'North'`);
		expect(sql).toContain(`"category" IS NOT DISTINCT FROM NULL`);
		expect(sql).toContain(' OR ');
	});

	it('keys BIGINT tuples without throwing, and keeps 1 and "1" apart', () => {
		const group = new FilterGroup();
		const toggle = group.registerToggle(['year', 'code'], {});

		expect(() => toggle.toggle([2021n, 1], true)).not.toThrow();
		toggle.toggle([2021n, '1'], true);
		expect(toggle.values.size).toBe(2);
		toggle.toggle([2021n, 1], true);
		expect(toggle.values.size).toBe(1);
	});

	it('uses the field’s identity SQL, so an expression field gets a valid predicate', () => {
		const { engine } = mockEngine({ 'year("date")': 'year("date")' });
		const group = new FilterGroup();
		group.setEngine(engine);
		const toggle = group.registerToggle('year("date")', {});

		toggle.toggle([2021], false);
		expect(sqlOf(group, null)).toEqual([`(year("date") IN (2021))`]);
	});

	it('activates with one value dim per field', () => {
		const { engine, activations } = mockEngine();
		const group = new FilterGroup();
		group.setEngine(engine);
		group.registerToggle(['region', 'category'], {}).activate();

		expect(activations.at(-1)!.dims).toEqual([
			{ kind: 'value', field: 'region' },
			{ kind: 'value', field: 'category' }
		]);
	});

	describe('lifetime', () => {
		it('clears the selection when its last consumer goes, not before', () => {
			const group = new FilterGroup();
			const legend = group.registerToggle('region', {});
			const chart = group.registerToggle('region', { chart: CHART });
			chart.toggle(['North'], false);

			// The legend still shows the selection, so it stays.
			chart.destroy();
			expect(legend.values).toEqual(new Set(['North']));

			legend.destroy();
			expect(group.selection.isActive('toggle-region')).toBe(false);
		});

		it('a band label registration destroyed (its axis reassigned) clears its selection unless a legend holds it', () => {
			// Toggle keys one band-label child per field; reassigning the band
			// channel unmounts the old field's child, which destroys this.
			const group = new FilterGroup();
			const label = group.registerToggle('region', { chart: CHART });
			label.toggle(['North'], false);
			label.destroy();
			expect(group.selection.isActive('toggle-region')).toBe(false);

			const legend = group.registerToggle('carrier', {});
			const carrierLabel = group.registerToggle('carrier', { chart: CHART });
			carrierLabel.toggle(['UA'], false);
			carrierLabel.destroy();
			expect(legend.values).toEqual(new Set(['UA']));
		});

		it('clearing the clause from outside (a filter chip) clears what every toggle reads', () => {
			const group = new FilterGroup();
			const legend = group.registerToggle('region', {});
			legend.toggle(['North'], true);

			group.clearSource('toggle-region');
			expect(legend.active).toBe(false);

			// The next shift-click starts from nothing, not from the old tuples.
			legend.toggle(['South'], true);
			expect(legend.values).toEqual(new Set(['South']));
		});
	});
});
