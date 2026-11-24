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
 * are the channels, its values the columns they read. `categorical` names the
 * mark's categorical channels (band axes, an ordinal colour, a series).
 *
 * A channel name wins over a column of the same name. A column name resolves
 * to a value channel reading it, the first in select order, other than the
 * sorted axis's own: sorting the y axis by `importance` means by the value
 * drawn from it. A categorical channel is never chosen: the query carries its
 * category ids (or, before they arrive, raw values), which rank nothing
 * meaningful when summed. The sorted axis's own channel is the last resort.
 *
 * `problem` says why a name did not resolve: `'unknown'` when no channel reads
 * it, `'categorical'` when only categorical channels do. The sort is then
 * returned unchanged, and ranks nothing.
 */
export function resolveSortChannel(
	sort: NormalizedSortConfig,
	fieldMap: Record<string, string>,
	categorical: ReadonlySet<string> = new Set()
): { sort: NormalizedSortConfig; problem: 'unknown' | 'categorical' | null } {
	if (!sort) return { sort, problem: null };
	const { channel, axis } = sort;
	if ([channel, `${channel}2`, `${channel}1`].some((c) => c in fieldMap)) {
		return { sort, problem: null };
	}
	const readers = Object.keys(fieldMap).filter((ch) => fieldMap[ch] === channel);
	if (readers.length === 0) return { sort, problem: 'unknown' };
	const ownAxis = (ch: string) => ch === axis || ch === `${axis}1` || ch === `${axis}2`;
	const match = readers.find((ch) => !ownAxis(ch) && !categorical.has(ch)) ?? readers.find(ownAxis);
	return match
		? { sort: { ...sort, channel: match }, problem: null }
		: { sort, problem: 'categorical' };
}
