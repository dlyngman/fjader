// Beside its fixtures, not in src/lib: svelte-package processes everything in src/lib, and a test
// there importing these fixtures made it write their type declarations into this folder.
import { describe, it, expect, vi } from 'vitest';
import { ClauseRelay } from '$lib/interactors/relay-clauses';
import { render } from 'svelte/server';
import ToggleHarness from './ToggleHarness.svelte';
import BrushHarness from './BrushHarness.svelte';
import LegendHarness from './LegendHarness.svelte';
import InCellHarness from './InCellHarness.svelte';
import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
import { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
import type { ChartContext } from '$lib/types';
import {
	DeclarationRegistry,
	type ChartDeclaration
} from '$lib/components/charts/declarations.svelte';

// Counts the relays a DerivedIntervalX makes (its effects don't run on the
// server, so their writes can't be seen here; how many relays there are can).
vi.mock('$lib/interactors/relay-clauses', () => ({
	ClauseRelay: vi.fn(function () {
		return { sync() {}, clear() {} };
	})
}));

describe('Toggle split by responsibility', () => {
	it('registers once for the chart; each of three cells adds one activator', () => {
		const handle = {
			activate() {},
			destroy() {},
			toggle() {},
			toggleOther() {},
			clear() {},
			active: false
		};
		const registerToggle = vi.fn(() => handle);
		const groups = { get: () => ({ registerToggle }) };
		// Each cell counts its activator adds (server rendering removes them again
		// at the end, onDestroy).
		const adds: number[] = [0, 0, 0];
		const cells = adds.map((_, i) => {
			const activators = new Set<() => void>();
			const add = activators.add.bind(activators);
			activators.add = (fn) => {
				adds[i]++;
				return add(fn);
			};
			return { activators, onChartClick: null } as unknown as ChartContext;
		});

		render(ToggleHarness, { props: { registry: new DeclarationRegistry(), groups, cells } });

		expect(registerToggle).toHaveBeenCalledTimes(1);
		expect(registerToggle).toHaveBeenCalledWith(['island'], { chart: expect.anything() });
		expect(adds).toEqual([1, 1, 1]);
	});
});

describe('Brushes split by responsibility', () => {
	/** Three cells of different sizes; each records the activators it is given. */
	function setup() {
		const register = vi.fn((_source: string, _opts: unknown) => ({
			update() {},
			clear() {},
			activate() {},
			destroy() {}
		}));
		const groups = { get: () => ({ register }) };
		const activators: (() => void)[][] = [[], [], []];
		const cells = activators.map((added, i) => {
			const set = new Set<() => void>();
			const add = set.add.bind(set);
			set.add = (fn) => {
				added.push(fn);
				return add(fn);
			};
			return {
				activators: set,
				innerWidth: 100 * (i + 1),
				innerHeight: 50 * (i + 1),
				onInteractorPointerDown: null
			} as unknown as ChartContext;
		});
		return { register, groups, activators, cells };
	}

	type Dims = { activeDims(): { pixelExtent: number }[] };

	it.each(['1d', '2d'] as const)(
		'%s: registers once for the chart; each of three cells adds one activator',
		(kind) => {
			const { register, groups, activators, cells } = setup();
			render(BrushHarness, {
				props: {
					registry: new DeclarationRegistry(),
					groups,
					cells,
					kind,
					xScaleState: new LinearScaleState('x'),
					yScaleState: new LinearScaleState('y')
				}
			});

			expect(register).toHaveBeenCalledTimes(1);
			expect(register.mock.calls[0][0]).toBe(
				kind === '1d' ? 'interval-x-chart' : 'interval-2d-chart'
			);
			expect(activators.map((a) => a.length)).toEqual([1, 1, 1]);
		}
	);

	it.each(['1d', '2d'] as const)(
		'%s: measures pixels in the cell that activated it, not the chart',
		(kind) => {
			const { register, groups, activators, cells } = setup();
			render(BrushHarness, {
				props: {
					registry: new DeclarationRegistry(),
					groups,
					cells,
					kind,
					xScaleState: new LinearScaleState('x'),
					yScaleState: new LinearScaleState('y')
				}
			});
			const opts = register.mock.calls[0][1] as Dims;

			// No cell has activated it: no pixel extent to bin by.
			expect(opts.activeDims()).toEqual([]);

			activators[1][0]();
			const dims = opts.activeDims();
			expect(dims.map((d) => d.pixelExtent)).toEqual(kind === '1d' ? [200] : [200, 100]);

			activators[2][0]();
			expect(opts.activeDims()[0].pixelExtent).toBe(300);
		}
	);

	it.each(['x', 'y'] as const)(
		'Interval%s naming no selection writes the default group, which unnamed marks read',
		(kind) => {
			const groups = new FilterGroupRegistry();
			const defaultGroup = groups.get();
			const register = vi.spyOn(defaultGroup, 'register');
			render(BrushHarness, {
				props: {
					registry: new DeclarationRegistry(),
					groups,
					cells: [],
					kind,
					xScaleState: new LinearScaleState('x'),
					yScaleState: new LinearScaleState('y')
				}
			});

			expect(register).toHaveBeenCalledTimes(1);
			expect(register.mock.calls[0][0]).toBe(`interval-${kind}-chart`);
			// The brush made no group of its own: 'default' is the only one.
			expect(groups.has('brush')).toBe(false);
			expect(groups.get('default')).toBe(defaultGroup);
		}
	);
});

describe('ParallelBrushes and DerivedIntervalX split by responsibility', () => {
	/** Three cells; each records the activators it is given. */
	function cells() {
		const added: (() => void)[][] = [[], [], []];
		const contexts = added.map((list) => {
			const set = new Set<() => void>();
			const add = set.add.bind(set);
			set.add = (fn) => {
				list.push(fn);
				return add(fn);
			};
			return {
				activators: set,
				innerWidth: 300,
				innerHeight: 200,
				parallelScales: null,
				onInteractorPointerDown: null
			} as unknown as ChartContext;
		});
		return { added, contexts };
	}

	it('ParallelBrushes: one source per axis for the chart; one activator per cell', () => {
		const register = vi.fn((_source: string, _opts: unknown) => ({
			update() {},
			clear() {},
			activate() {},
			destroy() {}
		}));
		const groups = { get: () => ({ register }) };
		const { added, contexts } = cells();
		const columns = ['a', 'b', 'c'];
		render(BrushHarness, {
			props: {
				registry: new DeclarationRegistry(),
				groups,
				cells: contexts,
				kind: 'parallel',
				xScaleState: new LinearScaleState('x'),
				yScaleState: new LinearScaleState('y'),
				parallelScales: {
					columns,
					scaleStates: columns.map((c) => new LinearScaleState(c)),
					axisOrder: [0, 1, 2]
				}
			}
		});

		expect(register.mock.calls.map((c) => c[0])).toEqual([
			'parallel-brush-a-chart',
			'parallel-brush-b-chart',
			'parallel-brush-c-chart'
		]);
		expect(added.map((a) => a.length)).toEqual([1, 1, 1]);
	});

	it('DerivedIntervalX: one relay and one derived clause for the chart, not one per cell', () => {
		vi.mocked(ClauseRelay).mockClear();
		const removeManual = vi.fn();
		const group = { selection: new Map(), upsertManual: vi.fn(), removeManual };
		const groups = { get: () => group };
		const { contexts } = cells();
		render(BrushHarness, {
			props: {
				registry: new DeclarationRegistry(),
				groups,
				cells: contexts,
				kind: 'derived',
				xScaleState: new LinearScaleState('x'),
				yScaleState: new LinearScaleState('y')
			}
		});

		expect(ClauseRelay).toHaveBeenCalledTimes(1);
		// Destroyed at the end of server rendering: its one clause key goes.
		expect(removeManual.mock.calls).toEqual([['derived-x-chart']]);
	});
});

describe('Legend as a declaration', () => {
	it('in a chart: declares itself, for the chart to render at its position', () => {
		const registry = new DeclarationRegistry();
		const registered: ChartDeclaration[] = [];
		const register = registry.register.bind(registry);
		registry.register = (d) => {
			registered.push(d);
			return register(d);
		};
		render(LegendHarness, {
			props: { registry, scaleRegistry: { getScaleByField: () => null } }
		});

		expect(registered.map((d) => [d.kind, d.kind === 'legend' ? d.spec.position : null])).toEqual([
			['legend', 'top'],
			['legend', 'right']
		]);
		// Listed by position, in registration order.
		registry.register = register;
		for (const d of registered) registry.register(d);
		expect(registry.legends('top')).toEqual([registered[0].spec]);
		expect(registry.legends('right')).toEqual([registered[1].spec]);
	});
});

describe('Declarations inside what a cell renders per cell (InCell)', () => {
	it('declareInChart skips one there, with a warning; a chart child still declares', () => {
		const registry = new DeclarationRegistry();
		const registered: ChartDeclaration[] = [];
		const register = registry.register.bind(registry);
		registry.register = (d) => {
			registered.push(d);
			return register(d);
		};
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			render(InCellHarness, { props: { registry, probe: 'declare' } });
			expect(registered.map((d) => ('id' in d.spec ? d.spec.id : ''))).toEqual(['child']);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0][0])).toContain('inside an overlay');
		} finally {
			warn.mockRestore();
		}
	});

	it('getDeclarationChart throws there: a Toggle or brush would register once per cell', () => {
		expect(() =>
			render(InCellHarness, { props: { registry: new DeclarationRegistry(), probe: 'chart' } })
		).toThrow(/not inside an overlay/);
	});
});
