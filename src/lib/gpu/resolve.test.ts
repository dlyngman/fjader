import { describe, it, expect } from 'vitest';
import { resolveReference, RESOLVE_SHADER } from './ResolveShader';

/**
 * The resolve formula, shared by morphing channels and slot tables.
 *
 * It lives in WGSL, where a device is the only thing that can run it, so it is
 * written in JS as well and the shader is asserted against this. These tests pin
 * the JS side; the shader's job is to agree with it.
 */
describe('resolveReference', () => {
	const run = (from: number[], to: number[], t: number) =>
		Array.from(
			resolveReference(
				Float32Array.from(from),
				Float32Array.from(to),
				t,
				from.length,
				new Float32Array(from.length)
			)
		);

	it('interpolates between the two ends', () => {
		expect(run([0, 10, -4], [10, 0, 4], 0.5)).toEqual([5, 5, 0]);
	});

	it('is the identity at t = 1, which is what a settled channel gets', () => {
		// A mark that is not animating publishes t = 1, so the resolve is a copy
		// of `to` rather than a special case the dispatch has to branch on.
		expect(run([0, 10], [7, 3], 1)).toEqual([7, 3]);
	});

	it('is `from` at t = 0', () => {
		expect(run([2, 9], [7, 3], 0)).toEqual([2, 9]);
	});

	describe('NaN', () => {
		// The pipeline encodes SQL NULL as NaN, so a NaN can be on either side of
		// a transition. mix() would propagate it for every t, which means a row
		// that is null in `from` and valid in `to` would never appear — silently,
		// and for good. These pin the decision that it snaps instead.

		it('appears immediately when it had no value before', () => {
			expect(run([NaN, NaN], [5, -2], 0.5)).toEqual([5, -2]);
		});

		it('takes the destination even at t = 0, rather than waiting', () => {
			// If this returned `from` the row would hold NaN for the whole
			// transition and only appear at the end, which reads as a one-frame
			// pop after a pause — worse than snapping in at the start.
			expect(run([NaN], [5], 0)).toEqual([5]);
		});

		it('disappears when it no longer has a value', () => {
			const out = run([5], [NaN], 0.5);
			expect(Number.isNaN(out[0])).toBe(true);
		});

		it('stays absent when it never had a value', () => {
			const out = run([NaN], [NaN], 0.5);
			expect(Number.isNaN(out[0])).toBe(true);
		});

		it('does not let a NaN leak into a neighbouring row', () => {
			// Guards the obvious implementation slip of computing over the whole
			// array at once and letting one NaN poison a vectorised result.
			const out = run([NaN, 0, 10], [1, 10, 0], 0.5);
			expect(out[1]).toBe(5);
			expect(out[2]).toBe(5);
		});
	});

	it('does not write past the row count', () => {
		// The dispatch covers `count` threads; an over-allocated tail is left as
		// it was, so a buffer dump has nothing in it that nobody put there.
		const out = new Float32Array(4).fill(999);
		resolveReference(Float32Array.from([0, 0, 0, 0]), Float32Array.from([1, 1, 1, 1]), 1, 2, out);
		expect(Array.from(out)).toEqual([1, 1, 999, 999]);
	});

	it('the shader computes the same expression from the same inputs', () => {
		// Not a substitute for running it — it cannot be, without a device. It
		// catches the two ways these drift in practice: the NaN test being
		// dropped from one side, and the arguments to mix being swapped.
		expect(RESOLVE_SHADER).toContain('a == b || a != a || b != b');
		expect(RESOLVE_SHADER).toContain('select(mix(a, b, params.t), b, takeTo)');
		expect(RESOLVE_SHADER).toContain('gid.x >= params.count');
		expect(RESOLVE_SHADER).toContain('let j = params.offset + gid.x');
	});

	it('resolves only its own range when given an offset', () => {
		// The slot tables share one buffer, a block per scale, and each block is
		// its own dispatch. Anything outside the range is another scale's, and
		// must come out exactly as it went in.
		const out = new Float32Array(6).fill(999);
		resolveReference(
			Float32Array.from([0, 0, 0, 0, 0, 0]),
			Float32Array.from([8, 8, 8, 8, 8, 8]),
			0.5,
			2,
			out,
			3
		);
		expect(Array.from(out)).toEqual([999, 999, 999, 4, 4, 999]);
	});
});
