import { describe, it, expect } from 'vitest';
import { BandScaleState } from './BandScaleState.svelte';
import { DEFAULT_INACTIVE_OPACITY, type ActivityTable } from './ActivityTable';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';
import { createIdentitySlotState, packIdentitySlots } from '$lib/gpu/identity-slot-packing';

/**
 * A band axis's selection, as the GPU and the axis labels see it: the activity
 * table the scale feeds from setActiveValues, packed as the second half of its
 * block, and the label opacity that follows it on the same clock.
 */

const loop = { addAnimatedSource: () => {}, removeAnimatedSource: () => {} };

/** A band scale with identity over `dim`, displaying `shown`. */
function scaleOf(dim: string[], shown: string[] = dim, withLoop = false) {
	const scale = new BandScaleState('category', [], withLoop ? { gpuCoordinator: loop } : {});
	scale.setIdentity(new FieldIdentity(dim));
	scale.addMark(shown, 'mark-1');
	scale.updateDomainFromExtents();
	return scale;
}

const table = (scale: BandScaleState) => scale.slots.activity as unknown as ActivityTable;
const activity = (scale: BandScaleState) =>
	Array.from({ length: scale.slots.count }, (_, id) => table(scale).activityOf(id));

describe('BandScaleState selection activity', () => {
	it('covers every id, all active, with nothing selected', () => {
		const scale = scaleOf(['a', 'b', 'c']);
		expect(activity(scale)).toEqual([1, 1, 1]);
	});

	it('dims the ids of unselected values, and several stay selected together', () => {
		const scale = scaleOf(['a', 'b', 'c']);
		scale.setActiveValues(['a', 'c']);
		expect(activity(scale)).toEqual([1, 0, 1]);
	});

	it('restores every id on clear', () => {
		const scale = scaleOf(['a', 'b', 'c']);
		scale.setActiveValues(['b']);
		scale.clearActiveValues();
		expect(activity(scale)).toEqual([1, 1, 1]);
	});

	it('applies a selection made before identity landed', () => {
		const scale = new BandScaleState('category');
		scale.setActiveValues(['b']);
		scale.setIdentity(new FieldIdentity(['a', 'b', 'c']));
		scale.addMark(['a', 'b', 'c'], 'mark-1');
		scale.updateDomainFromExtents();
		expect(activity(scale)).toEqual([0, 1, 0]);
	});

	it('names the charts drawing it to the selection clock', () => {
		const scale = scaleOf(['a', 'b']);
		expect(table(scale).clock._affectedChartsArray).toBe(scale._affectedChartsArray);
	});

	it('fades a label to the inactive opacity, on the selection clock', () => {
		const scale = scaleOf(['a', 'b'], ['a', 'b'], true);
		const clock = table(scale).clock;
		expect(scale.tickOpacity(1)).toBe(1);

		scale.setActiveValues(['a']);
		expect(clock.running).toBe(true);
		for (let i = 0; i < 20; i++) {
			clock.step();
			clock.updateRenderState(0);
		}
		const midway = scale.tickOpacity(1);
		expect(midway).toBeLessThan(1);
		expect(midway).toBeGreaterThan(DEFAULT_INACTIVE_OPACITY);
		expect(scale.tickOpacity(0)).toBe(1);

		clock._markAtRest();
		expect(scale.tickOpacity(1)).toBeCloseTo(DEFAULT_INACTIVE_OPACITY, 6);
	});

	it('reaches the packed block as its activity half', () => {
		const scale = scaleOf(['a', 'b', 'c']);
		scale.setActiveValues(['c']);
		const state = createIdentitySlotState(64);
		packIdentitySlots([{ id: scale.id, slots: scale.slots }], state);
		const base = state.offsets.get(scale.id)!;
		const count = state.bufferTo[base];
		expect(Array.from(state.bufferTo.slice(base + 1 + count, base + 1 + 2 * count))).toEqual([
			0, 0, 1
		]);
	});
});
