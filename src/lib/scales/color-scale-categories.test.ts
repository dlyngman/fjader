import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ColorScaleState } from './ColorScaleState.svelte';
import type { ScaleRegistry } from './ScaleRegistry.svelte';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';
import { NULL_COLOR_RANK } from '$lib/gpu/ColorScaleShaderLib';

/**
 * The ordinal colour channel's raw-value path, and the cache behind it.
 *
 * An ordinary ordinal colour channel never comes through here: it selects its
 * dim's id column, arrives as a Float32Array and is handed straight to the
 * GPU. This is the degraded path — a field no dim could be built for, or the
 * window before identity lands — which is exactly why its map is built on
 * demand rather than on every palette upload.
 */
describe('ColorScaleState ordinal categories', () => {
	/** Slot allocation is all the constructor asks the registry for. */
	const registry = {
		allocateColorSlot: () => 0,
		allocatePaletteSlot: () => 0,
		allocateRampSlot: () => 0,
		releasePaletteSlot: () => {},
		invalidateChartsUsingScale: () => {}
	} as unknown as ScaleRegistry;

	const ordinal = (domain: (string | number)[]) =>
		// No GPU coordinator: uploads are skipped, which leaves the CPU-side
		// mapping this file is about.
		new ColorScaleState(
			{ field: 'f', type: 'ordinal', scheme: 'tableau10', domain },
			registry,
			null
		);

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

	it('maps raw values to their position in the domain', () => {
		const scale = ordinal(['a', 'b', 'c']);
		expect(Array.from(scale.processDataForGPU(['c', 'a', 'b']))).toEqual([2, 0, 1]);
	});

	it('reports an unknown value and a null as the absent sentinel', () => {
		const scale = ordinal(['a', 'b']);
		expect(Array.from(scale.processDataForGPU(['a', 'zzz', null]))).toEqual([0, -1, -1]);
	});

	it('follows the domain when it changes, which the cache must not outlive', () => {
		// The map is built on demand and keyed on the domain array. Every writer
		// assigns a fresh one, so this is what proves the key is exact.
		const scale = ordinal(['a', 'b', 'c']);
		expect(Array.from(scale.processDataForGPU(['a', 'c']))).toEqual([0, 2]);

		scale.setDomain(['c', 'b', 'a']);
		expect(Array.from(scale.processDataForGPU(['a', 'c']))).toEqual([2, 0]);
	});

	it('does not adopt the caller’s domain array', () => {
		// The cache keys on the array's identity, so the scale has to own it:
		// a config array mutated by its owner would otherwise change the domain
		// without changing the reference.
		const given: (string | number)[] = ['a', 'b'];
		const scale = ordinal(given);
		given.push('c');
		expect(scale.domain).toEqual(['a', 'b']);
	});

	it('passes a Float32Array of ids straight through, untouched', () => {
		// The path every real ordinal colour channel takes. Same object, not a
		// copy: the query already produced GPU-ready floats.
		const scale = ordinal(['a', 'b']);
		const ids = new Float32Array([1, 0, 1]);
		expect(scale.processDataForGPU(ids)).toBe(ids);
	});

	it('gives an Other bucket the null-colour rank, not a palette slot', () => {
		// Colour on the band's own field: the Other row carries the bucket's id in
		// the colour channel. A bucket is not a category, so it takes no palette
		// slot and shifts no category's colour; it draws grey, like a null.
		const identity = new FieldIdentity();
		identity.reset(['a', 'b', 'Other'], [2]);
		const scale = ordinal(['a', 'b']);
		scale.setIdentity(identity);

		const ranks = Array.from(scale.slots.to as Float32Array);
		expect(ranks[0]).toBeGreaterThanOrEqual(0);
		expect(ranks[1]).toBeGreaterThanOrEqual(0);
		expect(ranks[2]).toBe(NULL_COLOR_RANK);
	});

	it('gives the NULL category the null-colour rank, not a palette slot', () => {
		// NULL is a category on the axis and in the legend, but it reads as missing
		// data: it takes no palette slot and shifts no other category's colour.
		const identity = new FieldIdentity(['a', null, 'b']);
		expect(identity.nullId).toBe(1);
		const scale = ordinal(['a', null as unknown as string, 'b']);
		scale.setIdentity(identity);

		const ranks = Array.from(scale.slots.to as Float32Array);
		expect(ranks[1]).toBe(NULL_COLOR_RANK);
		// 'a' and 'b' rank 0 and 1: NULL left no gap between them.
		expect([ranks[0], ranks[2]].sort()).toEqual([0, 1]);
	});

	it('extends its rank table when the identity grows, so a later Other is not transparent', () => {
		// The rank table was built before the bucket existed; another chart's
		// acquire appends the bucket's id to the same live identity.
		const identity = new FieldIdentity();
		identity.reset(['a', 'b']);
		const scale = ordinal(['a', 'b']);
		scale.setIdentity(identity);
		expect(scale.slots.to.length).toBe(2);

		identity.reset(['a', 'b', 'Other'], [2]);
		const ranks = Array.from(scale.slots.to as Float32Array);
		expect(ranks).toHaveLength(3);
		expect(ranks[2]).toBe(NULL_COLOR_RANK);
	});

	it('gives the legend the colour the bar draws: grey for NULL, the palette for the rest', () => {
		const identity = new FieldIdentity(['a', null, 'b']);
		const scale = ordinal(['a', null as unknown as string, 'b']);
		scale.setIdentity(identity);
		expect(scale.getColor(null)).toBe(ColorScaleState.NULL_COLOR);
		expect(scale.getColor('a')).not.toBe(ColorScaleState.NULL_COLOR);
		expect(scale.getColor('b')).not.toBe(scale.getColor('a'));
	});
});
