import { describe, it, expect } from 'vitest';
import { resolveMarkEntry, isColorFieldSpec } from './MarkRegistry';
import type { MarkSpec } from './types';

/**
 * A colour channel with explicit colours is not a FieldSpec: resolving it as
 * one fell through to String(spec), a column called "[object Object]".
 */
describe('colour channel with explicit colours in a spec', () => {
	const won = { field: 'won', domain: [0, 1], range: ['#d62728', '#2ca02c'] };

	it('reaches the mark as the colour prop object', () => {
		const spec = { mark: 'barY', table: 't', x: 'team', y: 'count()', fill: won } as MarkSpec;
		expect(resolveMarkEntry(spec).props.fill).toEqual(won);
	}, 30_000);

	it("passes a line's stroke through the same way", () => {
		const spec = { mark: 'line', table: 't', x: 'x', y: 'y', stroke: won } as MarkSpec;
		expect(resolveMarkEntry(spec).props.stroke).toEqual(won);
	});

	it('is told apart from the FieldSpec object forms', () => {
		expect(isColorFieldSpec(won)).toBe(true);
		expect(isColorFieldSpec({ field: 'won', range: ['red'] })).toBe(true);
		expect(isColorFieldSpec({ aggregate: 'sum', field: 'v' })).toBe(false);
		expect(isColorFieldSpec('won')).toBe(false);
	});
});
