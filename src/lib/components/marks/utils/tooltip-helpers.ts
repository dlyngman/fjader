import type { OtherRowStats } from '$lib/components/marks/lifecycle/other-rows.svelte';
import type { ChartContext } from '$lib/types';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
import type { DimValue } from '$lib/query-engine/categorical-identity';
import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import type { SizeScaleState } from '$lib/scales/SizeScaleState.svelte';

/** Minimal interface for color info needed by tooltip (satisfied by MarkColor). */
interface MarkColorInfo {
	scaleState: ColorScaleState | null;
	constantCssColor: string | null;
}

/** The series scale, for decoding a `z` channel (satisfied by MarkSeries). */
interface MarkSeriesInfo {
	scaleState: ColorScaleState | null;
}

interface TooltipConfigParams {
	tempTable: string;
	markType: string;
	chartContext: ChartContext;
	channelFields: Record<string, string | undefined>;
	columns?: Record<string, unknown>;
	bandAxes?: { x?: boolean; y?: boolean };
	colorColumn?: string;
	markColor: MarkColorInfo;
	/**
	 * A series channel separate from colour — a line's `z` — and its scale. The
	 * channel carries a dim id, and the tooltip decodes it through the scale
	 * exactly as it decodes the colour channel.
	 */
	seriesColumn?: string;
	markSeries?: MarkSeriesInfo;
	proximityAxis?: 'x' | 'y' | 'xy';
	constantRadius?: number;
	sizeScaleState?: SizeScaleState | null;
	displayFields?: string[] | null;
	otherStats?: TooltipConfig['otherStats'];
}

interface TooltipConfig {
	tempTable: string;
	markType: string;
	scaleTypes: { x: string | undefined; y: string | undefined };
	columns?: Record<string, unknown>;
	channelFields: Record<string, string | undefined>;
	colorColumn?: string;
	constantColor?: string;
	/**
	 * Gate only, never a lookup — see TooltipManager's BAND IDENTITY section.
	 * DimValue rather than string because a band axis over a numeric column has
	 * a numeric domain; nothing here reads the elements, but the type should not
	 * claim otherwise.
	 */
	bandDomains: Record<string, DimValue[]>;
	colorDomain: string[] | null;
	colorScaleState: ColorScaleState | null;
	seriesColumn?: string;
	seriesScaleState?: ColorScaleState | null;
	proximityAxis?: 'x' | 'y' | 'xy';
	constantRadius?: number;
	sizeScaleState?: SizeScaleState | null;
	displayFields?: string[] | null;
	otherStats?: (point: Record<string, unknown>) => OtherRowStats | null;
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
	markColor,
	seriesColumn,
	markSeries,
	proximityAxis,
	constantRadius,
	sizeScaleState,
	displayFields,
	otherStats
}: TooltipConfigParams): TooltipConfig {
	const colorScaleState = markColor.scaleState;
	const constantColor = markColor.constantCssColor;
	return {
		tempTable,
		markType,
		scaleTypes: {
			x: chartContext.scaleTypes?.x,
			y: chartContext.scaleTypes?.y
		},
		...(columns && { columns }),
		channelFields,
		...(colorColumn && channelFields[colorColumn] && { colorColumn }),
		...(constantColor && { constantColor }),
		bandDomains: {
			...(bandAxes?.x &&
				chartContext.scaleTypes?.x === 'band' && {
					x: (chartContext.xScaleState as BandScaleState | null)?.effectiveDomain
				}),
			...(bandAxes?.y &&
				chartContext.scaleTypes?.y === 'band' && {
					y: (chartContext.yScaleState as BandScaleState | null)?.effectiveDomain
				})
		},
		colorDomain: colorScaleState?.isOrdinal ? (colorScaleState.domain as string[]) : null,
		colorScaleState: colorScaleState ?? null,
		...(seriesColumn &&
			channelFields[seriesColumn] && {
				seriesColumn,
				seriesScaleState: markSeries?.scaleState ?? null
			}),
		...(proximityAxis && { proximityAxis }),
		...(constantRadius != null && { constantRadius }),
		...(sizeScaleState && { sizeScaleState }),
		...(displayFields && { displayFields }),
		...(otherStats && { otherStats }),
		enabled: true
	};
}
