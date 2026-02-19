/**
 * Build tooltip registration config from mark-specific parameters.
 *
 * Consolidates the structural boilerplate (scaleTypes, bandDomains, colorDomain)
 * while keeping mark-specific fields (channelFields, columns) at the call site.
 * The $effect shell and guard clauses stay in the component.
 *
 * @param {object} params
 * @param {string} params.tempTable - setup.tooltipTableName
 * @param {string} params.markType - 'dot', 'line', 'bary', etc.
 * @param {object} params.chartContext
 * @param {object} params.channelFields - { x: fieldOrDefault, y: fieldOrDefault, color?: ... }
 * @param {object} [params.columns] - Custom column mapping for rect/bar hit testing
 * @param {object} [params.bandAxes] - Which axes to check for band domains, e.g., { x: true, y: true }
 * @param {object|null} params.markColorScaleState - markColor.scaleState
 * @returns {object} Config object for tm.registerMark()
 */
export function buildTooltipConfig({
	tempTable,
	markType,
	chartContext,
	channelFields,
	columns,
	bandAxes,
	markColorScaleState
}) {
	return {
		tempTable,
		markType,
		scaleTypes: {
			x: chartContext.scaleTypes?.x,
			y: chartContext.scaleTypes?.y
		},
		...(columns && { columns }),
		channelFields,
		bandDomains: {
			...(bandAxes?.x &&
				chartContext.scaleTypes?.x === 'band' && {
					x: chartContext.xScaleState?.effectiveDomain
				}),
			...(bandAxes?.y &&
				chartContext.scaleTypes?.y === 'band' && {
					y: chartContext.yScaleState?.effectiveDomain
				})
		},
		colorDomain: markColorScaleState?.isOrdinal ? markColorScaleState?.domain : null,
		colorScaleState: markColorScaleState ?? null,
		enabled: true
	};
}
