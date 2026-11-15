import { describe, it, expect } from 'vitest';
import { foldReference, foldShader } from './FoldShader';
import {
	normalizeReference,
	normalizeExpr,
	invertExpr,
	type FoldScaleKind
} from './ScaleNormalize';

/** A scale's params as `#writeScaleParam` packs them, from a domain in its own space. */
function params(kind: FoldScaleKind, min: number, max: number, c = 1): Float32Array {
	const t = (v: number) =>
		kind === 'log'
			? Math.log(v)
			: kind === 'symlog'
				? Math.sign(v) * Math.log(1 + Math.abs(v / c))
				: v;
	const lo = t(min);
	const hi = t(max);
	return Float32Array.from([lo, hi, 1 / (hi - lo), kind === 'symlog' ? c : 0]);
}

const values = Float32Array.from([1, 5, 12.5, 40, 99]);

describe('the fold', () => {
	for (const kind of ['linear', 'log', 'symlog'] as const) {
		it(`${kind}: a folded value draws where the old one was drawn`, () => {
			const drawn = params(kind, 1, 100, 2);
			const current = params(kind, 1, 50, 2);
			const out = foldReference(kind, values, drawn, current, new Float32Array(values.length));
			for (let j = 0; j < values.length; j++) {
				// Same normalized position, so the same pixel.
				expect(normalizeReference(kind, out[j], current)).toBeCloseTo(
					normalizeReference(kind, values[j], drawn),
					5
				);
			}
		});

		it(`${kind}: the same domain on both sides leaves values as they are`, () => {
			const p = params(kind, 1, 100, 2);
			const out = foldReference(kind, values, p, p, new Float32Array(values.length));
			for (let j = 0; j < values.length; j++) {
				expect(out[j]).toBeCloseTo(values[j], 3);
			}
		});
	}

	it('halving a linear domain halves the values, which then draw at the same height', () => {
		const out = foldReference(
			'linear',
			Float32Array.from([10, 50, 100]),
			params('linear', 0, 100),
			params('linear', 0, 50),
			new Float32Array(3)
		);
		expect(Array.from(out)).toEqual([5, 25, 50]);
	});

	it('keeps a NaN, and keeps every value when the new domain has no width', () => {
		const out = foldReference(
			'linear',
			Float32Array.from([NaN, 10]),
			params('linear', 0, 100),
			params('linear', 0, 50),
			new Float32Array(2)
		);
		expect(Number.isNaN(out[0])).toBe(true);
		const flat = Float32Array.from([5, 5, 0, 0]);
		const kept = foldReference(
			'linear',
			Float32Array.from([10, 20]),
			params('linear', 0, 100),
			flat,
			new Float32Array(2)
		);
		expect(Array.from(kept)).toEqual([10, 20]);
	});

	it('pastes the expressions the vertex stage draws with', () => {
		// The fold and the draw share their arithmetic as text, not as a copy.
		for (const kind of ['linear', 'log', 'symlog'] as const) {
			const code = foldShader(kind);
			expect(code).toContain(normalizeExpr(kind, 'v', 'drawn'));
			expect(code).toContain(invertExpr(kind, normalizeExpr(kind, 'v', 'drawn'), 'current'));
		}
	});
});
