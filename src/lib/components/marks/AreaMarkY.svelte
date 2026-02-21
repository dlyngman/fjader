<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte';
	import { Areas, Lines } from '../rendering';
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
		generateMarkId
	} from './utils';
	import type {
		FieldRef,
		BaseMarkProps,
		ContinuousScaleTypeProps,
		ConnectedTopologyProps,
		Coordinator,
		ChartContext
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';

	interface Props extends BaseMarkProps, ContinuousScaleTypeProps, ConnectedTopologyProps {
		x: FieldRef;
		y: FieldRef;
		y1?: number | FieldRef;
		y2?: FieldRef;
		fill?: FieldRef | null;
		fillOpacity?: number;
		stroke?: string | null;
		dotRadius?: number;
		strokeWidth?: number;
	}

	let {
		table,
		selection = undefined,
		x,
		y,
		y1 = 0,
		y2 = y,
		fill = null,
		z = null,
		scheme,
		curve = 'linear',
		fillOpacity = 0.5,
		stroke = null,
		dotRadius = 0,
		strokeWidth = 0,
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = [],
		sort = null,
		tooltip = true
	}: Props = $props();

	// Map user-facing 'monotone' to the correct axis-specific variant
	const effectiveCurve = $derived(
		curve === 'monotone' ? 'monotone-x' : curve === 'bump' ? 'bump-x' : curve
	);

	const markId = generateMarkId('areay');
	const coordinator = getContext<Coordinator>('mosaic-coordinator');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	// Ensure services are ready before inference (idempotent)
	BaseMarkSetup.ensureServices(coordinator);

	let setup = $state(null);

	// 0. Scale Type Inference
	const effectiveXScaleType = $derived.by(() => inferMarkScaleType(x, table, preferredXScaleType));
	// y2 is the value column for scale inference (y1 is baseline)
	const effectiveYScaleType = $derived.by(() =>
		inferMarkScaleType(y2 ?? y, table, preferredYScaleType)
	);

	// Series grouping: z overrides fill for grouping (Observable Plot convention)
	const seriesChannelKey = z != null ? 'z' : 'fill';
	const markSeries = new MarkSeries(
		() => z ?? fill,
		seriesChannelKey,
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Color: fill determines area color
	const markColor = new MarkColor(
		() => fill,
		() => scheme,
		'fill',
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Detect if y2 is an aggregate expression (count, sum, mean, etc.)
	const hasAggregateY = $derived.by(() => {
		return y2?.aggregate || (typeof y2 === 'object' && y2?.constructor?.name === '_AggregateNode');
	});

	let hasStackTransform = $derived(transforms.some((t) => t.type === 'stack'));
	let showBothBoundaries = $derived(typeof y1 === 'string' && !hasStackTransform);

	// Config with _connectedConfig for automatic ORDER BY
	const config = $derived({
		markType: 'areay',
		supportedScaleTypes: {
			x: ['linear', 'time', 'log'],
			y: ['linear', 'time', 'log']
		},
		scaleRequirements: {
			x: effectiveXScaleType
				? { type: effectiveXScaleType, priority: SCALE_PRIORITIES.PREFER }
				: null,
			y: effectiveYScaleType
				? { type: effectiveYScaleType, priority: SCALE_PRIORITIES.PREFER }
				: null
		},
		inferredScaleColumns: {
			x: x,
			y: y2 // Y scale uses the value column (y2, not y1 which is baseline)
		},
		table,
		selection,
		transforms,
		select: buildSelectFromChannels({
			x,
			y: y2, // Alias for tooltip nearest-point query (expects 'y' column)
			y1,
			y2,
			...(markColor.selectField && { fill: markColor.selectField }),
			...(z != null && markSeries.selectField && { z: markSeries.selectField })
		}),
		// Connected topology config - ensures data is ordered for area connectivity
		_connectedConfig: {
			seriesChannel: markSeries.selectField ? seriesChannelKey : null,
			dimensionChannel: 'x'
		},
		clientOptions: { limit, filterNulls: filterNulls ? [x, y1, y2] : null },
		// Area charts with aggregates should include zero in the domain
		zeroBaseline: hasAggregateY ? { y: true } : null,
		sort: normalizeSortConfig(sort),
		tooltip
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, x, y2));

	// --- DATA RESOLUTION ---

	let xData = $derived.by(() =>
		resolveChannelData({
			value: x,
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
		if (stroke) return parseColorToRGBA(stroke);
		return markColor.constantColor;
	});

	// --- SETUP LIFECYCLE ---

	$effect(() => {
		(void config, xScaleId, yScaleId);
		untrack(() => {
			setup?.destroy();
			setup = null;
			// Don't create BaseMarkSetup until scale type inference has resolved
			if (table && effectiveXScaleType && effectiveYScaleType) {
				setup = new BaseMarkSetup(config, coordinator, chartContext, markId);
			}
		});
	});

	// Tooltip registration
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !tooltip || !setup?.tooltipEnabled) return;

		const colorChannelField = markColor.selectField
			? typeof markColor.selectField === 'string'
				? markColor.selectField
				: 'fill'
			: markSeries.selectField
				? typeof markSeries.selectField === 'string'
					? markSeries.selectField
					: 'fill'
				: null;

		tm.registerMark(
			markId,
			buildTooltipConfig({
				tempTable: setup.tooltipTableName,
				markType: 'areay',
				chartContext,
				channelFields: {
					x: typeof x === 'string' ? x : 'x',
					y: typeof y2 === 'string' ? y2 : 'y',
					...(colorChannelField && { color: colorChannelField })
				},
				markColorScaleState: markColor.scaleState
			})
		);
		return () => tm.unregisterMark(markId);
	});

	onDestroy(() => {
		setup?.destroy();
	});
</script>

{#if (setup?.gpuReady || !table) && markColor.ready && markSeries.ready && xData && yTopData && yBottomData}
	{#key effectiveCurve}
		<Areas
			dimData={xData}
			topData={yTopData}
			bottomData={yBottomData}
			{seriesData}
			curve={effectiveCurve}
			colorValueData={markColor.data}
			colorMode={markColor.colorMode}
			colorScaleIndex={markColor.colorScaleIndex}
			constantColor={markColor.constantColor}
			{fillOpacity}
			{dotRadius}
			showBottomDots={showBothBoundaries}
			orientation="vertical"
			facetData={setup?.facetData}
			dataVersion={setup?.client?.dataVersion || 0}
		/>
		{#if strokeWidth > 0}
			<Lines
				{xData}
				yData={yTopData}
				{seriesData}
				curve={effectiveCurve}
				colorValueData={stroke ? null : markColor.data}
				colorMode={stroke ? 0 : markColor.colorMode}
				colorScaleIndex={stroke ? 0 : markColor.colorScaleIndex}
				constantColor={strokeConstantColor}
				{strokeWidth}
				zIndex={1}
				facetData={setup?.facetData}
				dataVersion={setup?.client?.dataVersion || 0}
			/>
			{#if showBothBoundaries}
				<Lines
					{xData}
					yData={yBottomData}
					{seriesData}
					curve={effectiveCurve}
					colorValueData={stroke ? null : markColor.data}
					colorMode={stroke ? 0 : markColor.colorMode}
					colorScaleIndex={stroke ? 0 : markColor.colorScaleIndex}
					constantColor={strokeConstantColor}
					{strokeWidth}
					zIndex={1}
					facetData={setup?.facetData}
					dataVersion={setup?.client?.dataVersion || 0}
				/>
			{/if}
		{/if}
	{/key}
{:else if setup?.client?.error}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="red" font-size="12">
		Error: {setup.client.error.message}
	</text>
{:else if setup?.client?.delayedLoading}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12">
		Loading data...
	</text>
{:else}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12">
		Initializing area...
	</text>
{/if}
