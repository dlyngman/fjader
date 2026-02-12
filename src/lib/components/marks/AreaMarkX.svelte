<script>
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { Areas } from '../rendering/index.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { inferScaleType } from '$lib/scales/scale-inference.js';
	import { tableSchemaService } from '$lib/data/TableSchemaService.svelte.js';
	import {
		buildSelectFromChannels,
		resolveChannel,
		toFloat32,
		MarkColor,
		MarkSeries
	} from './utils/index.js';

	let {
		table,
		selection,
		y, // Independent dimension (goes up)
		x, // Shorthand for x2 (the value)
		x1 = 0, // Left baseline (default 0, or from stack transform)
		x2 = x, // Right boundary (the actual value)
		fill = null, // Fill color field
		stroke = null, // Series grouping field (for multi-series areas)
		color = null, // Color encoding (fill ?? color for color scale)
		scheme, // Color scheme
		fillOpacity = 0.5, // Area fill opacity
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = [],
		tooltip = true
	} = $props();

	const markId = `areax-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext('mosaic-coordinator');
	const chartContext = getContext('chart');
	const scaleRegistry = getContext('scale-registry');

	// Ensure services are ready before inference (idempotent)
	BaseMarkSetup.ensureServices(coordinator);

	let setup = $state(null);

	// 0. Scale Type Inference
	const effectiveXScaleType = $derived.by(() => {
		if (preferredXScaleType != null) return preferredXScaleType;
		// x2 is the value column for X scale inference
		const xField = typeof x2 === 'string' ? x2 : typeof x === 'string' ? x : null;
		if (!xField) return 'linear';
		const _v = tableSchemaService.version;
		const colType = tableSchemaService.getColumnType(table, xField);
		if (!colType) {
			tableSchemaService.getSchema(table);
			return null;
		}
		return inferScaleType({ field: xField, schemaType: colType, context: 'axis' });
	});

	const effectiveYScaleType = $derived.by(() => {
		if (preferredYScaleType != null) return preferredYScaleType;
		if (!y || typeof y !== 'string') return 'linear';
		const _v = tableSchemaService.version;
		const colType = tableSchemaService.getColumnType(table, y);
		if (!colType) {
			tableSchemaService.getSchema(table);
			return null;
		}
		return inferScaleType({ field: y, schemaType: colType, context: 'axis' });
	});

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

	// Detect if x2 is an aggregate expression
	const hasAggregateX = $derived.by(() => {
		return x2?.aggregate || (typeof x2 === 'object' && x2?.constructor?.name === '_AggregateNode');
	});

	let hasStackTransform = $derived(transforms.some((t) => t.type === 'stack'));

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
		transforms,
		select: buildSelectFromChannels({
			x: x2, // Alias for tooltip nearest-point query (expects 'x' column)
			y,
			x1,
			x2,
			...(markSeries.selectField && { stroke: markSeries.selectField }),
			...(markColor.selectField && { color: markColor.selectField })
		}),
		// Connected topology - ordered by dimension (y)
		_connectedConfig: {
			seriesChannel: markSeries.selectField ? 'stroke' : null,
			dimensionChannel: 'y'
		},
		clientOptions: { limit, filterNulls: filterNulls ? [y, x1, x2] : null },
		// Area charts with aggregates should include zero in the domain
		zeroBaseline: hasAggregateX ? { x: true } : null,
		tooltip
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived.by(() => {
		if (setup?.data?.length) return setup.data.length;
		if (Array.isArray(y)) return y.length;
		if (Array.isArray(x2)) return x2.length;
		// @ts-ignore
		if (ArrayBuffer.isView(y)) return y.length;
		return 0;
	});

	// --- DATA RESOLUTION ---

	// Y data: the independent dimension
	let yData = $derived.by(() => {
		if (!instanceCount) return null;
		const raw = resolveChannel({
			value: y,
			channel: 'y',
			dataAccessor: setup?.data,
			instanceCount
		});
		return raw ? toFloat32(raw) : null;
	});

	// X right (x2): Stack output 'x1' -> x2 prop -> default column
	let xRightData = $derived.by(() => {
		if (!instanceCount) return null;
		const raw = resolveChannel({
			value: x2,
			channel: 'x2',
			tryColumns: hasStackTransform ? ['x1'] : undefined,
			dataAccessor: setup?.data,
			instanceCount
		});
		return raw ? toFloat32(raw) : null;
	});

	// X left (x1): Stack output 'x0' -> x1 prop -> 0
	let xLeftData = $derived.by(() => {
		if (!instanceCount) return null;
		const raw = resolveChannel({
			value: x1,
			channel: 'x1',
			tryColumns: hasStackTransform ? ['x0'] : undefined,
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 0
		});
		return raw ? toFloat32(raw) : null;
	});

	// Series data comes from MarkSeries (uses scale infrastructure)
	let seriesData = $derived(markSeries.data);

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
		const id = markId;

		const colorChannelField = effectiveColorField
			? typeof effectiveColorField === 'string'
				? effectiveColorField
				: 'color'
			: stroke
				? typeof stroke === 'string'
					? stroke
					: 'stroke'
				: null;

		tm.registerMark(id, {
			tempTable: setup.tooltipTableName,
			markType: 'areax',
			scaleTypes: {
				x: chartContext.scaleTypes?.x,
				y: chartContext.scaleTypes?.y
			},
			channelFields: {
				x: typeof x2 === 'string' ? x2 : 'x',
				y: typeof y === 'string' ? y : 'y',
				...(colorChannelField && { color: colorChannelField })
			},
			colorDomain: markColor.scaleState?.isOrdinal ? markColor.scaleState?.domain : null,
			colorScaleState: markColor.scaleState ?? null,
			enabled: true
		});

		return () => tm.unregisterMark(id);
	});

	onDestroy(() => {
		setup?.destroy();
	});
</script>

{#if (setup?.gpuReady || !table) && markColor.ready && markSeries.ready && yData && xRightData && xLeftData}
	<Areas
		dimData={yData}
		topData={xRightData}
		bottomData={xLeftData}
		{seriesData}
		colorValueData={markColor.data}
		colorMode={markColor.colorMode}
		colorScaleIndex={markColor.colorScaleIndex}
		constantColor={markColor.constantColor}
		{fillOpacity}
		orientation="horizontal"
		dataVersion={setup?.client?.dataVersion || 0}
	/>
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
