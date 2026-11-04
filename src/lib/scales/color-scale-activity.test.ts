import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ColorScaleState } from './ColorScaleState.svelte';
import type { ScaleRegistry } from './ScaleRegistry.svelte';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';
import { createIdentitySlotState, packIdentitySlots } from '$lib/gpu/identity-slot-packing';
import { DEFAULT_INACTIVE_OPACITY, type ActivityTable } from './ActivityTable';

/**
 * An ordinal colour scale's selection, as the GPU will see it: the activity
 * table the scale feeds from setActiveValues, packed as the second half of its
 * block. No coordinator, so a fade lands at once.
 */
describe('ColorScaleState selection activity', () => {
	const registry = {
		allocateColorSlot: () => 0,
		allocatePaletteSlot: () => 0,
		allocateRampSlot: () => 0,
		releasePaletteSlot: () => {},
		invalidateChartsUsingScale: () => {},
		chartsUsing: () => ['chart-1']
	} as unknown as ScaleRegistry;

	const ordinal = (domain: string[] = ['a', 'b', 'c']) =>
		new ColorScaleState(
			{ field: 'f', type: 'ordinal', scheme: 'tableau10', domain },
			registry,
			null
		);

	/** Activity per id, read through the slots the packer reads. */
	const activity = (scale: ColorScaleState) => {
		const table = scale.slots.activity!;
		return Array.from(
			{ length: scale.slots.count },
			(_, id) => table.from[id] + (table.to[id] - table.from[id]) * table.t
		);
	};

	let warn: ReturnType<typeof vi.spyOn>;
	let log: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		log = vi.spyOn(console, 'log').mockImplementation(() => {});
	});
	afterEach(() => {
		warn.mockRestore();
		log.mockRestore();
	});

	it('covers every id of the dim, all active, once identity lands', () => {
		const scale = ordinal();
		scale.setIdentity(new FieldIdentity(['a', 'b', 'c']));
		expect(activity(scale)).toEqual([1, 1, 1]);
	});

	it('dims the ids of unselected values', () => {
		const scale = ordinal();
		scale.setIdentity(new FieldIdentity(['a', 'b', 'c']));
		scale.setActiveValues(['b']);
		expect(activity(scale)).toEqual([0, 1, 0]);
	});

	it('maps values through identity, not domain order', () => {
		// Ids come from the dim; the domain may list categories in another order.
		const scale = ordinal(['c', 'b', 'a']);
		scale.setIdentity(new FieldIdentity(['a', 'b', 'c']));
		scale.setActiveValues(['c']);
		expect(activity(scale)).toEqual([0, 0, 1]);
	});

	it('restores every id on clear', () => {
		const scale = ordinal();
		scale.setIdentity(new FieldIdentity(['a', 'b', 'c']));
		scale.setActiveValues(['a']);
		scale.clearActiveValues();
		expect(activity(scale)).toEqual([1, 1, 1]);
	});

	it('applies a selection made before identity landed', () => {
		const scale = ordinal();
		scale.setActiveValues(['c']);
		scale.setIdentity(new FieldIdentity(['a', 'b', 'c']));
		expect(activity(scale)).toEqual([0, 0, 1]);
	});

	it('ignores values the dim does not hold', () => {
		const scale = ordinal();
		scale.setIdentity(new FieldIdentity(['a', 'b', 'c']));
		scale.setActiveValues(['b', 'zzz']);
		expect(activity(scale)).toEqual([0, 1, 0]);
	});

	it('leaves a continuous scale with nothing to dim', () => {
		const scale = new ColorScaleState(
			{ field: 'v', type: 'sequential', scheme: 'viridis', domain: [0, 1] },
			registry,
			null
		);
		scale.setActiveValues([0.5]);
		expect(scale.slots.count).toBe(0);
	});

	it('names the charts drawing it to the selection clock', () => {
		const scale = ordinal();
		const table = scale.slots.activity as ActivityTable;
		expect(table.clock._affectedChartsArray).toEqual(['chart-1']);
	});

	it('reaches the packed block as its activity half', () => {
		const scale = ordinal();
		scale.setIdentity(new FieldIdentity(['a', 'b', 'c']));
		scale.setActiveValues(['a', 'c']);

		const state = createIdentitySlotState(64);
		packIdentitySlots([{ id: 'colour', slots: scale.slots }], state);
		const base = state.offsets.get('colour')!;
		const count = state.bufferTo[base];
		expect(count).toBe(3);
		expect(Array.from(state.bufferTo.slice(base + 1 + count, base + 1 + 2 * count))).toEqual([
			1, 0, 1
		]);
	});

	it('gives a legend entry the inactive opacity for an unselected category', () => {
		const scale = ordinal();
		scale.setIdentity(new FieldIdentity(['a', 'b', 'c']));
		expect(scale.categoryOpacity('b')).toBe(1);
		scale.setActiveValues(['a']);
		expect(scale.categoryOpacity('a')).toBe(1);
		expect(scale.categoryOpacity('b')).toBe(DEFAULT_INACTIVE_OPACITY);
	});

	it('fades a legend entry on the selection clock', () => {
		// The animation loop is the coordinator, which a colour scale also uploads
		// through, so the stand-in takes those writes too.
		const loop = {
			addAnimatedSource: () => {},
			removeAnimatedSource: () => {},
			writeColorConfig: () => {},
			writeColorConfigSlotBase: () => {},
			writeColorPalette: () => {},
			writeColorRamp: () => {}
		};
		const scale = new ColorScaleState(
			{ field: 'f', type: 'ordinal', scheme: 'tableau10', domain: ['a', 'b'] },
			registry,
			loop as never
		);
		scale.setIdentity(new FieldIdentity(['a', 'b']));
		scale.setActiveValues(['a']);
		const clock = (scale.slots.activity as ActivityTable).clock;
		for (let i = 0; i < 20; i++) {
			clock.step();
			clock.updateRenderState(0);
		}
		const midway = scale.categoryOpacity('b');
		expect(midway).toBeLessThan(1);
		expect(midway).toBeGreaterThan(DEFAULT_INACTIVE_OPACITY);
		clock._markAtRest();
		expect(scale.categoryOpacity('b')).toBeCloseTo(DEFAULT_INACTIVE_OPACITY, 6);
	});

	it('dims a legend entry by selection alone before identity lands', () => {
		const scale = ordinal();
		scale.setActiveValues(['a']);
		expect(scale.categoryOpacity('a')).toBe(1);
		expect(scale.categoryOpacity('b')).toBe(DEFAULT_INACTIVE_OPACITY);
	});
});
