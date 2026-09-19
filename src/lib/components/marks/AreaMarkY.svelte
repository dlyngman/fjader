<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycleV2 } from './lifecycle/MarkLifecycleV2.svelte';
	import { Areas, Lines } from '../rendering';
	import { getGPUContext } from '$lib/gpu';
	import { parseColorToRGBA } from '$lib/scales/color-utils';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import {
		buildSelectFromChannels,
		resolveChannelData,
		computeInstanceCount,
		buildTooltipConfig,
		MarkColor,
		MarkSeries,
		normalizeSortConfig,
		inferMarkScaleType,
		generateMarkId,
		resolveTip
	} from './utils';
	import { buildReactiveConfig } from './utils/reactive-config';
	import { withImplicitStack } from '$lib/transforms';
	import type {
		FieldRef,
		BaseMarkProps,
		ContinuousScaleTypeProps,
		ConnectedTopologyProps,
		ChartContext
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { QueryEngine } from '$lib/query-engine/QueryEngine';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

	interface Props extends BaseMarkProps, ContinuousScaleTypeProps, ConnectedTopologyProps {
		x: FieldRef;
		y: FieldRef;
		y1?: number | FieldRef;
		y2?: FieldRef;
		fill?: FieldRef | null;
		fillOpacity?: number;
		stroke?: string | null;
		dotRadius?: number;
		autoDots?: boolean;
		strokeWidth?: number;
	}

	let {
		table,
		selection = undefined,
		x,
		y,
		y1: y1Prop,
		y2: y2Prop,
		fill = null,
		z = null,
		order = undefined,
		scheme,
		curve = 'linear',
		fillOpacity = 0.5,
		stroke = null,
		dotRadius = 0,
		autoDots = false,
		strokeWidth = 0,
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = [],
		sort = null,
		domain = null,
		tooltip = true,
		tooltipProximity,
		tip = undefined,
		fitDomain = undefined
	}: Props = $props();

	const markId = generateMarkId('areay');
	const queryEngine = getContext<QueryEngine>('query-engine');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const gpuCoordinator = getGPUContext();

	// --- ChartConfig registration ---
	const entry = chartContext.config.registerMark(markId, 'areay', {
		table: () => table,
		x: () => x,
		y: () => y,
		y1: () => y1Prop,
		y2: () => y2Prop,
		fill: () => fill,
		z: () => z,
		order: () => order,
		scheme: () => scheme,
		curve: () => curve,
		fillOpacity: () => fillOpacity,
		stroke: () => stroke,
		dotRadius: () => dotRadius,
		autoDots: () => autoDots,
		strokeWidth: () => strokeWidth,
		transforms: () => transforms,
		selection: () => selection,
		limit: () => limit,
		filterNulls: () => filterNulls,
		preferredXScaleType: () => preferredXScaleType,
		preferredYScaleType: () => preferredYScaleType,
		sort: () => sort,
		domain: () => domain,
		tooltip: () => tooltip,
		tooltipProximity: () => tooltipProximity,
		tip: () => tip,
		fitDomain: () => fitDomain
	});

	// Observable Plot pattern: y shorthand → auto-stack, explicit y1/y2 → opt-out
	const hasExplicitBounds = $derived(entry.y1 !== undefined || entry.y2 !== undefined);
	const hasSeriesGrouping = $derived(entry.fill != null || entry.z != null);
	let y1 = $derived(entry.y1 ?? 0);
	let y2 = $derived(entry.y2 ?? entry.y);
	// Skip implicit stack for single-series areas: no-op that breaks zero-copy
	let effectiveTransforms = $derived(
		withImplicitStack(entry.transforms ?? [], hasExplicitBounds || !hasSeriesGrouping, 'y')
	);

	// Map user-facing 'monotone' to the correct axis-specific variant
	const effectiveCurve = $derived.by(() => {
		const c = entry.curve ?? 'linear';
		return c === 'monotone' ? 'monotone-x' : c === 'bump' ? 'bump-x' : c;
	});

	let setup = $state<MarkLifecycleV2 | null>(null);

	// 0. Scale Type Inference — reads from entry
	const effectiveXScaleType = $derived.by(() =>
		inferMarkScaleType(entry.x, entry.table, entry.preferredXScaleType)
	);
	// y2 is the value column for scale inference (y1 is baseline)
	const effectiveYScaleType = $derived.by(() =>
		inferMarkScaleType(y2 ?? entry.y, entry.table, entry.preferredYScaleType)
	);

	// Series grouping: z overrides fill for grouping (Observable Plot convention)
	const seriesChannelKey = entry.z != null ? 'z' : 'fill';
	const markSeries = new MarkSeries(
		() => entry.z ?? entry.fill,
		seriesChannelKey,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Color: fill determines area color — reads from entry
	const markColor = new MarkColor(
		() => entry.fill,
		() => entry.scheme,
		'fill',
		() => entry.table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Detect if y2 is an aggregate expression (count, sum, mean, etc.)
	const hasAggregateY = $derived.by(() => {
		return (
			typeof y2 === 'object' &&
			y2 != null &&
			('aggregate' in y2 || y2.constructor?.name === '_AggregateNode')
		);
	});

	let hasStackTransform = $derived(effectiveTransforms.some((t) => t.type === 'stack'));
	let showBothBoundaries = $derived(typeof entry.y1 === 'string' && !hasStackTransform);

	// Config with _orderConfig for automatic ORDER BY (series, dimension) — reads from entry
	const channelSelect = $derived(
		buildSelectFromChannels({
			x: entry.x,
			y: y2, // Alias for tooltip nearest-point query (expects 'y' column)
			y1,
			y2,
			...(markColor.selectField && { fill: markColor.selectField }),
			...(entry.z != null && markSeries.selectField && { z: markSeries.selectField }),
			...(entry.order != null && { __order: entry.order })
		})
	);
	const resolvedTip = $derived(resolveTip(entry.tip, channelSelect));

	const resolvedFitAxis = $derived.by(() => {
		const fd = entry.fitDomain;
		if (!fd) return null;
		return fd === 'x' ? 'x' : fd === 'y' ? 'y' : 'y';
	});

	const config = $derived({
		markType: 'areay',
		supportedScaleTypes: {
			x: ['linear', 'time', 'log', 'symlog'],
			y: ['linear', 'time', 'log', 'symlog']
		},
		scaleRequirements: {
			x: effectiveXScaleType
				? {
						type: effectiveXScaleType,
						priority: SCALE_PRIORITIES.PREFER,
						config: resolvedFitAxis === 'x' ? { __fitDomain: true } : {}
					}
				: null,
			y: effectiveYScaleType
				? {
						type: effectiveYScaleType,
						priority: SCALE_PRIORITIES.PREFER,
						config: resolvedFitAxis === 'y' ? { __fitDomain: true } : {}
					}
				: null
		},
		inferredScaleColumns: {
			x: entry.x,
			y: y2 // Y scale uses the value column (y2, not y1 which is baseline)
		},
		table: entry.table,
		transforms: effectiveTransforms,
		select: { ...channelSelect, ...resolvedTip.extraSelect },
		// Ensures SQL ORDER BY series, dimension for consistent stacking and path rendering
		_orderConfig: {
			seriesChannel: markSeries.selectField ? seriesChannelKey : null,
			dimensionChannel: entry.order != null ? '__order' : 'x'
		},
		// Area charts with aggregates should include zero in the domain
		zeroBaseline: hasAggregateY ? { y: true } : null
	});

	const reactiveConfig = buildReactiveConfig(entry, {
		resolveFitDomain: () => resolvedFitAxis
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, entry.x, y2));

	// --- DATA RESOLUTION ---

	let xData = $derived.by(() =>
		resolveChannelData({
			value: entry.x,
			channel: 'x',
			dataAccessor: setup?.data,
			instanceCount
		})
	);

	// Y top (y2): Stack output 'y1' -> y2 prop -> default column
	let yTopData = $derived.by(() =>
		resolveChannelData({
			value: y2,
			channel: 'y2',
			dataAccessor: setup?.data,
			instanceCount,
			tryColumns: hasStackTransform ? ['y1'] : undefined
		})
	);

	// Y bottom (y1): Stack output 'y0' -> y1 prop -> 0
	let yBottomData = $derived.by(() =>
		resolveChannelData({
			value: y1,
			channel: 'y1',
			dataAccessor: setup?.data,
			instanceCount,
			tryColumns: hasStackTransform ? ['y0'] : undefined,
			fallback: 0
		})
	);

	// Series data comes from MarkSeries (uses scale infrastructure)
	let seriesData = $derived(markSeries.data);

	// Stroke outline color: parse CSS color string, or inherit from fill color
	const strokeConstantColor = $derived.by(() => {
		if (entry.stroke) return parseColorToRGBA(entry.stroke as string);
		return markColor.constantColor;
	});

	// Auto-dots: negative dotRadius signals density-based fade to the vertex shader
	const effectiveDotRadius = $derived.by(() => {
		const dr = entry.dotRadius ?? 0;
		if (!entry.autoDots) return dr;
		const baseR = dr > 0 ? dr : 2.5;
		return -baseR;
	});

	// Full data domain span for density calculation (x-axis for vertical areas)
	const fullDomainSpan = $derived.by(() => {
		const xScale = chartContext.xScaleState;
		if (!xScale || !('effectiveExtent' in xScale)) return 0;
		const [min, max] = xScale.effectiveExtent;
		return max - min;
	});

	// --- SETUP LIFECYCLE ---

	$effect(() => {
		(void config, xScaleId, yScaleId);
		untrack(() => {
			if (setup) {
				gpuCoordinator?.markForRetain(markId);
			}
			setup?.destroy();
			setup = null;
			// Don't create MarkLifecycle until scale type inference has resolved
			if (entry.table && effectiveXScaleType && effectiveYScaleType && queryEngine) {
				setup = new MarkLifecycleV2(
					config,
					reactiveConfig,
					queryEngine,
					chartContext,
					markId,
					filterGroups.get(entry.selection as string | undefined)
				);
			}
		});
	});

	// Tooltip registration — guard conditions are tracked; registration body
	// runs in untrack() to avoid reactive deps on scaleTypes/colorScaleState
	// that cause spurious unregister/re-register cycles.
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !entry.tooltip || !setup?.tooltipEnabled) return;
		untrack(() => {
			tm.registerMark(
				markId,
				buildTooltipConfig({
					tempTable: setup!.tooltipTableName,
					markType: 'areay',
					chartContext,
					channelFields: setup!.channelFieldMap,
					colorColumn: 'fill',
					...(entry.z != null && { seriesColumn: 'z', markSeries }),
					// Stacked areas: containment-based proximity (y0 ≤ cursor ≤ y1)
					...(hasStackTransform && { columns: { y: 'y1', yLow: 'y0', yHigh: 'y1' } }),
					markColor,
					proximityAxis: entry.tooltipProximity,
					constantRadius: entry.dotRadius ? Number(entry.dotRadius) : undefined,
					displayFields: resolvedTip.displayFields
				})
			);
		});
		return () => tm.unregisterMark(markId);
	});

	onDestroy(() => {
		setup?.destroy();
		chartContext.config.unregisterMark(markId);
		gpuCoordinator?.releaseRetained(markId);
	});
</script>

{#if (setup?.gpuReady || !table) && markColor.ready && markSeries.ready && xData && yTopData && yBottomData}
	{#key effectiveCurve}
		<Areas
			{markId}
			dimData={xData}
			topData={yTopData}
			bottomData={yBottomData}
			{seriesData}
			curve={effectiveCurve}
			colorValueData={markColor.data}
			colorMode={markColor.colorMode}
			colorScaleIndex={markColor.colorScaleIndex}
			constantColor={markColor.constantColor}
			fillOpacity={entry.fillOpacity ?? 0.5}
			dotRadius={effectiveDotRadius}
			{fullDomainSpan}
			showBottomDots={showBothBoundaries}
			orientation="vertical"
			facetData={setup?.facetData}
			dataVersion={setup?.dataVersion || 0}
		/>
		{#if (entry.strokeWidth ?? 0) > 0}
			<Lines
				{xData}
				yData={yTopData}
				{seriesData}
				curve={effectiveCurve}
				colorValueData={entry.stroke ? null : markColor.data}
				colorMode={entry.stroke ? 0 : markColor.colorMode}
				colorScaleIndex={entry.stroke ? 0 : markColor.colorScaleIndex}
				constantColor={strokeConstantColor}
				strokeWidth={entry.strokeWidth ?? 0}
				zIndex={1}
				facetData={setup?.facetData}
				dataVersion={setup?.dataVersion || 0}
			/>
			{#if showBothBoundaries}
				<Lines
					{xData}
					yData={yBottomData}
					{seriesData}
					curve={effectiveCurve}
					colorValueData={entry.stroke ? null : markColor.data}
					colorMode={entry.stroke ? 0 : markColor.colorMode}
					colorScaleIndex={entry.stroke ? 0 : markColor.colorScaleIndex}
					constantColor={strokeConstantColor}
					strokeWidth={entry.strokeWidth ?? 0}
					zIndex={1}
					facetData={setup?.facetData}
					dataVersion={setup?.dataVersion || 0}
				/>
			{/if}
		{/if}
	{/key}
{/if}
