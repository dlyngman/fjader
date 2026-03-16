import type { FieldInfoEntry } from '$lib/data/DataClient.svelte';
import type { DataAccessor } from '$lib/data/DataAccessor';
import type { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import type { TimeScaleState } from '$lib/scales/TimeScaleState.svelte';
import type { ScaleStateInstance, ContinuousScaleState } from '$lib/types';
import {
	isContinuousScale,
	isNumericScale,
	isCategoricalScale,
	isTemporalScale
} from '$lib/scales/scale-categories';
import { isBinExpression } from '$lib/sql/bin';
import { computeExtentFromData, extractCategoriesFromData } from './domain-computation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisterDomainsResult {
	dataDerivedDomainsSet: boolean;
	skipDomainUpdateForAxis: string | null;
}

// ---------------------------------------------------------------------------
// Pure functions — operate on passed-in scale objects, no instance state
// ---------------------------------------------------------------------------

/**
 * Mark scales as ready after categorical/sidecar domain fetches complete.
 * Categorical and temporal scales are marked ready immediately.
 * Continuous scales are only marked ready if they don't need data-derived
 * domains, or if those domains have already been set.
 */
export function setScalesReady(
	scaleMap: Record<string, ScaleStateInstance | null>,
	channelsNeedingDataDomain: Set<string>,
	actualXScaleType: string,
	actualYScaleType: string,
	globalAggregatesSet: boolean,
	dataDerivedDomainsSet: boolean
): void {
	for (const [axis, scale] of Object.entries(scaleMap)) {
		if (!scale) continue;

		const scaleType = axis === 'x' ? actualXScaleType : actualYScaleType;
		const needsDataDomain = channelsNeedingDataDomain.has(axis);

		// For categorical scales (band/point) and time scales, mark ready immediately
		// (their domains are set by sidecar queries in fetchCategoricalDomains)
		if (isCategoricalScale(scaleType) || isTemporalScale(scaleType)) {
			scale.setReady();
			continue;
		}

		// For linear scales, only mark ready if they don't need data-derived domain
		// OR if domains have been set (either via sidecar query OR data-scan fallback)
		const domainsReady = globalAggregatesSet || dataDerivedDomainsSet;
		if (!needsDataDomain || domainsReady) {
			scale.setReady();
		} else {
			console.log(`⏳ [${axis}] Deferring scale ready - waiting for domain`);
		}
	}
}

/**
 * Mark deferred continuous scales ready after data-derived domains have been set.
 * Only targets continuous scales that were skipped by setScalesReady.
 */
export function markDeferredScalesReady(
	scaleMap: Record<string, ScaleStateInstance | null>,
	channelsNeedingDataDomain: Set<string>,
	actualXScaleType: string,
	actualYScaleType: string
): void {
	for (const [axis, scale] of Object.entries(scaleMap)) {
		if (!scale) continue;

		const scaleType = axis === 'x' ? actualXScaleType : actualYScaleType;
		const needsDataDomain = channelsNeedingDataDomain.has(axis);

		// Only mark continuous scales that were waiting for data-derived domains
		if (needsDataDomain && isContinuousScale(scaleType)) {
			if (!scale.ready) {
				console.log(`✅ Marking ${axis} scale ready (data-derived domain set)`);
				scale.setReady();
			}
		}
	}
}

/**
 * Set initial continuous scale domains from fieldInfo min/max stats.
 * Called once when fieldInfo arrives (Effect 6). Only applies to numeric
 * (non-temporal) scales with non-aggregated, non-binned fields.
 */
export function setInitialContinuousDomains(
	fieldInfo: Record<string, FieldInfoEntry> | null,
	scaleMap: Record<string, ScaleStateInstance | null>,
	select: Record<string, unknown>,
	actualXScaleType: string,
	actualYScaleType: string,
	markId: string
): void {
	if (!fieldInfo) return;

	for (const alias in scaleMap) {
		const scaleState = scaleMap[alias];
		if (!scaleState) continue;

		const scaleType = alias === 'x' ? actualXScaleType : actualYScaleType;

		// Time scales get their domain from sidecar query, skip fieldInfo path
		if (isNumericScale(scaleType)) {
			// Try direct alias first, then extent variants (x1/x2, y1/y2)
			const candidates = [select[alias], select[`${alias}1`], select[`${alias}2`]].filter(
				(f) => f != null && !isBinExpression(f)
			);

			if (candidates.length === 0) continue;

			// Compute combined min/max across all extent fields for this axis
			let combinedMin = Infinity;
			let combinedMax = -Infinity;
			let found = false;

			for (const fieldValue of candidates) {
				const infoKey = String(fieldValue).replace(/^["']|["']$/g, '');
				const info = fieldInfo[infoKey];
				if (info && info.min != null && info.max != null) {
					combinedMin = Math.min(combinedMin, info.min as number);
					combinedMax = Math.max(combinedMax, info.max as number);
					found = true;
				}
			}

			if (found) {
				console.log(
					`📐 [${markId}] Domain ${alias}: fieldInfo path → [${combinedMin}, ${combinedMax}]`
				);
				(scaleState as LinearScaleState).addMark([combinedMin, combinedMax], markId);
			}
		}
	}
}

/**
 * Register domains from query result data for channels that need data-derived domains.
 * Handles continuous scales (linear, time, log, symlog) and band scales with
 * category-reducing transforms (topN).
 *
 * Called from Effect 7 on each data update. Uses positional args to avoid
 * object allocation on the crossfilter hot path.
 */
export function registerDataDerivedDomains(
	data: DataAccessor,
	channelsNeedingDataDomain: Set<string>,
	additionalChannels: string[],
	skipDomainUpdateForAxis: string | null,
	zeroBaseline: { x?: boolean; y?: boolean } | undefined,
	actualXScaleType: string,
	actualYScaleType: string,
	xScaleState: ContinuousScaleState | null,
	yScaleState: ContinuousScaleState | null,
	hasCategoryReducingTransforms: boolean,
	xBandScaleState: BandScaleState | null,
	yBandScaleState: BandScaleState | null,
	markId: string,
	isRebinning: boolean
): RegisterDomainsResult {
	if (!data || data.length === 0) {
		return { dataDerivedDomainsSet: false, skipDomainUpdateForAxis };
	}

	// Skip if no channels need data-derived domains
	if (channelsNeedingDataDomain.size === 0 && additionalChannels.length === 0) {
		return { dataDerivedDomainsSet: true, skipDomainUpdateForAxis };
	}

	// Build list of channels to examine for each axis
	const xChannelsToCheck: string[] = [];
	const yChannelsToCheck: string[] = [];

	// Collect transform-generated channels per axis
	const xTransformChannels: string[] = [];
	const yTransformChannels: string[] = [];
	for (const channel of additionalChannels) {
		if (channel.startsWith('x')) {
			xTransformChannels.push(channel);
		} else if (channel.startsWith('y')) {
			yTransformChannels.push(channel);
		}
	}

	// When transforms generate replacement channels (e.g., y0/y1 from stack),
	// use ONLY those for domain computation — the raw column values are no longer
	// meaningful for the scale (e.g., expand produces 0–1, but raw y has original values).
	if (xTransformChannels.length > 0) {
		xChannelsToCheck.push(...xTransformChannels);
	} else if (channelsNeedingDataDomain.has('x')) {
		xChannelsToCheck.push('x', 'x1', 'x2');
	}

	if (yTransformChannels.length > 0) {
		yChannelsToCheck.push(...yTransformChannels);
	} else if (channelsNeedingDataDomain.has('y')) {
		yChannelsToCheck.push('y', 'y1', 'y2');
	}

	// Compute and register X domain
	// Skip if this axis triggered the re-bin (user zoomed here, don't override)
	if (
		skipDomainUpdateForAxis !== 'x' &&
		xChannelsToCheck.length > 0 &&
		isContinuousScale(actualXScaleType)
	) {
		let extent = computeExtentFromData(data, xChannelsToCheck);
		if (extent) {
			// Apply zero baseline if mark requests it
			if (zeroBaseline?.x) {
				extent = [Math.min(0, extent[0]), Math.max(0, extent[1])];
			}

			registerExtentOnScale(xScaleState, actualXScaleType, extent, markId, isRebinning, 'X');
		}
	}

	// Compute and register Y domain
	// Skip if this axis triggered the re-bin (user zoomed here, don't override)
	if (
		skipDomainUpdateForAxis !== 'y' &&
		yChannelsToCheck.length > 0 &&
		isContinuousScale(actualYScaleType)
	) {
		let extent = computeExtentFromData(data, yChannelsToCheck);
		if (extent) {
			// Apply zero baseline if mark requests it
			if (zeroBaseline?.y) {
				extent = [Math.min(0, extent[0]), Math.max(0, extent[1])];
			}

			registerExtentOnScale(yScaleState, actualYScaleType, extent, markId, isRebinning, 'Y');
		}
	}

	// Band scale domain from post-transform data (for topN and other category-reducing transforms).
	// These marks skip fetchCategoricalDomains for the band axis and populate domain here.
	if (hasCategoryReducingTransforms) {
		for (const axis of ['x', 'y'] as const) {
			const scaleType = axis === 'x' ? actualXScaleType : actualYScaleType;
			if (scaleType !== 'band' && scaleType !== 'point') continue;

			const categories = extractCategoriesFromData(data, axis);
			const bandScale = axis === 'x' ? xBandScaleState : yBandScaleState;
			if (bandScale?.addMark && categories.length > 0) {
				bandScale.addMark(categories, markId, { sorted: true });
				bandScale.updateDomainFromExtents();
			}
		}
	}

	// Clear the skip flag after processing
	return { dataDerivedDomainsSet: true, skipDomainUpdateForAxis: null };
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function registerExtentOnScale(
	scaleState: ContinuousScaleState | null,
	scaleType: string,
	extent: [number, number],
	markId: string,
	isRebinning: boolean,
	axisLabel: string
): void {
	if (scaleType === 'time' && (scaleState as TimeScaleState | null)?.addOffsetExtent) {
		// Time scale: data is in offset form, use addOffsetExtent
		console.log(`📊 [${markId}] Registering ${axisLabel} domain from data (time offsets):`, extent);
		(scaleState as TimeScaleState).addOffsetExtent(extent, markId);
	} else if (scaleState?.addMark) {
		// Linear/log/symlog scale: use addMark with instant flag when rebinning
		if (isRebinning) {
			console.log(`⚡ [${markId}] Instant ${axisLabel} domain update (rebinning):`, extent);
		} else {
			console.log(`📊 [${markId}] Registering ${axisLabel} domain from data:`, extent);
		}
		scaleState.addMark(extent, markId, { instant: isRebinning });
	}
}
