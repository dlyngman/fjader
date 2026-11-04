import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trackScalesById } from './tracked-scales';
import { createIdentitySlotState, packIdentitySlots } from './identity-slot-packing';
import { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';

/**
 * The coordinator packs exactly the scales it tracks. An ordinal colour scale
 * offered slots but had no id, so it was never tracked and never packed: its
 * ranks and selection activity did not reach the GPU, and nothing failed.
 */
describe('trackScalesById', () => {
	const registry = {
		allocateColorSlot: () => 0,
		allocatePaletteSlot: () => 0,
		allocateRampSlot: () => 0,
		releasePaletteSlot: () => {},
		invalidateChartsUsingScale: () => {},
		chartsUsing: () => []
	} as unknown as ScaleRegistry;

	let log: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		log = vi.spyOn(console, 'log').mockImplementation(() => {});
	});
	afterEach(() => log.mockRestore());

	it('tracks an ordinal colour scale alongside a band scale', () => {
		const band = new BandScaleState('species', ['a', 'b']);
		const colour = new ColorScaleState(
			{ field: 'species', type: 'ordinal', scheme: 'tableau10', domain: ['a', 'b'] },
			registry,
			null
		);
		const tracked = new Map<string, { id?: string }>();
		trackScalesById<{ id?: string }>([band, colour], tracked);

		expect(tracked.get(band.id)).toBe(band);
		expect(tracked.get(colour.id)).toBe(colour);
	});

	it('skips a scale with no id, and replaces what it tracked before', () => {
		const tracked = new Map<string, { id?: string }>([['stale', { id: 'stale' }]]);
		trackScalesById<{ id?: string }>([{ id: 'a' }, {}], tracked);
		expect([...tracked.keys()]).toEqual(['a']);
	});

	it('hands the packer a tracked colour scale exactly as the coordinator does', () => {
		// The coordinator's packing loop reads `id` and `slots` off each tracked
		// scale. This is that step, with a real colour scale whose domain order
		// differs from the dim's, so its ranks differ from its ids: the case
		// where reading the dim id as a palette index gives the wrong colour.
		const colour = new ColorScaleState(
			{ field: 'f', type: 'ordinal', scheme: 'tableau10', domain: ['c', 'a', 'b'] },
			registry,
			null
		);
		colour.setIdentity(new FieldIdentity(['a', 'b', 'c']));

		const tracked = new Map<string, ColorScaleState>();
		trackScalesById([colour], tracked);
		const state = createIdentitySlotState(64);
		packIdentitySlots(
			[...tracked.values()].map((s) => ({ id: s.id, slots: s.slots })),
			state
		);

		// id -> rank: a (id 0) has rank 1, b (id 1) rank 2, c (id 2) rank 0.
		const base = state.offsets.get(colour.id)!;
		const count = state.bufferTo[base];
		expect(Array.from(state.bufferTo.slice(base + 1, base + 1 + count))).toEqual([1, 2, 0]);
	});
});
