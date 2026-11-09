import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ColorScaleState } from './ColorScaleState.svelte';
import type { ScaleRegistry } from './ScaleRegistry.svelte';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';
import { NO_SLOT_TABLE } from '$lib/gpu/ColorScaleShaderLib';

/**
 * The domain fetch and the identity columns arrive in either order. When
 * identity lands after the config was uploaded, the config must be uploaded
 * again with the slot base: otherwise the shader reads ids as palette indices
 * and reads no selection activity, and the scale never dims.
 */
describe('ColorScaleState: identity after the first upload', () => {
	const registry = {
		allocateColorSlot: () => 0,
		allocatePaletteSlot: () => 0,
		allocateRampSlot: () => 0,
		releasePaletteSlot: () => {},
		invalidateChartsUsingScale: () => {},
		chartsUsing: () => ['chart-1']
	} as unknown as ScaleRegistry;

	/** The slot base each full config write carried, in order. */
	let fullWrites: number[];
	/** The slot base each four-byte patch carried, in order. */
	let patches: number[];
	const coordinator = {
		addAnimatedSource: () => {},
		removeAnimatedSource: () => {},
		writeColorConfig: (_slot: number, data: ArrayBufferLike) =>
			fullWrites.push(new Uint32Array(data as ArrayBuffer)[8]),
		writeColorConfigSlotBase: (_slot: number, base: number) => patches.push(base),
		writeColorPalette: () => {},
		writeColorRamp: () => {}
	};

	let warn: ReturnType<typeof vi.spyOn>;
	let log: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		fullWrites = [];
		patches = [];
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		log = vi.spyOn(console, 'log').mockImplementation(() => {});
	});
	afterEach(() => {
		warn.mockRestore();
		log.mockRestore();
	});

	it('uploads the config again with the slot base once identity lands', () => {
		const scale = new ColorScaleState(
			{ field: 'f', type: 'ordinal', scheme: 'tableau10', domain: ['a', 'b', 'c'] },
			registry,
			coordinator as never
		);
		// The packer places the block before identity has landed.
		scale.setSlotBase(3);
		expect(fullWrites.at(-1)).toBe(NO_SLOT_TABLE);

		scale.setIdentity(new FieldIdentity(['a', 'b', 'c'], 'f'));
		expect(fullWrites.at(-1)).toBe(3);
	});

	it('does not upload again when identity was already there', () => {
		const scale = new ColorScaleState(
			{ field: 'f', type: 'ordinal', scheme: 'tableau10', domain: ['a', 'b'] },
			registry,
			coordinator as never
		);
		scale.setIdentity(new FieldIdentity(['a', 'b'], 'f'));
		const writes = fullWrites.length;
		scale.setIdentity(new FieldIdentity(['a', 'b'], 'f'));
		expect(fullWrites.length).toBe(writes);
	});

	it('patches NO_SLOT_TABLE, not its base, while the channel carries palette indices', () => {
		const scale = new ColorScaleState(
			{ field: 'f', type: 'ordinal', scheme: 'tableau10', domain: ['a', 'b'] },
			registry,
			coordinator as never
		);
		scale.setSlotBase(3);
		expect(patches.at(-1)).toBe(NO_SLOT_TABLE);
		expect(scale.identityKey).toBeNull();

		scale.setIdentity(new FieldIdentity(['a', 'b'], 'f'));
		expect(fullWrites.at(-1)).toBe(3);
		expect(scale.identityKey).toBe('f');
		scale.setSlotBase(5);
		expect(patches.at(-1)).toBe(5);
	});

	it('has no identity key for an identity with no values', () => {
		const scale = new ColorScaleState(
			{ field: 'f', type: 'ordinal', scheme: 'tableau10', domain: ['a'] },
			registry,
			coordinator as never
		);
		scale.setIdentity(new FieldIdentity([], 'f'));
		expect(scale.identityKey).toBeNull();
	});

	it('uploads nothing once destroyed: its slots may belong to another scale', () => {
		const scale = new ColorScaleState(
			{ field: 'f', type: 'ordinal', scheme: 'tableau10', domain: ['a', 'b'] },
			registry,
			coordinator as never
		);
		const writes = fullWrites.length;
		scale.destroy();
		scale.setIdentity(new FieldIdentity(['a', 'b'], 'f'));
		expect(fullWrites.length).toBe(writes);
	});

	it('uploads NO_SLOT_TABLE again when a reload empties the identity', () => {
		const scale = new ColorScaleState(
			{ field: 'f', type: 'ordinal', scheme: 'tableau10', domain: ['a', 'b'] },
			registry,
			coordinator as never
		);
		scale.setSlotBase(3);
		scale.setIdentity(new FieldIdentity(['a', 'b'], 'f'));
		expect(fullWrites.at(-1)).toBe(3);
		scale.setIdentity(new FieldIdentity([], 'f'));
		expect(fullWrites.at(-1)).toBe(NO_SLOT_TABLE);
	});
});
