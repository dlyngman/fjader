/**
 * NaN tests for WGSL that a shader compiler cannot remove.
 *
 * fjader sends nulls to the GPU as NaN. WGSL lets an implementation assume
 * floats are finite, and Apple's Metal compilers act on that: `v != v` and
 * `!(v == v)` can compile to `false`, so a NaN goes undetected. Whether that
 * happens depends on the GPU generation and on the code around the test, so a
 * check that works on one Mac can be gone on another. /test/nan-probe shows
 * what a given GPU does.
 *
 * These test the bit pattern instead: an exponent of all ones and a non-zero
 * mantissa. That is integer arithmetic, which no float assumption touches.
 *
 * `NAN_BITS` is the quiet NaN written wherever a shader needs to produce one.
 * Writing it as bits into a u32 view of the buffer keeps it exact; producing
 * a NaN through float arithmetic is not guaranteed to.
 */

/** The quiet NaN fjader writes, as bits. */
export const NAN_BITS_HEX = '0x7FC00000u';

/**
 * `isNanBits(u)` for a value read through a u32 view, and `isNaN(v)` for one
 * already loaded as f32. Prefer the u32 view where a shader can read the
 * buffer that way: it never loads the NaN as a float at all.
 */
export const NAN_WGSL = /* wgsl */ `
const NAN_BITS: u32 = ${NAN_BITS_HEX};

fn isNanBits(u: u32) -> bool {
	return (u & 0x7fffffffu) > 0x7f800000u;
}

fn isNaN(v: f32) -> bool {
	return isNanBits(bitcast<u32>(v));
}
`;

/**
 * The same test as an expression, for shader libraries that are pasted into
 * other shaders and so cannot define functions those shaders may define too.
 */
export function isNanExpr(f32Expr: string): string {
	return `((bitcast<u32>(${f32Expr}) & 0x7fffffffu) > 0x7f800000u)`;
}
