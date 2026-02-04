<script>
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { Rects } from '../rendering/index.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { buildSelectFromChannels, resolveChannel, toFloat32, MarkColor } from './utils/index.js';

	let {
		table,
		selection,
		x,
		x1 = 0,
		x2 = x,
		y,
		color = null,
		scheme,
		alpha = 0.8, // No default scheme - MarkColor will infer
		limit,
		filterNulls = false,
		transforms = [],
		padding,
		paddingInner,
		paddingOuter,
		align = 0.5
	} = $props();

	const markId = `barx-${crypto.randomUUID().slice(0, 8)}`;
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

	const yScaleConfig = $derived.by(() => {
		const config = {};
		if (padding != null) config.padding = padding;
		if (paddingInner != null) config.paddingInner = paddingInner;
		if (paddingOuter != null) config.paddingOuter = paddingOuter;
		if (align != null) config.align = align;
		return config;
	});

	// Detect if x2 is an aggregate expression (count, sum, mean, etc.)
	const hasAggregateX = $derived.by(() => {
		return x2?.aggregate || (typeof x2 === 'object' && x2?.constructor?.name === '_AggregateNode');
	});

	// 2. Config
	const config = $derived({
		markType: 'barx',
		supportedScaleTypes: { x: ['linear', 'identity'], y: ['band'] },
		scaleRequirements: {
			x: { type: 'linear', priority: SCALE_PRIORITIES.PREFER },
			y: { type: 'band', priority: SCALE_PRIORITIES.MANDATE, config: yScaleConfig }
		},
		inferredScaleColumns: {
			x: x2, // X scale uses the value column (x2, not x1 which is baseline)
			y: y // Y scale uses categorical column
		},
		table,
		selection,
		transforms,
		select: buildSelectFromChannels({
			x1,
			x2,
			y,
			...(markColor.selectField && { color: markColor.selectField })
		}),
		clientOptions: { limit, filterNulls: filterNulls ? [x1, x2, y] : null },
		// Bar charts with aggregates should start at zero baseline
		zeroBaseline: hasAggregateX ? { x: true } : null
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived.by(() => {
		if (setup?.data?.length) return setup.data.length;
		if (Array.isArray(x2)) return x2.length;
		if (Array.isArray(y)) return y.length;
		// @ts-ignore
		if (ArrayBuffer.isView(x2)) return x2.length;
		return 0;
	});

	let hasStackTransform = $derived(transforms.some((t) => t.type === 'stack'));

	// --- DATA RESOLUTION ---

	// X0: Stack Output -> x1 prop -> 0
	let x0Data = $derived(
		toFloat32(
			resolveChannel({
				value: x1,
				channel: 'x1',
				tryColumns: hasStackTransform ? ['x0', 'x1'] : ['x1'],
				dataAccessor: setup?.data,
				instanceCount,
				fallback: 0
			})
		)
	);

	// X1: Stack Output -> x2 prop
	let x1Data = $derived(
		toFloat32(
			resolveChannel({
				value: x2,
				channel: 'x2',
				tryColumns: hasStackTransform ? ['x1', 'x2'] : ['x2'],
				dataAccessor: setup?.data,
				instanceCount
			})
		)
	);

	// Y: Categorical Resolution
	let yData = $derived.by(() => {
		if (!instanceCount) return null;

		// Fallback scale type check for No-DB mode
		const scaleType = setup?.actualYScaleType || chartContext.scaleTypes?.y || 'band';
		if (scaleType !== 'band') return null;

		const raw = resolveChannel({
			value: y,
			channel: 'y',
			dataAccessor: setup?.data,
			instanceCount
		});
		if (!raw) return null;

		if (!chartContext.yScaleState?.processDataForGPU) return null;
		const indices = chartContext.yScaleState.processDataForGPU(raw, markId);
		const yArr = toFloat32(indices);

		return { y0Data: yArr, y1Data: yArr };
	});

	let y0Data = $derived(yData?.y0Data);
	let y1Data = $derived(yData?.y1Data);

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
