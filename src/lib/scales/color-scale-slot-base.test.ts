import { describe, it, expect } from 'vitest';
import { ColorScaleState } from './ColorScaleState.svelte';
import type { ScaleRegistry } from './ScaleRegistry.svelte';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';

/**
 * Where an ordinal colour scale's slot-table base is written, and when it is
 * not written at all.
 *
 * This lived in the coordinator's per-frame packer loop, which reached into
 * the scale for its config slot and did the byte arithmetic itself — so it was
 * reachable only through a real WebGPU device and nothing asserted on it. The
 * decision is the scale's now, and the coordinator owns only the buffer, which
 * is what makes these assertions possible at all.
 */
describe('ColorScaleState slot base', () => {
	const registry = {
		allocateColorSlot: () => 3,
		allocatePaletteSlot: () => 0,
		allocateRampSlot: () => 0,
		releasePaletteSlot: () => {},
		invalidateChartsUsingScale: () => {}
	} as unknown as ScaleRegistry;

	function scaleWithSpy() {
		const writes: Array<{ slot: number; base: number }> = [];
		const coordinator = {
			writeColorConfigSlotBase: (slot: number, base: number) => writes.push({ slot, base }),
			writeColorConfig: () => {},
			writeColorRamp: () => {},
			writeColorPalette: () => {}
		} as unknown as GPUCoordinator;
		const scale = new ColorScaleState(
			{ field: 'f', type: 'ordinal', scheme: 'tableau10', domain: ['a', 'b'] },
			registry,
			coordinator
		);
		// With identity, so its channel carries ids and its config reads the slot
		// table; without it the patch is NO_SLOT_TABLE (see
		// color-scale-identity-upload.test.ts).
		scale.setIdentity(new FieldIdentity(['a', 'b'], 'f'));
		return { scale, writes };
	}

	it('patches its own config when the packer gives it a base', () => {
		const { scale, writes } = scaleWithSpy();
		scale.setSlotBase(12);
		expect(writes).toEqual([{ slot: 3, base: 12 }]);
	});

	it('writes nothing while the base has not moved, which is every frame', () => {
		const { scale, writes } = scaleWithSpy();
		// The packer calls this on every frame it runs, not only on a change.
		for (let i = 0; i < 10; i++) scale.setSlotBase(12);
		expect(writes).toEqual([{ slot: 3, base: 12 }]);

		scale.setSlotBase(40);
		expect(writes).toEqual([
			{ slot: 3, base: 12 },
			{ slot: 3, base: 40 }
		]);
	});

	it('patches a REBUILT instance handed the base it had before', () => {
		// The hazard the old instance-keyed WeakMap existed for. A chart that
		// unmounts and remounts is a new object with the same scale id, and the
		// packer — a deterministic running sum — hands that id the same base. A
		// cache keyed on the id would call this delivered and skip it, leaving
		// the base at -1, which is written as NO_SLOT_TABLE: the shader then
		// reads the channel's dim id as a palette index. Wrong colours, silently.
		const first = scaleWithSpy();
		first.scale.setSlotBase(12);

		const remounted = scaleWithSpy();
		remounted.scale.setSlotBase(12);

		expect(remounted.writes).toEqual([{ slot: 3, base: 12 }]);
	});

	it('patches nothing before a config slot exists', () => {
		const writes: Array<{ slot: number; base: number }> = [];
		const scale = new ColorScaleState(
			{ field: 'f', type: 'ordinal', scheme: 'tableau10', domain: ['a', 'b'] },
			{ ...registry, allocateColorSlot: () => -1 } as unknown as ScaleRegistry,
			{
				writeColorConfigSlotBase: (slot: number, base: number) => writes.push({ slot, base }),
				writeColorConfig: () => {},
				writeColorRamp: () => {},
				writeColorPalette: () => {}
			} as unknown as GPUCoordinator
		);
		scale.setSlotBase(12);
		// Nothing to patch yet; whichever upload path claims a slot writes the
		// base with the rest of the struct.
		expect(writes).toEqual([]);
	});
});
