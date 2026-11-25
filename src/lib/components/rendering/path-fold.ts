import type { RowLayout } from '$lib/components/marks/lifecycle/row-layout';

/**
 * Whether a path renderer's values TRAVEL from one result to the next
 * (BaseGPURenderer.writeMorphed) or are replaced (writeAttribute).
 *
 * They travel on a grid: there, row `i` is the same bin of the same series in
 * every result of one layout, so its old value is where it travels from. A
 * result of another size (a rebin, a series added) is noticed by the morph's
 * own row check and snaps.
 *
 * Runs are replaced. A filter changes which rows a raw line has, so row `i`
 * is another point afterwards; and a decimated line draws from the
 * decimator's buffers, not these. A refused layout draws nothing either way.
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
