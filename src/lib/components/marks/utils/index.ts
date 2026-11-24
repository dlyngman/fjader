export {
	getSourceType,
	processData,
	processAlphaData,
	processColorData,
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
export { buildChannelFieldMap, resolveTip } from './channel-field-map';
export { MarkColor } from './MarkColor.svelte';
export { MarkSize } from './MarkSize.svelte';
export { MarkSeries } from './MarkSeries.svelte';
export { inferMarkScaleType } from './inferMarkScaleType';

export function generateMarkId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

import type { SortConfig, NormalizedSortConfig } from '$lib/types';

export function normalizeSortConfig(sort: SortConfig | null | undefined): NormalizedSortConfig {
	if (!sort) return null;
	for (const axis of ['x', 'y'] as const) {
		if (sort[axis]) {
			return { axis, channel: sort[axis]!, direction: sort.order || 'asc' };
		}
	}
	return null;
}

/**
 * Resolve a sort's `channel` against the mark's channels. The `sort` prop may
 * name a channel (`sort={{ y: 'x' }}`) or a source column
 * (`sort={{ y: 'importance' }}`); the rank transform reads the query's channel
 * aliases, so a column name becomes the channel that reads that column.
 *
 * `fieldMap` is the mark's channel → field map (buildChannelFieldMap): its keys
 * are the channels, its values the columns they read.
 *
 * A channel name wins over a column of the same name. Among channels reading
 * the column, one other than the sorted axis's own is preferred: sorting the
 * y axis by `importance` means by the value drawn from it, not by y itself.
 *
 * Returns `unresolved` when the name is neither a channel nor a column any
 * channel reads; the sort is returned unchanged, and ranks nothing.
 */
export function resolveSortChannel(
	sort: NormalizedSortConfig,
	fieldMap: Record<string, string>
): { sort: NormalizedSortConfig; unresolved: boolean } {
	if (!sort) return { sort, unresolved: false };
	const { channel, axis } = sort;
	if ([channel, `${channel}2`, `${channel}1`].some((c) => c in fieldMap)) {
		return { sort, unresolved: false };
	}
	const readers = Object.keys(fieldMap).filter((ch) => fieldMap[ch] === channel);
	const ownAxis = (ch: string) => ch === axis || ch === `${axis}1` || ch === `${axis}2`;
	const match = readers.find((ch) => !ownAxis(ch)) ?? readers[0];
	return match
		? { sort: { ...sort, channel: match }, unresolved: false }
		: { sort, unresolved: true };
}
