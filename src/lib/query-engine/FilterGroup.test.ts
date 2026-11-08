import { describe, it, expect, vi } from 'vitest';
import { FilterGroup } from './FilterGroup.svelte';
import type { ActiveValueScale } from './FilterGroup.svelte';
import type { ActivationSource, QueryEngine } from './QueryEngine';

function mockScale(): ActiveValueScale & { active: Set<unknown> | null; clearCount: number } {
	return {
		active: null,
		clearCount: 0,
		setActiveValues(values: Set<unknown>) {
			this.active = values;
		},
		clearActiveValues() {
			this.active = null;
			this.clearCount++;
		}
	};
}

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

const sqlOf = (group: FilterGroup, markId: string) =>
	group.selection.predicate(markId).map((p) => String(p));

const strings = (v: unknown) => new Set(v as string[]);

describe('FilterGroup', () => {
	describe('register', () => {
		it('returns a handle that updates the selection', () => {
			const group = new FilterGroup();
			const handle = group.register('brush-x', { excludeMarkIds: () => new Set(['mark-a']) });

			handle.update('x BETWEEN 10 AND 20', [10, 20]);

			expect(group.selection.isActive('brush-x')).toBe(true);
			expect(group.selection.predicate('mark-b')).toEqual(['x BETWEEN 10 AND 20']);
			expect(group.selection.predicate('mark-a')).toEqual([]);
		});

		it('clear removes the clause', () => {
			const group = new FilterGroup();
			const handle = group.register('brush-x', { excludeMarkIds: () => new Set(['mark-a']) });

			handle.update('x > 0', null);
			handle.clear();

			expect(group.selection.isActive('brush-x')).toBe(false);
			expect(group.activeCount).toBe(0);
		});

		it('destroy removes the clause and the augmenter', () => {
			const group = new FilterGroup();
			const augment = vi.fn(() => ({ kind: 'range', column: 'x' }));
			const handle = group.register('brush-x', { excludeMarkIds: () => new Set(), augment });

			handle.update('x > 0', [0, 100]);
			expect(group.items).toHaveLength(1);

			handle.destroy();
			expect(group.items).toHaveLength(0);
			expect(group.selection.isActive('brush-x')).toBe(false);
		});

		it('several registrations are one source, and the clause carries the writer’s exclusions', () => {
			const group = new FilterGroup();
			const legend = group.register('toggle-region', { excludeMarkIds: () => new Set() });
			const chart = group.register('toggle-region', {
				excludeMarkIds: () => new Set(['mark-chart'])
			});

			legend.update("region IN ('North')", [['North']]);
			expect(group.selection.predicate('mark-chart')).toEqual(["region IN ('North')"]);

			chart.update("region IN ('South')", [['South']]);
			expect(group.selection.predicate('mark-chart')).toEqual([]);
			expect(group.selection.predicate('mark-other')).toEqual(["region IN ('South')"]);
		});

		it('only the last registration to go removes the clause', () => {
			const group = new FilterGroup();
			const a = group.register('brush-x', { excludeMarkIds: () => new Set() });
			const b = group.register('brush-x', { excludeMarkIds: () => new Set() });
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
			const handle = group.register('brush-x', { excludeMarkIds: () => new Set() });

			handle.clear();
			handle.destroy();
			expect(onClauseChange).not.toHaveBeenCalled();

			const again = group.register('brush-x', { excludeMarkIds: () => new Set() });
			again.update('x > 0', null);
			again.destroy();
			expect(onClauseChange).toHaveBeenCalledTimes(2);
		});
	});

	describe('items with augmentation', () => {
		it('applies augmenter to produce schema metadata', () => {
			const group = new FilterGroup();
			group.register('brush-x', {
				excludeMarkIds: () => new Set(),
				augment: (value) => ({
					kind: 'range',
					column: 'price',
					label: 'Price',
					values: value as unknown[]
				})
			});

			group.selection.update('brush-x', {
				predicate: 'price BETWEEN 10 AND 50',
				excludeMarkIds: new Set(),
				value: [10, 50]
			});

			const items = group.items;
			expect(items).toHaveLength(1);
			expect(items[0].schema).toEqual({
				kind: 'range',
				column: 'price',
				label: 'Price',
				values: [10, 50]
			});
		});

		it('labels a toggle’s filter item with its field', () => {
			const group = new FilterGroup();
			group.registerToggle('region', { excludeMarkIds: () => new Set() }).toggle(['North'], false);

			expect(group.items[0].schema).toEqual({ kind: 'toggle', column: 'region', label: 'region' });
		});
	});

	describe('scale projection', () => {
		it('projects active values to scales on update', () => {
			const scale = mockScale();
			const group = new FilterGroup();

			const handle = group.register('brush-x', {
				excludeMarkIds: () => new Set(),
				projection: { scales: () => [scale], values: strings }
			});

			handle.update("species IN ('Adelie', 'Gentoo')", ['Adelie', 'Gentoo']);

			expect(scale.active).toEqual(new Set(['Adelie', 'Gentoo']));
		});

		it('clears scale projection when the clause is cleared', () => {
			const scale = mockScale();
			const group = new FilterGroup();

			const handle = group.register('brush-x', {
				excludeMarkIds: () => new Set(),
				projection: { scales: () => [scale], values: strings }
			});

			handle.update('x > 0', ['A', 'B']);
			expect(scale.active).toBeDefined();

			handle.clear();
			expect(scale.active).toBeNull();
		});

		it('projects onto the union of every registration’s scales, whoever wrote', () => {
			const legendScale = mockScale();
			const bandScale = mockScale();
			const group = new FilterGroup();

			const legend = group.register('toggle-region', {
				excludeMarkIds: () => new Set(),
				projection: { scales: () => [legendScale], values: strings }
			});
			group.register('toggle-region', {
				excludeMarkIds: () => new Set(['mark-chart']),
				projection: { scales: () => [bandScale], values: strings }
			});

			legend.update("region IN ('North')", ['North']);
			expect(legendScale.active).toEqual(new Set(['North']));
			expect(bandScale.active).toEqual(new Set(['North']));
		});

		it('leaves the projection alone while a brush moves, and re-queries all the same', () => {
			const scale = mockScale();
			const { engine, onClauseChange } = mockEngine();
			const group = new FilterGroup();
			group.setEngine(engine);
			const setActive = vi.spyOn(scale, 'setActiveValues');

			const legend = group.registerToggle('region', {
				excludeMarkIds: () => new Set(),
				scales: () => [scale]
			});
			legend.toggle(['North'], false);
			expect(setActive).toHaveBeenCalledTimes(1);
			const projected = scale.active;

			const brush = group.register('brush-x', { excludeMarkIds: () => new Set() });
			for (let i = 0; i < 10; i++) brush.update(`x > ${i}`, [i, i + 1]);
			brush.clear();

			expect(setActive).toHaveBeenCalledTimes(1);
			expect(scale.active).toBe(projected);
			expect(onClauseChange).toHaveBeenCalledTimes(12);
		});

		it('un-dims a toggle’s scales when its last registration goes', () => {
			const scale = mockScale();
			const group = new FilterGroup();
			const legend = group.registerToggle('region', {
				excludeMarkIds: () => new Set(),
				scales: () => [scale]
			});
			legend.toggle(['North'], false);
			legend.destroy();
			expect(scale.active).toBeNull();
		});
	});

	describe('activate', () => {
		it('hands the engine the marks every registration excludes, and the dims', () => {
			const { engine, activations } = mockEngine();
			const group = new FilterGroup();
			group.setEngine(engine);
			const dims = [{ kind: 'value' as const, field: 'region' }];

			const chart = group.register('toggle-region', {
				excludeMarkIds: () => new Set(['mark-a', 'mark-b']),
				activeDims: () => dims
			});
			chart.activate();
			expect(activations.at(-1)).toEqual({
				sourceId: 'toggle-region',
				excludedByAll: new Set(['mark-a', 'mark-b']),
				dims
			});

			// A second consumer that excludes only mark-a: mark-b is filtered by it.
			group.register('toggle-region', {
				excludeMarkIds: () => new Set(['mark-a']),
				activeDims: () => dims
			});
			chart.activate();
			expect(activations.at(-1)!.excludedByAll).toEqual(new Set(['mark-a']));

			// A legend excludes nothing, so every mark is activated.
			group.register('toggle-region', { excludeMarkIds: () => new Set() });
			chart.activate();
			expect(activations.at(-1)!.excludedByAll).toEqual(new Set());
		});

		it('does nothing without an engine', () => {
			const group = new FilterGroup();
			const handle = group.register('brush-x', { excludeMarkIds: () => new Set() });
			expect(() => handle.activate()).not.toThrow();
		});
	});

	describe('manual entries', () => {
		it('upsertManual adds a clause', () => {
			const group = new FilterGroup();
			group.upsertManual('derived-1', 'x BETWEEN 100 AND 200', [100, 200], new Set(['mark-a']), {
				kind: 'range',
				column: 'x'
			});

			expect(group.selection.isActive('manual:derived-1')).toBe(true);
			expect(group.selection.predicate('mark-b')).toEqual(['x BETWEEN 100 AND 200']);
			expect(group.selection.predicate('mark-a')).toEqual([]);
		});

		it('removeManual removes the clause', () => {
			const group = new FilterGroup();
			group.upsertManual('derived-1', 'x > 0', null, new Set());
			group.removeManual('derived-1');

			expect(group.selection.isActive('manual:derived-1')).toBe(false);
		});
	});

	describe('clearAll', () => {
		it('removes all clauses, so every toggle reads nothing selected', () => {
			const group = new FilterGroup();
			const handle = group.register('brush-x', { excludeMarkIds: () => new Set() });
			handle.update('x > 0', null);

			const species = group.registerToggle('species', { excludeMarkIds: () => new Set() });
			species.toggle(['Adelie'], false);

			group.clearAll();

			expect(group.selection.activeCount).toBe(0);
			expect(species.values.size).toBe(0);
		});
	});
});

describe('registerToggle', () => {
	const noMarks = () => new Set<string>();
	const chartMarks = () => new Set(['mark-chart']);

	it('single-select replaces the selection, and toggling the only value clears it', () => {
		const group = new FilterGroup();
		const toggle = group.registerToggle('species', { excludeMarkIds: noMarks });

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
		const toggle = group.registerToggle('species', { excludeMarkIds: noMarks });

		toggle.toggle(['Adelie'], true);
		toggle.toggle(['Gentoo'], true);
		expect(toggle.values).toEqual(new Set(['Adelie', 'Gentoo']));
		toggle.toggle(['Adelie'], true);
		expect(toggle.values).toEqual(new Set(['Gentoo']));
	});

	it('a multi-select that would select every one of `total` values clears instead', () => {
		const group = new FilterGroup();
		const toggle = group.registerToggle('species', { excludeMarkIds: noMarks });

		toggle.toggle(['Adelie'], true, 2);
		toggle.toggle(['Gentoo'], true, 2);
		expect(toggle.active).toBe(false);
		expect(group.selection.isActive('toggle-species')).toBe(false);
	});

	it('toggles on the same field share one selection, read from the clause', () => {
		const group = new FilterGroup();
		const legend = group.registerToggle('region', { excludeMarkIds: noMarks });
		const chart = group.registerToggle('region', { excludeMarkIds: chartMarks });

		legend.toggle(['North'], false);
		expect(chart.values).toEqual(new Set(['North']));

		// A multi-select on the chart starts from the legend's selection.
		chart.toggle(['South'], true);
		expect(legend.values).toEqual(new Set(['North', 'South']));
	});

	it('writes the clause with the consumer’s exclusions, always as tuples', () => {
		const group = new FilterGroup();
		const legend = group.registerToggle('region', { excludeMarkIds: noMarks });
		const chart = group.registerToggle('region', { excludeMarkIds: chartMarks });

		legend.toggle(['North'], false);
		expect(sqlOf(group, 'mark-chart')).toEqual([`("region" IN ('North'))`]);
		expect(group.selection.get('toggle-region')!.value).toEqual([['North']]);

		chart.toggle(['South'], false);
		expect(sqlOf(group, 'mark-chart')).toEqual([]);
		expect(sqlOf(group, 'mark-other')).toEqual([`("region" IN ('South'))`]);
		expect(group.selection.get('toggle-region')!.value).toEqual([['South']]);
	});

	it('supplies its projection values itself, onto every consumer’s scales', () => {
		const group = new FilterGroup();
		const color = mockScale();
		const band = mockScale();
		const legend = group.registerToggle('region', {
			excludeMarkIds: noMarks,
			scales: () => [color]
		});
		group.registerToggle('region', { excludeMarkIds: chartMarks, scales: () => [band] });

		legend.toggle(['North'], false);
		expect(color.active).toEqual(new Set(['North']));
		expect(band.active).toEqual(new Set(['North']));

		legend.clear();
		expect(color.active).toBeNull();
		expect(band.active).toBeNull();
	});

	it('reads the same selection object while its clause is unchanged, and one shared empty set without one', () => {
		const group = new FilterGroup();
		const brush = group.register('brush-x', { excludeMarkIds: noMarks });
		const unselected = group.registerToggle('species', { excludeMarkIds: noMarks });
		const selected = group.registerToggle('region', { excludeMarkIds: noMarks });
		selected.toggle(['North'], false);

		const empty = unselected.values;
		const north = selected.values;
		// Brush frames touch neither toggle's clause.
		brush.update('x > 0', [0, 1]);
		brush.update('x > 1', [1, 2]);
		expect(unselected.values).toBe(empty);
		expect(selected.values).toBe(north);
		expect(group.registerToggle('carrier', { excludeMarkIds: noMarks }).values).toBe(empty);
	});

	it('uses separate clauses for a field tuple and its first field', () => {
		const group = new FilterGroup();
		const pair = group.registerToggle(['region', 'category'], { excludeMarkIds: noMarks });
		const region = group.registerToggle('region', { excludeMarkIds: noMarks });

		pair.toggle(['North', 'Books'], false);
		expect(region.active).toBe(false);
	});

	it('builds an OR of IS NOT DISTINCT FROM tuples for several fields', () => {
		const group = new FilterGroup();
		const toggle = group.registerToggle(['region', 'category'], { excludeMarkIds: noMarks });

		toggle.set([
			['North', 'Books'],
			['South', null]
		]);
		const [sql] = sqlOf(group, 'mark-x');
		expect(sql).toContain(`"region" IS NOT DISTINCT FROM 'North'`);
		expect(sql).toContain(`"category" IS NOT DISTINCT FROM NULL`);
		expect(sql).toContain(' OR ');
	});

	it('keys BIGINT tuples without throwing, and keeps 1 and "1" apart', () => {
		const group = new FilterGroup();
		const toggle = group.registerToggle(['year', 'code'], { excludeMarkIds: noMarks });

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
		const toggle = group.registerToggle('year("date")', { excludeMarkIds: noMarks });

		toggle.toggle([2021], false);
		expect(sqlOf(group, 'mark-x')).toEqual([`(year("date") IN (2021))`]);
	});

	it('activates with one value dim per field', () => {
		const { engine, activations } = mockEngine();
		const group = new FilterGroup();
		group.setEngine(engine);
		group.registerToggle(['region', 'category'], { excludeMarkIds: noMarks }).activate();

		expect(activations.at(-1)!.dims).toEqual([
			{ kind: 'value', field: 'region' },
			{ kind: 'value', field: 'category' }
		]);
	});

	describe('lifetime', () => {
		it('clears the selection when its last consumer goes, not before', () => {
			const group = new FilterGroup();
			const legend = group.registerToggle('region', { excludeMarkIds: noMarks });
			const chart = group.registerToggle('region', { excludeMarkIds: chartMarks });
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
			const label = group.registerToggle('region', { excludeMarkIds: chartMarks });
			label.toggle(['North'], false);
			label.destroy();
			expect(group.selection.isActive('toggle-region')).toBe(false);

			const legend = group.registerToggle('carrier', { excludeMarkIds: noMarks });
			const carrierLabel = group.registerToggle('carrier', { excludeMarkIds: chartMarks });
			carrierLabel.toggle(['UA'], false);
			carrierLabel.destroy();
			expect(legend.values).toEqual(new Set(['UA']));
		});

		it('clearing the clause from outside (a filter chip) clears what every toggle reads', () => {
			const group = new FilterGroup();
			const legend = group.registerToggle('region', { excludeMarkIds: noMarks });
			legend.toggle(['North'], true);

			group.clearSource('toggle-region');
			expect(legend.active).toBe(false);

			// The next shift-click starts from nothing, not from the old tuples.
			legend.toggle(['South'], true);
			expect(legend.values).toEqual(new Set(['South']));
		});
	});
});
