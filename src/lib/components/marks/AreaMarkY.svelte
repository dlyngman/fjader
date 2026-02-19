<script>
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { Areas, Lines } from '../rendering/index.js';
	import { parseColorToRGBA } from '$lib/scales/color-utils.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import {
		buildSelectFromChannels,
		resolveChannelData,
		computeInstanceCount,
		buildTooltipConfig,
		MarkColor,
		MarkSeries,
		normalizeSortConfig,
		inferMarkScaleType
	} from './utils/index.js';

	let {
		table,
		selection = undefined,
		x,
		y, // Shorthand for y2 (the value)
		y1 = 0, // Baseline (default 0, or from stack transform)
		y2 = y, // Topline (the actual value)
		fill = null, // Fill color field
		stroke = null, // Series grouping field (for multi-series areas)
		color = null, // Color encoding (fill ?? color for color scale)
		scheme, // Color scheme
		curve = 'linear', // Curve type: 'linear', 'step', 'step-after', 'step-before', 'catmull-rom', 'monotone', 'bump'
		fillOpacity = 0.5, // Area fill opacity
		dotRadius = 0, // 0 = no dots, >0 = dot radius in px on the top boundary
		strokeWidth = 0, // Stroke outline width (0 = no stroke)
		strokeColor = null, // Stroke color (CSS string or null to inherit from fill/color)
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = [],
		sort = null,
		tooltip = true
	} = $props();

	// Map user-facing 'monotone' to the correct axis-specific variant
	const effectiveCurve = $derived(
		curve === 'monotone' ? 'monotone-x' : curve === 'bump' ? 'bump-x' : curve
	);

	const markId = `areay-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext('mosaic-coordinator');
	const chartContext = getContext('chart');
	const scaleRegistry = getContext('scale-registry');

	// Ensure services are ready before inference (idempotent)
	BaseMarkSetup.ensureServices(coordinator);

	let setup = $state(null);

	// 0. Scale Type Inference
	const effectiveXScaleType = $derived.by(() => inferMarkScaleType(x, table, preferredXScaleType));
	// y2 is the value column for scale inference (y1 is baseline)
	const effectiveYScaleType = $derived.by(() => inferMarkScaleType(y2 ?? y, table, preferredYScaleType));

	// Series grouping - uses scale infrastructure for categorical → index mapping
	const markSeries = new MarkSeries(
		() => stroke,
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Color logic - uses fill ?? color for the color field
	const effectiveColorField = $derived(fill ?? color);
	const markColor = new MarkColor(
		() => effectiveColorField,
		() => scheme,
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
			...(markSeries.selectField && { stroke: markSeries.selectField }),
			...(markColor.selectField && { color: markColor.selectField })
		}),
		// Connected topology config - ensures data is ordered for area connectivity
		_connectedConfig: {
			seriesChannel: markSeries.selectField ? 'stroke' : null,
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

	let xData = $derived.by(() => resolveChannelData({
		value: x, channel: 'x', dataAccessor: setup?.data, instanceCount
	}));

	// Y top (y2): Stack output 'y1' -> y2 prop -> default column
	let yTopData = $derived.by(() => resolveChannelData({
		value: y2, channel: 'y2', dataAccessor: setup?.data, instanceCount,
		tryColumns: hasStackTransform ? ['y1'] : undefined
	}));

	// Y bottom (y1): Stack output 'y0' -> y1 prop -> 0
	let yBottomData = $derived.by(() => resolveChannelData({
		value: y1, channel: 'y1', dataAccessor: setup?.data, instanceCount,
		tryColumns: hasStackTransform ? ['y0'] : undefined, fallback: 0
	}));

	// Series data comes from MarkSeries (uses scale infrastructure)
	let seriesData = $derived(markSeries.data);

	// Stroke outline color: parse CSS color string, or inherit from fill/color
	const strokeConstantColor = $derived.by(() => {
		if (strokeColor) return parseColorToRGBA(strokeColor);
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

		const colorChannelField = effectiveColorField
			? typeof effectiveColorField === 'string' ? effectiveColorField : 'color'
			: stroke
				? typeof stroke === 'string' ? stroke : 'stroke'
				: null;

		tm.registerMark(markId, buildTooltipConfig({
			tempTable: setup.tooltipTableName,
			markType: 'areay',
			chartContext,
			channelFields: {
				x: typeof x === 'string' ? x : 'x',
				y: typeof y2 === 'string' ? y2 : 'y',
				...(colorChannelField && { color: colorChannelField })
			},
			markColorScaleState: markColor.scaleState
		}));
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
				xData={xData}
				yData={yTopData}
				{seriesData}
				curve={effectiveCurve}
				colorValueData={strokeColor ? null : markColor.data}
				colorMode={strokeColor ? 0 : markColor.colorMode}
				colorScaleIndex={strokeColor ? 0 : markColor.colorScaleIndex}
				constantColor={strokeConstantColor}
				{strokeWidth}
				zIndex={1}
				facetData={setup?.facetData}
				dataVersion={setup?.client?.dataVersion || 0}
			/>
			{#if showBothBoundaries}
				<Lines
					xData={xData}
					yData={yBottomData}
					{seriesData}
					curve={effectiveCurve}
					colorValueData={strokeColor ? null : markColor.data}
					colorMode={strokeColor ? 0 : markColor.colorMode}
					colorScaleIndex={strokeColor ? 0 : markColor.colorScaleIndex}
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
