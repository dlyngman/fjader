/**
 * How an area's outline is coloured, and which colour its selection activity
 * is read through.
 *
 * The outline is drawn in the fill's colour, or in a constant `stroke`. Either
 * way its activity is the fill's: the area dims as one shape when a selection
 * on its colour field dims the fill, outline included. Before activity was per
 * field the unselected areas were filtered away, outlines with them; drawn in a
 * constant colour, an outline reading its own colour would read no activity and
 * stay opaque over its dimmed fill.
 */
export interface OutlineColor {
	/** The values the outline's colour buffer holds: the fill's, always. */
	colorValueData: Float32Array | null;
	colorMode: number;
	colorScaleIndex: number;
	activityColorMode: number;
	activityColorScaleIndex: number;
}

export function outlineColor(
	stroke: unknown,
	fill: { data: Float32Array | null; colorMode: number; colorScaleIndex: number }
): OutlineColor {
	const constant = !!stroke;
	return {
		colorValueData: fill.data,
		colorMode: constant ? 0 : fill.colorMode,
		colorScaleIndex: constant ? 0 : fill.colorScaleIndex,
		activityColorMode: fill.colorMode,
		activityColorScaleIndex: fill.colorScaleIndex
	};
}
