/**
 * Whether a mark's morph work runs on this frame: when one of its charts
 * draws in it. A resolve nobody draws is work for nothing, and a mark at rest
 * on a chart at rest was still asked on every frame any chart drew.
 *
 * What it puts off is caught up on the frame that next draws the chart: the
 * fold copies what is on screen then, the resolve runs at the clock's value
 * then, and a rest is noticed then.
 *
 * `charts` is asked every frame, not kept: a facet grid registers its cells
 * after the mark's first data has landed. A mark that names no chart at all
 * runs on every frame, as before: there is nothing to wait for, and it must
 * not be left waiting for good.
 */
export function drawsThisFrame(
	charts: readonly string[],
	registered: ReadonlyMap<string, { readonly _lastRenderFrame: number }>,
	frameId: number
): boolean {
	if (charts.length === 0) return true;
	for (let i = 0; i < charts.length; i++) {
		if (registered.get(charts[i])?._lastRenderFrame === frameId) return true;
	}
	return false;
}
