<script>
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { Rects } from '../rendering/index.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { buildSelectFromChannels, resolveChannel, toFloat32, MarkColor } from './utils/index.js';

	let {
		table,
		selection,
		x, // categorical data
		y, // shorthand for y2 (value)
		y1 = 0, // baseline
		y2 = y, // top of bars
		color = null,
		scheme, // No default scheme - MarkColor will infer
		alpha = 0.8,
		limit,
		filterNulls = false,
		transforms = [],
		padding,
		paddingInner,
		paddingOuter,
		align = 0.5,
		tooltip = true
	} = $props();

	const markId = `bary-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext('mosaic-coordinator');
	const chartContext = getContext('chart');
	const scaleRegistry = getContext('scale-registry');

	let setup = $state(null);

	// 1. Color Logic
	const markColor = new MarkColor(
		() => color,
		() => scheme,
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	const xScaleConfig = $derived.by(() => {
		const config = {};
		if (padding != null) config.padding = padding;
		if (paddingInner != null) config.paddingInner = paddingInner;
		if (paddingOuter != null) config.paddingOuter = paddingOuter;
		if (align != null) config.align = align;
		return config;
	});

	// Detect if y2 is an aggregate expression (count, sum, mean, etc.)
	const hasAggregateY = $derived.by(() => {
		return y2?.aggregate || (typeof y2 === 'object' && y2?.constructor?.name === '_AggregateNode');
	});

	// 2. Config
	const config = $derived({
		markType: 'bary',
		supportedScaleTypes: {
			x: ['band'],
			y: ['linear', 'identity']
		},
		scaleRequirements: {
			x: { type: 'band', priority: SCALE_PRIORITIES.MANDATE, config: xScaleConfig },
			y: { type: 'linear', priority: SCALE_PRIORITIES.PREFER }
		},
		inferredScaleColumns: {
			x: x, // X scale uses categorical column
			y: y2 // Y scale uses the value column (y2, not y1 which is baseline)
		},
		table,
		selection,
		transforms,
		select: buildSelectFromChannels({
			x,
			y1,
			y2,
			...(markColor.selectField && { color: markColor.selectField })
		}),
		clientOptions: { limit, filterNulls: filterNulls ? [x, y1, y2] : null },
		// Bar charts with aggregates should start at zero baseline
		zeroBaseline: hasAggregateY ? { y: true } : null,
		tooltip
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived.by(() => {
		if (setup?.data?.length) return setup.data.length;
		if (Array.isArray(y2)) return y2.length;
		if (Array.isArray(x)) return x.length;
		// @ts-ignore
		if (ArrayBuffer.isView(y2)) return y2.length;
		return 0;
	});

	let hasStackTransform = $derived(transforms.some((t) => t.type === 'stack'));

	// --- DATA RESOLUTION ---

	// X Data: Categorical (Band Scale)
	let xData = $derived.by(() => {
		if (!instanceCount) return null;

		const scaleType = setup?.actualXScaleType || chartContext.scaleTypes?.x || 'band';
		if (scaleType !== 'band') return null;

		const raw = resolveChannel({
			value: x,
			channel: 'x',
			dataAccessor: setup?.data,
			instanceCount
		});

		if (!raw) return null;
		if (!chartContext.xScaleState?.processDataForGPU) return null;

		const indices = chartContext.xScaleState.processDataForGPU(raw, markId);
		const xArr = toFloat32(indices);

		return { x0Data: xArr, x1Data: xArr };
	});

	let x0Data = $derived(xData?.x0Data);
	let x1Data = $derived(xData?.x1Data);

	// Y0: Stack Output -> y1 prop -> 0
	let y0Data = $derived.by(() => {
		const raw = resolveChannel({
			value: y1,
			channel: 'y1',
			tryColumns: hasStackTransform ? ['y0'] : undefined, // Stack 'vertical' output
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 0
		});
		return toFloat32(raw);
	});

	// Y1: Stack Output -> y2 prop
	let y1Data = $derived.by(() => {
		const raw = resolveChannel({
			value: y2,
			channel: 'y2',
			tryColumns: hasStackTransform ? ['y1'] : undefined, // Stack 'vertical' output
			dataAccessor: setup?.data,
			instanceCount
		});
		return toFloat32(raw);
	});

	let alphaData = $derived(
		toFloat32(
			resolveChannel({
				value: alpha,
				channel: 'alpha',
				dataAccessor: setup?.data,
				instanceCount,
				fallback: 0.8
			})
		)
	);

	// --- SETUP LIFECYCLE ---

	$effect(() => {
		// Track things that require setup recreation:
		// - table, scales, transforms (data/scale changes)
		// - markColor.selectField (color field changes like species→island)
		// BUT NOT scheme changes (tableau10→category10 with same field)
		(void table, xScaleId, yScaleId, transforms, markColor.selectField);
		untrack(() => {
			setup?.destroy();
			if (table) setup = new BaseMarkSetup(config, coordinator, chartContext, markId);
		});
	});

	// Tooltip registration
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !tooltip || !setup?.tooltipEnabled) return;
		const id = markId;

		tm.registerMark(id, {
			tempTable: setup.tooltipTableName,
			markType: 'bary',
			scaleTypes: {
				x: chartContext.scaleTypes?.x,
				y: chartContext.scaleTypes?.y
			},
			columns: { x: 'x', yLow: typeof y1 === 'number' ? y1 : 'y1', yHigh: 'y2' },
			channelFields: {
				x: typeof x === 'string' ? x : 'x',
				y: typeof y2 === 'string' ? y2 : 'y',
				...(color && { color: typeof color === 'string' ? color : 'color' })
			},
			bandDomains: {
				...(chartContext.scaleTypes?.x === 'band' && {
					x: chartContext.xScaleState?.effectiveDomain
				})
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

{#if (setup?.gpuReady || !table) && markColor.ready && x0Data && x1Data && y0Data && y1Data}
	<Rects
		{x0Data}
		{x1Data}
		{y0Data}
		{y1Data}
		colorValueData={markColor.data}
		{alphaData}
		colorMode={markColor.colorMode}
		colorScaleIndex={markColor.colorScaleIndex}
		constantColor={markColor.constantColor}
		dataVersion={setup?.client?.dataVersion || 0}
	/>
{:else if setup?.client?.error}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="red" font-size="12"
		>Error: {setup.client.error.message}</text
	>
{:else if setup?.client?.delayedLoading}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12"
		>Loading data...</text
	>
{:else}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12"
		>Initializing bars...</text
	>
{/if}
