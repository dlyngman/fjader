/**
 * Which selection activities a mark reads: its ordinal colour, its band x,
 * its band y, and a line's or area's series. One answer per renderer, used
 * twice:
 *
 * - The renderer builds its shader's `markActivity` call from it, so a read
 *   the table does not list is passed as 1.0 and cannot happen.
 * - MarkLifecycleV2 turns it into the mark's `reads`, the identity keys of the
 *   fields it dims by, which decide whether a categorical selection on a field
 *   dims the mark or filters it.
 *
 * The two must agree exactly. A mark routed to dim on a field its shader does
 * not read would be neither dimmed nor filtered; one whose shader reads a field
 * routing missed would be filtered and dimmed at once. Deriving both from this
 * table is what keeps them together. One case they still disagree on: a field
 * whose activity block did not fit in the identity slot buffer (see the known
 * limit in identity-slot-packing.ts).
 *
 * A function of the config, not a constant per renderer, because a rule's
 * answer depends on a prop: a rule without an extent spans the whole cross
 * axis, belongs to no category on it, and must not dim by it.
 */

import { NO_GROUP } from '$lib/gpu/identity-slot-packing';

/** The renderers that read selection activity. Text reads it on the CPU. */
export type ActivityRenderer =
	| 'dots'
	| 'rects'
	| 'rulex'
	| 'ruley'
	| 'lines'
	| 'areas'
	| 'parallel'
	| 'text';

export interface ActivityReads {
	readonly color: boolean;
	readonly x: boolean;
	readonly y: boolean;
	/** A line's or area's `z`: the series field when it is not the colour field. */
	readonly series: boolean;
}

const ALL: ActivityReads = { color: true, x: true, y: true, series: false };
const CONNECTED: ActivityReads = { color: true, x: false, y: false, series: true };
const COLOR_ONLY: ActivityReads = { color: true, x: false, y: false, series: false };

/**
 * What a renderer reads. `hasExtent` is a rule's: RuleX with y1/y2, RuleY with
 * x1/x2. Lines and areas dim by colour and by series (`z`), never by a band
 * axis: a line over a band axis spans its categories. Parallel coordinates
 * have no `z` and dim by colour only.
 */
export function activityReads(renderer: ActivityRenderer, hasExtent = false): ActivityReads {
	switch (renderer) {
		case 'dots':
		case 'rects':
		case 'text':
			return ALL;
		case 'rulex':
			return { color: true, x: true, y: hasExtent, series: false };
		case 'ruley':
			return { color: true, x: hasExtent, y: true, series: false };
		case 'lines':
		case 'areas':
			return CONNECTED;
		case 'parallel':
			return COLOR_ONLY;
	}
}

/**
 * Whether a rule spans an extent on its cross axis: both ends given, as a
 * field or a constant. A rule mark builds its renderer's extent data from this
 * and hands it to routing as `ruleExtent`, so the two cannot disagree; a
 * constant end (y1={0}, or the y shorthand) counts like a field.
 */
export function ruleHasExtent(lo: unknown, hi: unknown): boolean {
	return lo !== undefined && hi !== undefined;
}

/** The renderer a mark type draws with, or null for one that reads no activity. */
export function rendererForMark(markType: string): ActivityRenderer | null {
	switch (markType) {
		case 'dot':
			return 'dots';
		case 'bary':
		case 'barx':
		case 'rect':
		case 'rectx':
		case 'recty':
			return 'rects';
		case 'rulex':
			return 'rulex';
		case 'ruley':
			return 'ruley';
		case 'line':
			return 'lines';
		case 'areax':
		case 'areay':
			return 'areas';
		case 'parallel':
			return 'parallel';
		case 'text':
			return 'text';
		default:
			return null;
	}
}

/**
 * A mark's reads: the identity keys of the fields whose activity it reads,
 * sorted, from what its renderer reads and the identity key of each of its
 * categorical scales (null for a channel with no such scale, or a scale with
 * no identity: a field with no identity has no activity to dim by, so a
 * selection on it filters the mark). `series` is null unless the mark has a
 * `z` of its own; a series that is the colour field is already in `color`.
 */
export function readsFor(
	reads: ActivityReads,
	keys: { color: string | null; x: string | null; y: string | null; series?: string | null }
): readonly string[] {
	const out: string[] = [];
	if (reads.color && keys.color) out.push(keys.color);
	if (reads.x && keys.x) out.push(keys.x);
	if (reads.y && keys.y) out.push(keys.y);
	if (reads.series && keys.series) out.push(keys.series);
	if (out.length === 0) return NO_READS;
	return [...new Set(out)].sort();
}

/** A mark that reads no activity. Shared, so its reads never look changed. */
export const NO_READS: readonly string[] = [];

/**
 * How a mark responds to selections in its filter group (the `selectionResponse`
 * prop). 'auto', the default: a categorical selection on a field the mark draws
 * by (its band axes, its ordinal colour) dims it, and any other selection
 * filters it. 'filter': every selection filters it, even on a field it draws
 * by, so its aggregates are recomputed for the subset (top N within a region).
 */
export type SelectionResponse = 'auto' | 'filter';

export { NO_GROUP };

/** A mark's reads under its selection response: none for 'filter', which never dims. */
export function readsForResponse(
	response: SelectionResponse | undefined,
	reads: readonly string[]
): readonly string[] {
	return response === 'filter' ? NO_READS : reads;
}

/** The group index a mark's shader reads activity with: NO_GROUP for 'filter'. */
export function groupIndexForResponse(
	response: SelectionResponse | undefined,
	groupIndex: number
): number {
	return response === 'filter' ? NO_GROUP : groupIndex;
}

/**
 * The WGSL activity of a renderer that reads no band axis (lines, areas,
 * parallel coordinates): its colour activity and, for lines and areas, its
 * series activity, 1.0 for each the table says it does not read.
 *
 * `series` is markColorActivity's first three arguments for the series scale,
 * the same lookup as colour on another scale and buffer. The mark passes mode
 * 0 when it has no `z` of its own, so the read returns 1.0 before loading
 * anything. The two combine by `min`, the least active wins, as in
 * markActivity: a series on the colour field cannot dim twice.
 *
 * Throws for a renderer that reads a band axis, whose call is
 * markActivityWGSL, and for one that reads a series it was given no
 * arguments for.
 */
export function connectedActivityWGSL(
	reads: ActivityReads,
	args: { color: string; series?: string; group: string }
): string {
	if (reads.x || reads.y) throw new Error('connectedActivityWGSL: this renderer reads a band axis');
	if (reads.series && !args.series) {
		throw new Error('connectedActivityWGSL: this renderer reads a series; pass its arguments');
	}
	const color = reads.color ? `markColorActivity(${args.color}, ${args.group})` : '1.0';
	if (!reads.series) return color;
	return `min(${color}, markColorActivity(${args.series}, ${args.group}))`;
}

/**
 * The WGSL `markActivity(...)` call for `reads`: each activity the renderer
 * reads, and 1.0 for each it does not. `color` is markColorActivity's first
 * three arguments; `x` and `y` are the band channel values; `group` the mark's
 * group index.
 */
/**
 * The activity of an Other row: the same terms as markActivityWGSL without the
 * band axes', and without colour's when colour is the band's own field
 * (`skipColor`, a WGSL bool). Those read the Other bucket's own fade, and the
 * bar's split already shows how much of it is selected (Rects); multiplying
 * them in as well would dim it twice. Activity on any other field stays.
 */
export function otherRowActivityWGSL(
	reads: ActivityReads,
	args: { color: string; group: string; skipColor: string }
): string {
	const color = reads.color
		? `select(markColorActivity(${args.color}, ${args.group}), 1.0, ${args.skipColor})`
		: '1.0';
	return `markActivity(${color}, 1.0, 1.0)`;
}

export function markActivityWGSL(
	reads: ActivityReads,
	args: { color: string; x: string; y: string; group: string }
): string {
	const color = reads.color ? `markColorActivity(${args.color}, ${args.group})` : '1.0';
	const x = reads.x ? `bandActivityX(${args.x}, ${args.group})` : '1.0';
	const y = reads.y ? `bandActivityY(${args.y}, ${args.group})` : '1.0';
	return `markActivity(${color}, ${x}, ${y})`;
}
