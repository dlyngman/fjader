import type { AxisSpec } from '../axes/axis-spec';

/**
 * The height of a facet cell's label (ChartCell's `.facet-label`: a 14px line
 * and 4px padding above and below), at the top of the cell in its top margin.
 */
export const FACET_LABEL_HEIGHT = 22;

/**
 * Whether the chart's y axis draws its title above the plot
 * (`<AxisLeft titlePlacement="top" />`), where a facet label also sits.
 */
export function hasTopYTitle(axes: readonly AxisSpec[]): boolean {
	return axes.some((a) => a.side === 'left' && a.title && a.titlePlacement === 'top');
}
