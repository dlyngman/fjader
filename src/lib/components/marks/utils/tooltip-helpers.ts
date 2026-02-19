interface TooltipConfigParams {
	tempTable: string;
	markType: string;
	chartContext: any;
	channelFields: Record<string, string | undefined>;
	columns?: Record<string, any>;
	bandAxes?: { x?: boolean; y?: boolean };
	markColorScaleState: any | null;
}

interface TooltipConfig {
	tempTable: string;
	markType: string;
	scaleTypes: { x: string | undefined; y: string | undefined };
	columns?: Record<string, any>;
	channelFields: Record<string, string | undefined>;
	bandDomains: Record<string, any>;
	colorDomain: any[] | null;
	colorScaleState: any | null;
	enabled: boolean;
}

export function buildTooltipConfig({
	tempTable,
	markType,
	chartContext,
	channelFields,
	columns,
	bandAxes,
	markColorScaleState
}: TooltipConfigParams): TooltipConfig {
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
