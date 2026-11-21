import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';

/**
 * The scale a Legend that names no color shows, from the color scales its
 * chart's marks color by (one per scale, however many channels share it): the
 * one there is, or none when there are several, whose fields `ambiguous` lists
 * for a warning.
 */
export function inferLegendScale(scales: readonly ColorScaleState[]): {
	scale: ColorScaleState | null;
	ambiguous: string[] | null;
} {
	if (scales.length === 1) return { scale: scales[0], ambiguous: null };
	if (scales.length > 1) return { scale: null, ambiguous: scales.map((s) => s.field) };
	return { scale: null, ambiguous: null };
}
