<script>
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { Lines } from '../rendering/index.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
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
		x,
		y,
		stroke = null, // Series grouping field (for multi-series lines)
		color = null, // Color encoding (can be same as stroke or different)
		scheme, // Color scheme
		strokeWidth = 2, // Line thickness in logical pixels
		miterLimit = 4, // Max miter length to prevent spikes
		limit,
		filterNulls = false,
		preferredXScaleType = 'linear',
		preferredYScaleType = 'linear',
		transforms = []
	} = $props();

	const markId = `line-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext('mosaic-coordinator');
	const chartContext = getContext('chart');
	const scaleRegistry = getContext('scale-registry');

	let setup = $state(null);

	// Series grouping - uses scale infrastructure for categorical → index mapping
	const markSeries = new MarkSeries(
		() => stroke,
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Color logic - only uses explicit color prop
	// To color by series, set color={stroke} explicitly
	const markColor = new MarkColor(
		() => color,
		() => scheme,
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Config with _connectedConfig for automatic ORDER BY
	const config = $derived({
		markType: 'line',
		supportedScaleTypes: {
			x: ['linear', 'time', 'log'],
			y: ['linear', 'time', 'log']
		},
		scaleRequirements: {
			x: { type: preferredXScaleType, priority: SCALE_PRIORITIES.PREFER },
			y: { type: preferredYScaleType, priority: SCALE_PRIORITIES.PREFER }
		},
		inferredScaleColumns: {
			x: x,
			y: y
		},
		table,
		selection,
		transforms,
		select: buildSelectFromChannels({
			x,
			y,
			...(markSeries.selectField && { stroke: markSeries.selectField }),
			...(markColor.selectField && { color: markColor.selectField })
		}),
		// Connected topology config - ensures data is ordered for line connectivity
		_connectedConfig: {
			seriesChannel: markSeries.selectField ? 'stroke' : null,
			dimensionChannel: 'x'
		},
		clientOptions: { limit, filterNulls: filterNulls ? [x, y] : null }
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived.by(() => {
		if (setup?.data?.length) return setup.data.length;
		if (Array.isArray(x)) return x.length;
		if (Array.isArray(y)) return y.length;
		// @ts-ignore
		if (ArrayBuffer.isView(x)) return x.length;
		return 0;
	});

	// --- DATA RESOLUTION ---

	let xData = $derived.by(() => {
		if (!instanceCount) return null;
		const raw = resolveChannel({
			value: x,
			channel: 'x',
			dataAccessor: setup?.data,
			instanceCount
		});
		return raw ? toFloat32(raw) : null;
	});

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

	// Series data comes from MarkSeries (uses scale infrastructure)
	let seriesData = $derived(markSeries.data);

	// --- SETUP LIFECYCLE ---

	$effect(() => {
		(void config, xScaleId, yScaleId);
		untrack(() => {
			setup?.destroy();
			if (table) setup = new BaseMarkSetup(config, coordinator, chartContext, markId);
		});
	});

	// MarkColor and MarkSeries connect to setup internally via their lifecycle effects

	onDestroy(() => {
		setup?.destroy();
	});
</script>

{#if (setup?.gpuReady || !table) && markColor.ready && markSeries.ready && xData && yData}
	<Lines
		{xData}
		{yData}
		{seriesData}
		colorValueData={markColor.data}
		colorMode={markColor.colorMode}
		colorScaleIndex={markColor.colorScaleIndex}
		constantColor={markColor.constantColor}
		{strokeWidth}
		{miterLimit}
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
		Initializing mark...
	</text>
{/if}
