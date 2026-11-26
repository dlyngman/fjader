import type { RowLayout } from '$lib/components/marks/lifecycle/row-layout';

/**
 * Whether a path renderer's values TRAVEL from one result to the next
 * (BaseGPURenderer.writeMorphed) or are replaced (writeAttribute).
 *
 * They travel on a grid: there, row `i` is the same bin of the same series in
 * every result of one layout, so its old value is where it travels from.
 *
 * A rebin rides (the mark's RebinSource, `point` geometry): a zoom or a
 * shift+scroll gives other bins, and each new point starts on the old path,
 * interpolated between the old points around it on a split, at the mean of
 * the old points it covers on a merge, one to one over a moved window
 * (bin-remap). Then it travels to its new value. What does not travel, and
 * appears or goes at once:
 * - a gap (a NaN: a mean over no rows, a series a topN left out): a point
 *   next to one has no start, and opens or closes at once (RemapShader,
 *   ResolveShader);
 * - the absent series (id -1) when it is empty, which is left out as NaN;
 * - a new point outside the old rows (a window reaching past them after a
 *   zoom): it has nothing to start from, and starts at its new value;
 * - another layout that is not a rebin (a series added, a topN's top series
 *   changing which series is drawn): the morph's own row check snaps it;
 * - a merge's corners at its first frame: points cannot hold their old
 *   layout through a merge as bars do, so the coarser points start at once
 *   at the mean of what they cover.
 *
 * Runs are replaced. A filter changes which rows a raw line has, so row `i`
 * is another point afterwards; and a decimated line draws from the
 * decimator's buffers, not these. A refused layout draws nothing either way.
 * Past the padding limit a path's result is runs, so a rebin there replaces.
 */
export function foldsBetweenUpdates(layout: RowLayout): boolean {
	return layout.kind === 'grid';
}

/**
 * Whether a write lands at once, not travelling: the first write of a
 * catch-up result's data version (MarkLifecycleV2.landsFor), which arrives
 * with changes nobody watched happen. One per renderer; call once per write.
 * For any renderer that morphs between results (Dots, Lines, Areas), not only
 * the path renderers this file is named for.
 *
 * Plain state, not reactive: only the write effect reads and sets it.
 */
export function landingTracker(): (dataVersion: number, landsFor: number) => boolean {
	let lastWritten = -1;
	return (dataVersion, landsFor) => {
		const first = dataVersion !== lastWritten;
		lastWritten = dataVersion;
		return first && landsFor !== 0 && landsFor === dataVersion;
	};
}
