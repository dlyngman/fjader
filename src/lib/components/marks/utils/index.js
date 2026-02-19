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
export { MarkColor } from './MarkColor.svelte.js';
export { MarkSize } from './MarkSize.svelte.js';
export { MarkSeries } from './MarkSeries.svelte.js';
export { inferMarkScaleType } from './inferMarkScaleType';

/**
 * Normalize user-facing sort prop to internal config shape.
 * @param {{ x?: string, y?: string, order?: 'asc' | 'desc' } | null} sort
 * @returns {{ channel: string, direction: 'asc' | 'desc' } | null}
 * @example normalizeSortConfig({ y: "x1" }) → { channel: "x1", direction: "asc" }
 * @example normalizeSortConfig({ y: "x", order: "desc" }) → { channel: "x", direction: "desc" }
 */
export function normalizeSortConfig(sort) {
	if (!sort) return null;
	for (const axis of ['x', 'y']) {
		if (sort[axis]) {
			return { channel: sort[axis], direction: sort.order || 'asc' };
		}
	}
	return null;
}
