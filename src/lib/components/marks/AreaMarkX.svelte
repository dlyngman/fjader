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
	import { withImplicitStack } from '$lib/transforms';
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
		y: FieldRef;
		x: FieldRef;
		x1?: number | FieldRef;
		x2?: FieldRef;
		fill?: FieldRef | null;
		fillOpacity?: number;
		stroke?: string | null;
		dotRadius?: number;
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

	// Observable Plot pattern: x shorthand → auto-stack, explicit x1/x2 → opt-out
	const hasExplicitBounds = $derived(x1Prop !== undefined || x2Prop !== undefined);
	let x1 = $derived(x1Prop ?? 0);
	let x2 = $derived(x2Prop ?? x);
	let effectiveTransforms = $derived(withImplicitStack(transforms, hasExplicitBounds, 'x'));

	// Map user-facing 'monotone' to the correct axis-specific variant (y is dim for AreaX)
	const effectiveCurve = $derived(
		curve === 'monotone' ? 'monotone-y' : curve === 'bump' ? 'bump-y' : curve
	);

	const markId = generateMarkId('areax');
	const coordinator = getContext<Coordinator>('mosaic-coordinator');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	// Ensure services are ready before inference (idempotent)
	BaseMarkSetup.ensureServices(coordinator);

	let setup = $state(null);

	// 0. Scale Type Inference
	// x2 is the value column for X scale inference (x1 is baseline)
	const effectiveXScaleType = $derived.by(() =>
		inferMarkScaleType(x2 ?? x, table, preferredXScaleType)
	);
	const effectiveYScaleType = $derived.by(() => inferMarkScaleType(y, table, preferredYScaleType));

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

	// Detect if x2 is an aggregate expression
	const hasAggregateX = $derived.by(() => {
		return typeof x2 === 'object' && x2 != null && ('aggregate' in x2 || x2.constructor?.name === '_AggregateNode');
	});

	let hasStackTransform = $derived(effectiveTransforms.some((t) => t.type === 'stack'));
	let showBothBoundaries = $derived(typeof x1Prop === 'string' && !hasStackTransform);

	// Config with _connectedConfig for automatic ORDER BY (dimension is y)
	const config = $derived({
		markType: 'areax',
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
			x: x2, // X scale uses the value column
			y: y
		},
		table,
		selection,
		transforms: effectiveTransforms,
		select: buildSelectFromChannels({
			x: x2, // Alias for tooltip nearest-point query (expects 'x' column)
			y,
			x1,
			x2,
			...(markColor.selectField && { fill: markColor.selectField }),
			...(z != null && markSeries.selectField && { z: markSeries.selectField })
		}),
		// Connected topology - ordered by dimension (y)
		_connectedConfig: {
			seriesChannel: markSeries.selectField ? seriesChannelKey : null,
			dimensionChannel: 'y'
		},
		clientOptions: { limit, filterNulls: filterNulls ? [y, x1, x2] : null },
		// Area charts with aggregates should include zero in the domain
		zeroBaseline: hasAggregateX ? { x: true } : null,
		sort: normalizeSortConfig(sort),
		tooltip
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, y, x2));

	// --- DATA RESOLUTION ---

	// Y data: the independent dimension
	let yData = $derived.by(() =>
		resolveChannelData({
			value: y,
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
		if (stroke) return parseColorToRGBA(stroke);
		return markColor.constantColor;
	});

	// --- SETUP LIFECYCLE ---

	$effect(() => {
		(void config, xScaleId, yScaleId);
		untrack(() => {
			setup?.destroy();
			setup = null;
			if (table && effectiveXScaleType && effectiveYScaleType) {
				setup = new BaseMarkSetup(config, coordinator, chartContext, markId);
			}
		});
	});

	// Tooltip registration
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !tooltip || !setup?.tooltipEnabled) return;

		tm.registerMark(
			markId,
			buildTooltipConfig({
				tempTable: setup.tooltipTableName,
				markType: 'areax',
				chartContext,
				channelFields: setup.channelFieldMap,
				colorColumn: 'fill',
				// Stacked areas: compute nearest-point distance against the stacked right (x1)
				...(hasStackTransform && { columns: { x: 'x1' } }),
				markColorScaleState: markColor.scaleState
			})
		);
		return () => tm.unregisterMark(markId);
	});

	onDestroy(() => {
		setup?.destroy();
	});
</script>

{#if (setup?.gpuReady || !table) && markColor.ready && markSeries.ready && yData && xRightData && xLeftData}
	{#key effectiveCurve}
		<Areas
			dimData={yData}
			topData={xRightData}
			bottomData={xLeftData}
			{seriesData}
			curve={effectiveCurve}
			colorValueData={markColor.data}
			colorMode={markColor.colorMode}
			colorScaleIndex={markColor.colorScaleIndex}
			constantColor={markColor.constantColor}
			{fillOpacity}
			{dotRadius}
			showBottomDots={showBothBoundaries}
			orientation="horizontal"
			facetData={setup?.facetData}
			dataVersion={setup?.client?.dataVersion || 0}
		/>
		{#if strokeWidth > 0}
			<Lines
				xData={xRightData}
				{yData}
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
					xData={xLeftData}
					{yData}
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
