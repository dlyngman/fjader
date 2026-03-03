<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte';
	import { Rects } from '../rendering';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import {
		buildSelectFromChannels,
		buildConstantsFromChannels,
		resolveChannelData,
		computeInstanceCount,
		buildTooltipConfig,
		MarkColor,
		normalizeSortConfig,
		generateMarkId,
		resolveTip
	} from './utils';
	import { withImplicitStack } from '$lib/transforms';
	import type {
		FieldRef,
		BaseMarkProps,
		BandScaleProps,
		RectOffsetProps,
		Coordinator,
		ChartContext
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';

	interface Props extends BaseMarkProps, BandScaleProps, RectOffsetProps {
		x: FieldRef;
		x1?: number | FieldRef;
		x2?: FieldRef;
		y: FieldRef;
		fill?: FieldRef | null;
		opacity?: number;
	}

	let {
		table,
		selection = undefined,
		x,
		x1: x1Prop,
		x2: x2Prop,
		y,
		fill = null,
		scheme,
		opacity = 1,
		limit,
		filterNulls = false,
		transforms = [],
		padding,
		paddingInner,
		paddingOuter,
		align = 0.5,
		inset = 0,
		dx = 0,
		dy = 0,
		sort = null,
		tooltip = true,
		tip = undefined
	}: Props = $props();

	// Observable Plot pattern: x shorthand → auto-stack, explicit x1/x2 → opt-out
	const hasExplicitBounds = $derived(x1Prop !== undefined || x2Prop !== undefined);
	let x1 = $derived(x1Prop ?? 0);
	let x2 = $derived(x2Prop ?? x);
	let effectiveTransforms = $derived(withImplicitStack(transforms, hasExplicitBounds, 'x'));

	const markId = generateMarkId('barx');
	const coordinator = getContext<Coordinator>('mosaic-coordinator');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	let setup = $state(null);

	// 1. Color Logic
	const markColor = new MarkColor(
		() => fill,
		() => scheme,
		'fill',
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	const yScaleConfig = $derived.by(() => {
		const config: Record<string, unknown> = {};
		if (padding != null) config.padding = padding;
		if (paddingInner != null) config.paddingInner = paddingInner;
		if (paddingOuter != null) config.paddingOuter = paddingOuter;
		if (align != null) config.align = align;
		return config;
	});

	// Detect if x2 is an aggregate expression (count, sum, mean, etc.)
	const hasAggregateX = $derived.by(() => {
		return (
			typeof x2 === 'object' &&
			x2 != null &&
			('aggregate' in x2 || x2.constructor?.name === '_AggregateNode')
		);
	});

	// 2. Config
	const channelSelect = $derived(
		buildSelectFromChannels({
			x1,
			x2,
			y,
			...(markColor.selectField && { fill: markColor.selectField })
		})
	);
	const resolvedTip = $derived(resolveTip(tip, channelSelect));

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
		transforms: effectiveTransforms,
		select: { ...channelSelect, ...resolvedTip.extraSelect },
		constants: buildConstantsFromChannels({ x1, x2, y }),
		clientOptions: { limit, filterNulls: filterNulls ? [x1, x2, y] : null },
		// Bar charts with aggregates should start at zero baseline
		zeroBaseline: hasAggregateX ? { x: true } : null,
		sort: normalizeSortConfig(sort),
		tooltip: tip === false ? false : tooltip
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, x2, y));

	let hasStackTransform = $derived(effectiveTransforms.some((t) => t.type === 'stack'));

	// --- DATA RESOLUTION ---

	// X0: Stack Output -> x1 prop -> 0
	let x0Data = $derived(
		resolveChannelData({
			value: x1,
			channel: 'x1',
			dataAccessor: setup?.data,
			instanceCount,
			tryColumns: hasStackTransform ? ['x0', 'x1'] : ['x1'],
			fallback: 0
		})
	);

	// X1: Stack Output -> x2 prop
	let x1Data = $derived(
		resolveChannelData({
			value: x2,
			channel: 'x2',
			dataAccessor: setup?.data,
			instanceCount,
			tryColumns: hasStackTransform ? ['x1', 'x2'] : ['x2']
		})
	);

	// Y: Categorical Resolution — both y0/y1 share same band indices
	let yData = $derived.by(() => {
		const scaleType = setup?.actualYScaleType || chartContext.scaleTypes?.y || 'band';
		if (scaleType !== 'band') return null;
		const arr = resolveChannelData({
			value: y,
			channel: 'y',
			dataAccessor: setup?.data,
			instanceCount,
			scaleState: chartContext.yScaleState,
			scaleType,
			markId,
			suppressUnmappedWarning: setup?.hasCategoryReducingTransforms
		});
		return arr ? { y0Data: arr, y1Data: arr } : null;
	});

	let y0Data = $derived(yData?.y0Data);
	let y1Data = $derived(yData?.y1Data);

	let opacityData = $derived(
		resolveChannelData({
			value: opacity,
			channel: 'opacity',
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 0.8
		})
	);

	// --- SETUP LIFECYCLE ---

	$effect(() => {
		// Track things that require setup recreation:
		// - table, scales, transforms (data/scale changes)
		// - markColor.selectField (color field changes like species→island)
		// BUT NOT scheme changes (tableau10→category10 with same field)
		(void table, xScaleId, yScaleId, effectiveTransforms, markColor.selectField);
		untrack(() => {
			setup?.destroy();
			if (table) setup = new BaseMarkSetup(config, coordinator, chartContext, markId);
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
				markType: 'barx',
				chartContext,
				columns: {
					xLow: hasStackTransform ? 'x0' : typeof x1 === 'number' ? x1 : 'x1',
					xHigh: hasStackTransform ? 'x1' : 'x2',
					y: 'y'
				},
				channelFields: setup.channelFieldMap,
				colorColumn: 'fill',
				bandAxes: { y: true },
				markColor,
				displayFields: resolvedTip.displayFields
			})
		);
		return () => tm.unregisterMark(markId);
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
		alphaData={opacityData}
		colorMode={markColor.colorMode}
		colorScaleIndex={markColor.colorScaleIndex}
		constantColor={markColor.constantColor}
		facetData={setup?.facetData}
		dataVersion={setup?.client?.dataVersion || 0}
		{inset}
		{dx}
		{dy}
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
