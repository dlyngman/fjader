import type { DataAccessor } from '$lib/data/DataAccessor';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
import type { SizeScaleState } from '$lib/scales/SizeScaleState.svelte';

export interface MarkSetupState {
	data: DataAccessor;
	setColorScale(scale: ColorScaleState): void;
	setSeriesScale(scale: ColorScaleState): void;
	setSizeScale(scale: SizeScaleState): void;
}
