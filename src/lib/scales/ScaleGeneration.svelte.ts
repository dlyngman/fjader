/**
 * Counts replacements of a chart's x and y scales: a defined scale id giving
 * way to a different one, as a relabelled axis or a re-resolved scale type
 * does. Marks rebuild their lifecycle on it.
 *
 * Not the ids themselves, which marks tracked before: a mark's own lifecycle
 * registers the scale requirements that make the scales resolve, so the ids
 * went from undefined to defined right after every mark was built, and every
 * lifecycle was rebuilt once for nothing (its scale registration redone, and a
 * tooltip-table DROP sent to DuckDB). The first resolution is not a change.
 *
 * Owned by the chart, not by ChartScales: the container recreates its
 * ChartScales when a label or the layout changes, and a counter on that
 * instance would restart and miss the swap. A recreated ChartScales is itself
 * a replacement: it starts with no scale requirements (the container replays
 * only those queued before the first one existed), so marks must rebuild to
 * register with it. Its first resolution after that is not counted again.
 */
import type { ChartScales } from './ChartScales.svelte';

/** The ChartScales and last defined ids seen, and the replacements counted so far. */
export interface ScaleIds {
	owner: unknown;
	x: string | undefined;
	y: string | undefined;
	count: number;
}

/**
 * Fold the current ChartScales and ids into `seen`. Counts a replacement when
 * the ChartScales itself is a different one than before (it then forgets the
 * ids: the new one's first resolution is part of the same replacement), or
 * when an axis that had a defined id now has a different defined one.
 * Undefined is neither a change nor remembered. Mutates and returns `seen`.
 */
export function foldScaleIds(
	seen: ScaleIds,
	owner: unknown,
	x: string | undefined,
	y: string | undefined
): ScaleIds {
	if (owner && seen.owner && owner !== seen.owner) {
		seen.count++;
		seen.x = seen.y = undefined;
	}
	if (owner) seen.owner = owner;
	if ((x && seen.x && x !== seen.x) || (y && seen.y && y !== seen.y)) seen.count++;
	if (x) seen.x = x;
	if (y) seen.y = y;
	return seen;
}

export class ScaleGeneration {
	#scales: () => ChartScales | null | undefined;
	#seen: ScaleIds = { owner: undefined, x: undefined, y: undefined, count: 0 };

	constructor(scales: () => ChartScales | null | undefined) {
		this.#scales = scales;
	}

	/**
	 * Replacements so far. Reactive: reads the chart's current ChartScales and
	 * scale ids. The derived updates `#seen` as it computes, which is safe only
	 * because folding the same input twice changes nothing: a recompute that
	 * sees unchanged ids counts nothing. Reads skipped between changes can
	 * merge two replacements into one count, which is fine: marks only need to
	 * know that it changed (a recreated scale has a new id, so a scale that
	 * goes away and returns is still seen as different).
	 */
	value: number = $derived.by(() => {
		const scales = this.#scales();
		return foldScaleIds(this.#seen, scales, scales?.xScaleState?.id, scales?.yScaleState?.id).count;
	});
}
