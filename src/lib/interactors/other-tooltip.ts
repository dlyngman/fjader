/**
 * The rows an Other bar's tooltip adds: how many categories it holds, and,
 * while a selection reaches into it, how much of it is selected.
 */

import type { OtherRowStats } from '$lib/components/marks/lifecycle/other-rows.svelte';

export interface OtherTooltipRow {
	key: string;
	value: string;
}

/**
 * `format` writes a sum the way the chart writes its value axis. Rows:
 * - categories: "41", or "3 of 41" while a selection is active;
 * - selected: "1,234 of 5,678 (22%)", only while a selection is active.
 * A share that rounds to 0 but is not 0 reads "<1%", so a sliver is not "0%".
 */
export function otherTooltipRows(
	stats: OtherRowStats,
	format: (value: number) => string
): OtherTooltipRow[] {
	const count = String(stats.memberCount);
	if (!stats.active) return [{ key: 'categories', value: count }];
	const percent = stats.total === 0 ? 0 : (100 * stats.picked) / stats.total;
	const rounded = Math.round(percent);
	const share = rounded === 0 && stats.picked > 0 ? '<1%' : `${rounded}%`;
	return [
		{ key: 'categories', value: `${stats.pickedCount} of ${count}` },
		{ key: 'selected', value: `${format(stats.picked)} of ${format(stats.total)} (${share})` }
	];
}
