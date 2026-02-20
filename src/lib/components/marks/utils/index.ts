export {
	getSourceType,
	processData,
	processAlphaData,
	processColorData,
	parseColor,
	buildSelectFromChannels,
	buildConstantsFromChannels
} from './data-processing';

export {
	resolveChannel,
	toFloat32,
	resolveChannelData,
	computeInstanceCount
} from './channel-resolution';
export { buildTooltipConfig } from './tooltip-helpers';
export { MarkColor } from './MarkColor.svelte';
export { MarkSize } from './MarkSize.svelte';
export { MarkSeries } from './MarkSeries.svelte';
export { inferMarkScaleType } from './inferMarkScaleType';

import type { SortConfig, NormalizedSortConfig } from '$lib/types';

export function normalizeSortConfig(sort: SortConfig | null | undefined): NormalizedSortConfig {
	if (!sort) return null;
	for (const axis of ['x', 'y'] as const) {
		if (sort[axis]) {
			return { channel: sort[axis]!, direction: sort.order || 'asc' };
		}
	}
	return null;
}
