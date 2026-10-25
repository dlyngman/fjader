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
		identitySqlFor: (field: string) => sqlFor[field] ?? null
	};
	return {
		engine: engine as unknown as QueryEngine,
		activations,
		onFilterChange: engine.onFilterChange
	};
}

const sqlOf = (group: FilterGroup, markId: string) =>
	group.selection.predicate(markId).map((p) => String(p));

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

		it('keepClause leaves the clause when the last registration goes', () => {
			const group = new FilterGroup();
			const handle = group.register('toggle-region', {
				excludeMarkIds: () => new Set(),
				keepClause: true
			});
			handle.update("region IN ('North')", [['North']]);

			handle.destroy();
			expect(group.selection.isActive('toggle-region')).toBe(true);
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
	});

	describe('scale projection', () => {
		it('projects active values to scales on update', () => {
			const scale = mockScale();
			const group = new FilterGroup();

			const handle = group.register('brush-x', {
				excludeMarkIds: () => new Set(),
				scaleStates: () => [scale],
				extractProjectionValues: (v) => new Set(v as string[])
			});

			handle.update("species IN ('Adelie', 'Gentoo')", ['Adelie', 'Gentoo']);

			expect(scale.active).toEqual(new Set(['Adelie', 'Gentoo']));
		});

		it('clears scale projection when the clause is cleared', () => {
			const scale = mockScale();
			const group = new FilterGroup();

			const handle = group.register('brush-x', {
				excludeMarkIds: () => new Set(),
				scaleStates: () => [scale],
				extractProjectionValues: (v) => new Set(v as string[])
			});

			handle.update('x > 0', ['A', 'B']);
			expect(scale.active).toBeDefined();

			handle.clear();
			expect(scale.active).toBeNull();
		});

		it('does not project when no extractProjectionValues is provided', () => {
			const scale = mockScale();
			const group = new FilterGroup();

			const handle = group.register('brush-x', {
				excludeMarkIds: () => new Set(),
				scaleStates: () => [scale]
			});

			handle.update('x > 0', ['A', 'B']);
			expect(scale.active).toBeNull();
		});

		it('projects onto the union of every registration’s scales, whoever wrote', () => {
			const legendScale = mockScale();
			const bandScale = mockScale();
			const group = new FilterGroup();
			const extract = (v: unknown) => new Set(v as string[]);

			const legend = group.register('toggle-region', {
				excludeMarkIds: () => new Set(),
				scaleStates: () => [legendScale],
				extractProjectionValues: extract
			});
			group.register('toggle-region', {
				excludeMarkIds: () => new Set(['mark-chart']),
				scaleStates: () => [bandScale],
				extractProjectionValues: extract
			});

			legend.update("region IN ('North')", ['North']);
			expect(legendScale.active).toEqual(new Set(['North']));
			expect(bandScale.active).toEqual(new Set(['North']));
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
		it('removes all clauses and clears toggles', () => {
			const group = new FilterGroup();
			const handle = group.register('brush-x', { excludeMarkIds: () => new Set() });
			handle.update('x > 0', null);

			const species = group.getOrCreateToggle('species');
			species.register({ excludeMarkIds: () => new Set() }).toggle(['Adelie'], false);

			group.clearAll();

			expect(group.selection.activeCount).toBe(0);
			expect(species.values.size).toBe(0);
		});
	});
});

describe('ToggleState', () => {
	const noMarks = () => new Set<string>();

	it('single-select replaces the selection, and toggling the only value clears it', () => {
		const group = new FilterGroup();
		const state = group.getOrCreateToggle('species');
		const toggle = state.register({ excludeMarkIds: noMarks });

		toggle.toggle(['Adelie'], false);
		expect(state.values).toEqual(new Set(['Adelie']));
		toggle.toggle(['Gentoo'], false);
		expect(state.values).toEqual(new Set(['Gentoo']));
		toggle.toggle(['Gentoo'], false);
		expect(state.active).toBe(false);
		expect(group.selection.isActive('toggle-species')).toBe(false);
	});

	it('multi-select adds and removes values', () => {
		const group = new FilterGroup();
		const state = group.getOrCreateToggle('species');
		const toggle = state.register({ excludeMarkIds: noMarks });

		toggle.toggle(['Adelie'], true);
		toggle.toggle(['Gentoo'], true);
		expect(state.values).toEqual(new Set(['Adelie', 'Gentoo']));
		toggle.toggle(['Adelie'], true);
		expect(state.values).toEqual(new Set(['Gentoo']));
	});

	it('a multi-select that would select every one of `total` values clears instead', () => {
		const group = new FilterGroup();
		const state = group.getOrCreateToggle('species');
		const toggle = state.register({ excludeMarkIds: noMarks });

		toggle.toggle(['Adelie'], true, 2);
		toggle.toggle(['Gentoo'], true, 2);
		expect(state.active).toBe(false);
		expect(group.selection.isActive('toggle-species')).toBe(false);
	});

	it('writes the clause with the consumer’s exclusions, always as tuples', () => {
		const group = new FilterGroup();
		const state = group.getOrCreateToggle('region');
		const legend = state.register({ excludeMarkIds: noMarks });
		const chart = state.register({ excludeMarkIds: () => new Set(['mark-chart']) });

		legend.toggle(['North'], false);
		expect(sqlOf(group, 'mark-chart')).toEqual([`("region" IN ('North'))`]);
		expect(group.selection.get('toggle-region')!.value).toEqual([['North']]);

		chart.toggle(['South'], false);
		expect(sqlOf(group, 'mark-chart')).toEqual([]);
		expect(sqlOf(group, 'mark-other')).toEqual([`("region" IN ('South'))`]);
		expect(group.selection.get('toggle-region')!.value).toEqual([['South']]);
	});

	it('projects single-field tuples onto every consumer’s scales', () => {
		const group = new FilterGroup();
		const color = mockScale();
		const band = mockScale();
		const state = group.getOrCreateToggle('region');
		const legend = state.register({ excludeMarkIds: noMarks, scaleStates: () => [color] });
		state.register({ excludeMarkIds: () => new Set(['mark-chart']), scaleStates: () => [band] });

		legend.toggle(['North'], false);
		expect(color.active).toEqual(new Set(['North']));
		expect(band.active).toEqual(new Set(['North']));

		legend.clear();
		expect(color.active).toBeNull();
		expect(band.active).toBeNull();
	});

	it('is keyed by the full field list', () => {
		const group = new FilterGroup();
		expect(group.getOrCreateToggle(['region', 'category'])).not.toBe(
			group.getOrCreateToggle('region')
		);
		expect(group.getOrCreateToggle(['region'])).toBe(group.getOrCreateToggle('region'));
	});

	it('builds an OR of IS NOT DISTINCT FROM tuples for several fields', () => {
		const group = new FilterGroup();
		const state = group.getOrCreateToggle(['region', 'category']);
		const toggle = state.register({ excludeMarkIds: noMarks });

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
		const state = group.getOrCreateToggle(['year', 'code']);
		const toggle = state.register({ excludeMarkIds: noMarks });

		expect(() => toggle.toggle([2021n, 1], true)).not.toThrow();
		toggle.toggle([2021n, '1'], true);
		expect(state.values.size).toBe(2);
		toggle.toggle([2021n, 1], true);
		expect(state.values.size).toBe(1);
	});

	it('uses the field’s identity SQL, so an expression field gets a valid predicate', () => {
		const { engine } = mockEngine({ 'year("date")': 'year("date")' });
		const group = new FilterGroup();
		group.setEngine(engine);
		const toggle = group.getOrCreateToggle('year("date")').register({ excludeMarkIds: noMarks });

		toggle.toggle([2021], false);
		expect(sqlOf(group, 'mark-x')).toEqual([`(year("date") IN (2021))`]);
	});

	it('keeps the clause and selection when its last consumer goes', () => {
		const group = new FilterGroup();
		const state = group.getOrCreateToggle('region');
		const toggle = state.register({ excludeMarkIds: noMarks });
		toggle.toggle(['North'], false);

		toggle.destroy();
		expect(group.selection.isActive('toggle-region')).toBe(true);
		expect(state.values).toEqual(new Set(['North']));
	});

	it('activates with one value dim per field', () => {
		const { engine, activations } = mockEngine();
		const group = new FilterGroup();
		group.setEngine(engine);
		group
			.getOrCreateToggle(['region', 'category'])
			.register({ excludeMarkIds: noMarks })
			.activate();

		expect(activations.at(-1)!.dims).toEqual([
			{ kind: 'value', field: 'region' },
			{ kind: 'value', field: 'category' }
		]);
	});
});
