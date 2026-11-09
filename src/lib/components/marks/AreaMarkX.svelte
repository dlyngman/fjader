<script lang="ts">
	import { outlineColor } from './utils/area-outline';
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
		y: FieldRef;
		x: FieldRef;
		x1?: number | FieldRef;
		x2?: FieldRef;
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
		y,
		x,
		x1: x1Prop,
		x2: x2Prop,
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

	const markId = generateMarkId('areax');
	const queryEngine = getContext<QueryEngine>('query-engine');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const gpuCoordinator = getGPUContext();

	// --- ChartConfig registration ---
	const entry = chartContext.config.registerMark(markId, 'areax', {
		table: () => table,
		y: () => y,
		x: () => x,
		x1: () => x1Prop,
		x2: () => x2Prop,
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
		preferredXScaleType: () => preferredXScaleType,
		preferredYScaleType: () => preferredYScaleType,
		sort: () => sort,
		domain: () => domain,
		tooltip: () => tooltip,
		tooltipProximity: () => tooltipProximity,
		tip: () => tip,
		fitDomain: () => fitDomain
	});

	// Observable Plot pattern: x shorthand → auto-stack, explicit x1/x2 → opt-out
	const hasExplicitBounds = $derived(entry.x1 !== undefined || entry.x2 !== undefined);
	const hasSeriesGrouping = $derived(entry.fill != null || entry.z != null);
	let x1 = $derived(entry.x1 ?? 0);
	let x2 = $derived(entry.x2 ?? entry.x);
	// Skip implicit stack for single-series areas: no-op that breaks zero-copy
	let effectiveTransforms = $derived(
		withImplicitStack(entry.transforms ?? [], hasExplicitBounds || !hasSeriesGrouping, 'x')
	);

	// Map user-facing 'monotone' to the correct axis-specific variant (y is dim for AreaX)
	const effectiveCurve = $derived.by(() => {
		const c = entry.curve ?? 'linear';
		return c === 'monotone' ? 'monotone-y' : c === 'bump' ? 'bump-y' : c;
	});

	let setup = $state<MarkLifecycleV2 | null>(null);

	// 0. Scale Type Inference — reads from entry
	// x2 is the value column for X scale inference (x1 is baseline)
	const effectiveXScaleType = $derived.by(() =>
		inferMarkScaleType(x2 ?? entry.x, entry.table, entry.preferredXScaleType)
	);
	const effectiveYScaleType = $derived.by(() =>
		inferMarkScaleType(entry.y, entry.table, entry.preferredYScaleType)
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

	/** The outline's colour, and the fill's activity it dims by (see area-outline.ts). */
	const outline = $derived(outlineColor(entry.stroke, markColor));

	// Detect if x2 is an aggregate expression
	const hasAggregateX = $derived.by(() => {
		return (
			typeof x2 === 'object' &&
			x2 != null &&
			('aggregate' in x2 || x2.constructor?.name === '_AggregateNode')
		);
	});

	let hasStackTransform = $derived(effectiveTransforms.some((t) => t.type === 'stack'));
	let showBothBoundaries = $derived(typeof entry.x1 === 'string' && !hasStackTransform);

	// Config with _orderConfig for automatic ORDER BY (series, dimension) — reads from entry
	const channelSelect = $derived(
		buildSelectFromChannels({
			x: x2, // Alias for tooltip nearest-point query (expects 'x' column)
			y: entry.y,
			x1,
			x2,
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
		markType: 'areax',
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
			x: x2, // X scale uses the value column
			y: entry.y
		},
		table: entry.table,
		transforms: effectiveTransforms,
		select: { ...channelSelect, ...resolvedTip.extraSelect },
		// Connected topology - ordered by dimension (y)
		_orderConfig: {
			seriesChannel: markSeries.selectField ? seriesChannelKey : null,
			dimensionChannel: entry.order != null ? '__order' : 'y'
		},
		// Area charts with aggregates should include zero in the domain
		zeroBaseline: hasAggregateX ? { x: true } : null
	});

	const reactiveConfig = buildReactiveConfig(entry, {
		resolveFitDomain: () => resolvedFitAxis
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, entry.y, x2));

	// --- DATA RESOLUTION ---

	// Y data: the independent dimension
	let yData = $derived.by(() =>
		resolveChannelData({
			value: entry.y,
			channel: 'y',
			dataAccessor: setup?.data,
			instanceCount
		})
	);

	// X right (x2): Stack output 'x1' -> x2 prop -> default column
	let xRightData = $derived.by(() =>
		resolveChannelData({
			value: x2,
			channel: 'x2',
			dataAccessor: setup?.data,
			instanceCount,
			tryColumns: hasStackTransform ? ['x1'] : undefined
		})
	);

	// X left (x1): Stack output 'x0' -> x1 prop -> 0
	let xLeftData = $derived.by(() =>
		resolveChannelData({
			value: x1,
			channel: 'x1',
			dataAccessor: setup?.data,
			instanceCount,
			tryColumns: hasStackTransform ? ['x0'] : undefined,
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

	// Full data domain span for density calculation (y-axis for horizontal areas)
	const fullDomainSpan = $derived.by(() => {
		const yScale = chartContext.yScaleState;
		if (!yScale || !('effectiveExtent' in yScale)) return 0;
		const [min, max] = yScale.effectiveExtent;
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
					markType: 'areax',
					chartContext,
					channelFields: setup!.channelFieldMap,
					colorColumn: 'fill',
					...(entry.z != null && { seriesColumn: 'z', markSeries }),
					// Stacked areas: containment-based proximity (x0 ≤ cursor ≤ x1)
					...(hasStackTransform && { columns: { x: 'x1', xLow: 'x0', xHigh: 'x1' } }),
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

{#if (setup?.gpuReady || !table) && markColor.ready && markSeries.ready && yData && xRightData && xLeftData}
	{#key effectiveCurve}
		<Areas
			{markId}
			dimData={yData}
			topData={xRightData}
			bottomData={xLeftData}
			{seriesData}
			curve={effectiveCurve}
			colorValueData={markColor.data}
			colorMode={markColor.colorMode}
			colorScaleIndex={markColor.colorScaleIndex}
			groupIndex={setup?.groupIndex ?? 0}
			constantColor={markColor.constantColor}
			fillOpacity={entry.fillOpacity ?? 0.5}
			dotRadius={effectiveDotRadius}
			{fullDomainSpan}
			showBottomDots={showBothBoundaries}
			orientation="horizontal"
			facetData={setup?.facetData}
			dataVersion={setup?.dataVersion || 0}
		/>
		{#if (entry.strokeWidth ?? 0) > 0}
			<Lines
				xData={xRightData}
				{yData}
				{seriesData}
				curve={effectiveCurve}
				colorValueData={outline.colorValueData}
				colorMode={outline.colorMode}
				colorScaleIndex={outline.colorScaleIndex}
				activityColorMode={outline.activityColorMode}
				activityColorScaleIndex={outline.activityColorScaleIndex}
				groupIndex={setup?.groupIndex ?? 0}
				constantColor={strokeConstantColor}
				strokeWidth={entry.strokeWidth ?? 0}
				zIndex={1}
				facetData={setup?.facetData}
				dataVersion={setup?.dataVersion || 0}
			/>
			{#if showBothBoundaries}
				<Lines
					xData={xLeftData}
					{yData}
					{seriesData}
					curve={effectiveCurve}
					colorValueData={outline.colorValueData}
					colorMode={outline.colorMode}
					colorScaleIndex={outline.colorScaleIndex}
					activityColorMode={outline.activityColorMode}
					activityColorScaleIndex={outline.activityColorScaleIndex}
					groupIndex={setup?.groupIndex ?? 0}
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
