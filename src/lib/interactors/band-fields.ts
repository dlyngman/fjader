import { BandScaleState } from '$lib/scales/BandScaleState.svelte';

/**
 * The fields a Toggle's band labels toggle: each band axis's field, once,
 * without the field the Toggle already declares.
 *
 * Read from the axes' scale instances rather than the chart's `scaleTypes`.
 * While a mark re-runs setup its axis can briefly have no requirements:
 * `scaleTypes` then falls back to linear while the band scale instance stays.
 * A list on `scaleTypes` would drop the field in that gap, and with it the
 * label selection.
 */
export function bandFieldsOf(axisScales: unknown[], declaredField: string | null): string[] {
	const out: string[] = [];
	for (const scale of axisScales) {
		if (!(scale instanceof BandScaleState)) continue;
		const field = scale.sourceField;
		if (field !== declaredField && !out.includes(field)) out.push(field);
	}
	return out;
}
