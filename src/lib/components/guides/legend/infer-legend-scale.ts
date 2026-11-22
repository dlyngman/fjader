import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
import type { ColorUse } from '$lib/scales/ScaleRegistry.svelte';

/**
 * The scale a Legend that names no color shows, from the color scales its
 * chart's marks color by (one entry per scale, however many channels share
 * it): the one there is, when a column keys it. Otherwise none, with the
 * warning to give: several scales (their fields named once each, so an
 * ordinal and a continuous scale on one field name it once), or one keyed by
 * an expression, whose SQL text is no title and no field to toggle.
 */
export function inferLegendScale(uses: readonly ColorUse[]): {
	scale: ColorScaleState | null;
	warning: string | null;
} {
	if (uses.length === 0) return { scale: null, warning: null };
	if (uses.length > 1) {
		const fields = [...new Set(uses.map((u) => u.scale.field))];
		return {
			scale: null,
			warning:
				`<Legend> names no color and its chart colors by more than one scale ` +
				`(${fields.join(', ')}): name one with color="…".`
		};
	}
	const [{ scale, expression }] = uses;
	if (expression)
		return {
			scale: null,
			warning:
				`<Legend> names no color and its chart colors by an expression ` +
				`(${scale.field}): a legend infers a column only.`
		};
	return { scale, warning: null };
}
