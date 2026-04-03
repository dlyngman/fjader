import { describe, it, expect, vi } from 'vitest';
import { FilterGroup, ToggleState } from './FilterGroup.svelte';
import type { ActiveValueScale } from './FilterGroup.svelte';

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

describe('FilterGroup', () => {
	describe('createBrush', () => {
		it('creates a brush handle that updates the selection', () => {
			const group = new FilterGroup();
			const handle = group.createBrush({
				sourceId: 'brush-x',
				excludeMarkIds: () => new Set(['mark-a'])
			});

			handle.update('x BETWEEN 10 AND 20', [10, 20]);

			expect(group.selection.isActive('brush-x')).toBe(true);
			expect(group.selection.predicate('mark-b')).toEqual(['x BETWEEN 10 AND 20']);
			expect(group.selection.predicate('mark-a')).toEqual([]);
		});

		it('clear removes the clause', () => {
			const group = new FilterGroup();
			const handle = group.createBrush({
				sourceId: 'brush-x',
				excludeMarkIds: () => new Set(['mark-a'])
			});

			handle.update('x > 0', null);
			handle.clear();

			expect(group.selection.isActive('brush-x')).toBe(false);
			expect(group.activeCount).toBe(0);
		});

		it('destroy removes clause and augmenter', () => {
			const group = new FilterGroup();
			const augment = vi.fn(() => ({ kind: 'range', column: 'x' }));
			const handle = group.createBrush({
				sourceId: 'brush-x',
				excludeMarkIds: () => new Set(),
				augment
			});

			handle.update('x > 0', [0, 100]);
			expect(group.items).toHaveLength(1);

			handle.destroy();
			expect(group.items).toHaveLength(0);
			expect(group.selection.isActive('brush-x')).toBe(false);
		});
	});

	describe('items with augmentation', () => {
		it('applies augmenter to produce schema metadata', () => {
			const group = new FilterGroup();
			group.createBrush({
				sourceId: 'brush-x',
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
		it('projects active values to scales on brush update', () => {
			const scale = mockScale();
			const group = new FilterGroup();

			const handle = group.createBrush({
				sourceId: 'toggle-species',
				excludeMarkIds: () => new Set(),
				scaleStates: () => [scale],
				extractProjectionValues: (v) => new Set(v as string[])
			});

			handle.update("species IN ('Adelie', 'Gentoo')", ['Adelie', 'Gentoo']);

			expect(scale.active).toEqual(new Set(['Adelie', 'Gentoo']));
		});

		it('clears scale projection when brush is cleared', () => {
			const scale = mockScale();
			const group = new FilterGroup();

			const handle = group.createBrush({
				sourceId: 'brush-x',
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

			const handle = group.createBrush({
				sourceId: 'brush-x',
				excludeMarkIds: () => new Set(),
				scaleStates: () => [scale]
			});

			handle.update('x > 0', ['A', 'B']);
			expect(scale.active).toBeNull();
		});
	});

	describe('manual entries', () => {
		it('upsertManual adds a clause', () => {
			const group = new FilterGroup();
			group.upsertManual(
				'derived-1',
				'x BETWEEN 100 AND 200',
				[100, 200],
				new Set(['mark-a']),
				{ kind: 'range', column: 'x' }
			);

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
			const handle = group.createBrush({
				sourceId: 'brush-x',
				excludeMarkIds: () => new Set()
			});
			handle.update('x > 0', null);

			const toggle = group.getOrCreateToggle('species');
			toggle.select('Adelie');

			group.clearAll();

			expect(group.selection.activeCount).toBe(0);
			expect(toggle.values.size).toBe(0);
		});
	});
});

describe('ToggleState', () => {
	it('single-select replaces current selection', () => {
		const toggle = new ToggleState('species');
		toggle.toggle('Adelie', false);
		expect(toggle.values).toEqual(new Set(['Adelie']));

		toggle.toggle('Gentoo', false);
		expect(toggle.values).toEqual(new Set(['Gentoo']));
	});

	it('single-select on already-selected value clears', () => {
		const toggle = new ToggleState('species');
		toggle.toggle('Adelie', false);
		toggle.toggle('Adelie', false);
		expect(toggle.values.size).toBe(0);
		expect(toggle.active).toBe(false);
	});

	it('multi-select toggles values', () => {
		const toggle = new ToggleState('species');
		toggle.toggle('Adelie', true);
		toggle.toggle('Gentoo', true);
		expect(toggle.values).toEqual(new Set(['Adelie', 'Gentoo']));

		toggle.toggle('Adelie', true);
		expect(toggle.values).toEqual(new Set(['Gentoo']));
	});

	it('clear removes all values', () => {
		const toggle = new ToggleState('species');
		toggle.toggle('Adelie', true);
		toggle.toggle('Gentoo', true);
		toggle.clear();
		expect(toggle.values.size).toBe(0);
		expect(toggle.active).toBe(false);
	});

	it('select sets exactly one value', () => {
		const toggle = new ToggleState('species');
		toggle.toggle('Adelie', true);
		toggle.toggle('Gentoo', true);
		toggle.select('Chinstrap');
		expect(toggle.values).toEqual(new Set(['Chinstrap']));
	});
});
