<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycle } from './lifecycle/MarkLifecycle.svelte';
	import { Rects } from '../rendering';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import {
		buildSelectFromChannels,
		resolveChannelData,
		computeInstanceCount,
		buildTooltipConfig,
		MarkColor,
		normalizeSortConfig,
		generateMarkId,
		resolveTip,
		resolveSelection
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
		y: FieldRef;
		y1?: number | FieldRef;
		y2?: FieldRef;
		fill?: FieldRef | null;
		opacity?: number;
	}

	let {
		table,
		selection = undefined,
		x,
		y,
		y1: y1Prop,
		y2: y2Prop,
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

	// Observable Plot pattern: y shorthand → auto-stack, explicit y1/y2 → opt-out
	const hasExplicitBounds = $derived(y1Prop !== undefined || y2Prop !== undefined);
	let y1 = $derived(y1Prop ?? 0);
	let y2 = $derived(y2Prop ?? y);
	let effectiveTransforms = $derived(withImplicitStack(transforms, hasExplicitBounds, 'y'));

	const markId = generateMarkId('bary');
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

	const xScaleConfig = $derived.by(() => {
		const config: Record<string, unknown> = {};
		if (padding != null) config.padding = padding;
		if (paddingInner != null) config.paddingInner = paddingInner;
		if (paddingOuter != null) config.paddingOuter = paddingOuter;
		if (align != null) config.align = align;
		return config;
	});

	// Detect if y2 is an aggregate expression (count, sum, mean, etc.)
	const hasAggregateY = $derived.by(() => {
		return (
			typeof y2 === 'object' &&
			y2 != null &&
			('aggregate' in y2 || y2.constructor?.name === '_AggregateNode')
		);
	});

	// 2. Config
	const channelSelect = $derived(
		buildSelectFromChannels({
			x,
			y1,
			y2,
			...(markColor.selectField && { fill: markColor.selectField })
		})
	);
	const resolvedTip = $derived(resolveTip(tip, channelSelect));

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
		selection: resolveSelection(selection),
		transforms: effectiveTransforms,
		select: { ...channelSelect, ...resolvedTip.extraSelect },
		clientOptions: { limit, filterNulls: filterNulls ? [x, y1, y2] : null },
		// Bar charts with aggregates should start at zero baseline
		zeroBaseline: hasAggregateY ? { y: true } : null,
		sort: normalizeSortConfig(sort),
		tooltip: tip === false ? false : tooltip
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, y2, x));

	let hasStackTransform = $derived(effectiveTransforms.some((t) => t.type === 'stack'));

	// --- DATA RESOLUTION ---

	// X Data: Categorical (Band Scale) — both x0/x1 share same band indices
	let xData = $derived.by(() => {
		const scaleType = setup?.actualXScaleType || chartContext.scaleTypes?.x || 'band';
		if (scaleType !== 'band') return null;
		const arr = resolveChannelData({
			value: x,
			channel: 'x',
			dataAccessor: setup?.data,
			instanceCount,
			scaleState: chartContext.xScaleState,
			scaleType,
			markId,
			suppressUnmappedWarning: setup?.hasCategoryReducingTransforms
		});
		return arr ? { x0Data: arr, x1Data: arr } : null;
	});

	let x0Data = $derived(xData?.x0Data);
	let x1Data = $derived(xData?.x1Data);

	// Y0: Stack Output -> y1 prop -> 0
	let y0Data = $derived(
		resolveChannelData({
			value: y1,
			channel: 'y1',
			dataAccessor: setup?.data,
			instanceCount,
			tryColumns: hasStackTransform ? ['y0'] : undefined,
			fallback: 0
		})
	);

	// Y1: Stack Output -> y2 prop
	let y1Data = $derived(
		resolveChannelData({
			value: y2,
			channel: 'y2',
			dataAccessor: setup?.data,
			instanceCount,
			tryColumns: hasStackTransform ? ['y1'] : undefined
		})
	);

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
			if (table) setup = new MarkLifecycle(config, coordinator, chartContext, markId);
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
				markType: 'bary',
				chartContext,
				columns: {
					x: 'x',
					yLow: hasStackTransform ? 'y0' : typeof y1 === 'number' ? y1 : 'y1',
					yHigh: hasStackTransform ? 'y1' : 'y2'
				},
				channelFields: setup.channelFieldMap,
				colorColumn: 'fill',
				bandAxes: { x: true },
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
