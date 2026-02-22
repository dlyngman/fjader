import type { ChartContext } from '$lib/types';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';

interface TooltipConfigParams {
	tempTable: string;
	markType: string;
	chartContext: ChartContext;
	channelFields: Record<string, string | undefined>;
	columns?: Record<string, unknown>;
	bandAxes?: { x?: boolean; y?: boolean };
	colorColumn?: string;
	markColorScaleState: ColorScaleState | null;
}

interface TooltipConfig {
	tempTable: string;
	markType: string;
	scaleTypes: { x: string | undefined; y: string | undefined };
	columns?: Record<string, unknown>;
	channelFields: Record<string, string | undefined>;
	colorColumn?: string;
	bandDomains: Record<string, string[]>;
	colorDomain: unknown[] | null;
	colorScaleState: ColorScaleState | null;
	enabled: boolean;
}

export function buildTooltipConfig({
	tempTable,
	markType,
	chartContext,
	channelFields,
	columns,
	bandAxes,
	colorColumn,
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
		...(colorColumn && { colorColumn }),
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
