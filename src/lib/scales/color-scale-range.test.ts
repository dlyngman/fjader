import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ColorScaleState } from './ColorScaleState.svelte';
import type { ScaleRegistry } from './ScaleRegistry.svelte';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';
import type { DimValue } from '$lib/query-engine/categorical-identity';
import { NULL_COLOR_RANK } from '$lib/gpu/ColorScaleShaderLib';
import type { ColorDomainValue } from '$lib/types';

/**
 * Explicit ordinal colours: `range` replaces the scheme's palette, and `domain`
 * pins values to its positions. The GPU reads the rank table, the legend and
 * tooltip read getColor, so both are checked for the same mapping.
 */
describe('ColorScaleState explicit range and pinned domain', () => {
	const registry = {
		allocateColorSlot: () => 0,
		allocatePaletteSlot: () => 0,
		allocateRampSlot: () => 0,
		releasePaletteSlot: () => {},
		invalidateChartsUsingScale: () => {}
	} as unknown as ScaleRegistry;

	const RED = '#d62728';
	const GREEN = '#2ca02c';

	function scale(
		domain: (string | number)[],
		range?: string[],
		pinnedDomain?: ColorDomainValue[]
	): ColorScaleState {
		return new ColorScaleState(
			{ field: 'f', type: 'ordinal', scheme: 'tableau10', domain, range, pinnedDomain },
			registry,
			null
		);
	}

	/** Rank per id, as the shader reads it. */
	const ranks = (s: ColorScaleState) => Array.from(s.slots.to);

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

	it('pins each value to its colour whatever order the data arrives in', () => {
		// The data domain and the dim both list 1 before 0.
		const s = scale([1, 0], [RED, GREEN], [0, 1]);
		s.setIdentity(new FieldIdentity([1, 0]));
		expect(ranks(s)).toEqual([1, 0]);
		expect(s.getColor(0)).toBe(RED);
		expect(s.getColor(1)).toBe(GREEN);
	});

	it('matches a pinned value by its string form when the types differ', () => {
		// A BIGINT dim holds bigints; JSON from Python can bring '1' for 1.
		const s = scale([0, 1], [RED, GREEN], ['1', 0]);
		s.setIdentity(new FieldIdentity([0n, 1n] as unknown as DimValue[]));
		expect(ranks(s)).toEqual([1, 0]);
	});

	it('draws values outside the pinned domain in the null colour', () => {
		const s = scale(['a', 'b', 'c'], [RED, GREEN], ['a', 'b']);
		s.setIdentity(new FieldIdentity(['a', 'b', 'c']));
		expect(ranks(s)).toEqual([0, 1, NULL_COLOR_RANK]);
		expect(s.getColor('c')).toBe(ColorScaleState.NULL_COLOR);
	});

	it('reserves the rank of a pinned value the data does not have yet', () => {
		const s = scale(['b'], [RED, GREEN], ['a', 'b']);
		s.setIdentity(new FieldIdentity(['b']));
		expect(ranks(s)).toEqual([1]);
		expect(s.getColor('b')).toBe(GREEN);
	});

	it('gives a pinned null a palette colour instead of the null colour', () => {
		const s = scale(['a', 'b'], [RED, GREEN, '#000000'], ['a', 'b', null]);
		s.setIdentity(new FieldIdentity(['a', null, 'b']));
		expect(ranks(s)).toEqual([0, 2, 1]);
		expect(s.getColor(null)).toBe('#000000');
	});

	it('uses a range alone as the palette, in domain order', () => {
		const s = scale(['x', 'y'], [RED, GREEN]);
		s.setIdentity(new FieldIdentity(['x', 'y']));
		expect(ranks(s)).toEqual([0, 1]);
		expect(s.getColor('x')).toBe(RED);
		expect(s.getColor('y')).toBe(GREEN);
	});

	it("pins a domain alone to the scheme's colours", () => {
		const s = scale(['x', 'y'], undefined, ['y', 'x']);
		s.setIdentity(new FieldIdentity(['x', 'y']));
		expect(ranks(s)).toEqual([1, 0]);
		const tableau = scale(['y', 'x']);
		tableau.setIdentity(new FieldIdentity(['y', 'x']));
		expect(s.getColor('y')).toBe(tableau.getColor('y'));
	});

	it('re-ranks when the mapping changes, and returns to domain order when cleared', () => {
		const s = scale(['a', 'b'], [RED, GREEN], ['a', 'b']);
		s.setIdentity(new FieldIdentity(['a', 'b']));
		s.setRange([RED, GREEN], ['b', 'a']);
		expect(ranks(s)).toEqual([1, 0]);
		expect(s.getColor('b')).toBe(RED);
		s.setRange(null, null);
		expect(s.range).toBeNull();
		expect(ranks(s)).toEqual([0, 1]);
	});

	it('maps raw values by pinned position before identity lands', () => {
		const s = scale([1, 0], [RED, GREEN], [0, 1]);
		expect(Array.from(s.processDataForGPU([1, 0, 2]))).toEqual([1, 0, -1]);
	});
});
