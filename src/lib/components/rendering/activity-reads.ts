/**
 * Which selection activities a mark reads: its ordinal colour, its band x,
 * its band y. One answer per renderer, used twice:
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
 * table is what keeps them together.
 *
 * A function of the config, not a constant per renderer, because a rule's
 * answer depends on a prop: a rule without an extent spans the whole cross
 * axis, belongs to no category on it, and must not dim by it.
 */

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
}

const ALL: ActivityReads = { color: true, x: true, y: true };
const COLOR_ONLY: ActivityReads = { color: true, x: false, y: false };

/**
 * What a renderer reads. `hasExtent` is a rule's: RuleX with y1/y2, RuleY with
 * x1/x2. Lines, areas and parallel coordinates dim by colour only: a line over
 * a band axis spans its categories.
 */
export function activityReads(renderer: ActivityRenderer, hasExtent = false): ActivityReads {
	switch (renderer) {
		case 'dots':
		case 'rects':
		case 'text':
			return ALL;
		case 'rulex':
			return { color: true, x: true, y: hasExtent };
		case 'ruley':
			return { color: true, x: hasExtent, y: true };
		case 'lines':
		case 'areas':
		case 'parallel':
			return COLOR_ONLY;
	}
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
 * The WGSL `markActivity(...)` call for `reads`: each activity the renderer
 * reads, and 1.0 for each it does not. `color` is markColorActivity's first
 * three arguments; `x` and `y` are the band channel values; `group` the mark's
 * group index.
 */
export function markActivityWGSL(
	reads: ActivityReads,
	args: { color: string; x: string; y: string; group: string }
): string {
	const color = reads.color ? `markColorActivity(${args.color}, ${args.group})` : '1.0';
	const x = reads.x ? `bandActivityX(${args.x}, ${args.group})` : '1.0';
	const y = reads.y ? `bandActivityY(${args.y}, ${args.group})` : '1.0';
	return `markActivity(${color}, ${x}, ${y})`;
}
