/**
 * The WGSL immediates capability, and one place to ask about it.
 *
 * The resolve kernel declares `requires immediate_address_space`, and every
 * band and point axis and every ordinal colour scale depends on it to resolve
 * its slots, as well as every mark that animates its channels. So the feature
 * is not an optimisation the library can quietly do without — it is a floor.
 *
 * That floor is a deliberate choice rather than an oversight. Immediates are
 * pass state set in command order, which is what lets one compute pass resolve
 * several channels or slot blocks with a different `count` and `t` for each; a uniform
 * rewritten between dispatches hands every dispatch the last write. The
 * alternative is a buffer and a binding per channel, and the point of the
 * resolve is that an animated channel REPLACES a vertex binding rather than
 * adding one.
 *
 * What this module is for is the other half of that decision: failing where it
 * can be read. Without a check, a browser that lacks the feature compiles a
 * shader module that names it, gets an invalid pipeline, poisons the encoder
 * that dispatches with it, and shows an empty canvas plus a validation error
 * naming a WGSL feature. Nothing in that names the requirement.
 */

/** The WGSL language feature the resolve kernel declares. */
export const IMMEDIATES_FEATURE = 'immediate_address_space';

/**
 * Whether this browser can run the resolve kernels.
 *
 * Asked at device init, where it is fatal, and by `MorphedChannels`, which
 * degrades to static channels rather than failing. Both ask here so the
 * feature string is written once.
 */
export function immediatesSupported(): boolean {
	return (
		typeof navigator !== 'undefined' &&
		!!navigator.gpu?.wgslLanguageFeatures?.has(IMMEDIATES_FEATURE)
	);
}

/**
 * What to say when it is missing. Names the requirement and where it comes
 * from, because the browser's own error names only the WGSL feature.
 */
export const IMMEDIATES_MISSING_MESSAGE =
	`This browser's WebGPU implementation does not support the WGSL ` +
	`"${IMMEDIATES_FEATURE}" feature, which Fjader requires: categorical axes ` +
	`resolve their positions in a compute pass that uses it. Chrome 149 or later ` +
	`supports it. Without it nothing renders, so this fails here rather than ` +
	`leaving an empty canvas and a shader validation error to be diagnosed.`;
