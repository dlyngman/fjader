<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycle } from './lifecycle/MarkLifecycle.svelte';
	import { Rects } from '../rendering';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { expandBinForExtent } from '$lib/sql/bin';
	import { isCategoricalScale } from '$lib/scales/scale-categories';
	import {
		buildSelectFromChannels,
		resolveChannelData,
		computeInstanceCount,
		buildTooltipConfig,
		MarkColor,
		normalizeSortConfig,
		inferMarkScaleType,
		generateMarkId,
		resolveTip,
		resolveSelection
	} from './utils';
	import type {
		FieldRef,
		ScaleType,
		BaseMarkProps,
		BandScaleProps,
		ContinuousScaleTypeProps,
		RectOffsetProps,
		Coordinator,
		ChartContext
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';

	interface Props extends BaseMarkProps, BandScaleProps, ContinuousScaleTypeProps, RectOffsetProps {
		x?: FieldRef | null;
		x1?: FieldRef | null;
		x2?: FieldRef | null;
		y?: FieldRef | null;
		y1?: FieldRef | null;
		y2?: FieldRef | null;
		fill?: FieldRef | null;
		opacity?: number;
	}

	let {
		table,
		selection = undefined,
		x = null,
		x1: x1Prop = null,
		x2: x2Prop = null,
		y = null,
		y1: y1Prop = null,
		y2: y2Prop = null,
		fill = null,
		scheme,
		opacity = 1,
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		preferredYScaleType = null,
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

	const markId = generateMarkId('rect');
	const coordinator = getContext<Coordinator>('mosaic-coordinator');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	// Ensure services are ready before inference (idempotent)
	MarkLifecycle.ensureServices(coordinator);

	let setup = $state(null);

	// --- INTERNAL BIN EXPANSION ---
	const expandedX = $derived.by(() => {
		if (x != null) return expandBinForExtent(x, 'x', 'rect');
		return { x1: x1Prop, x2: x2Prop };
	});
	const ex1 = $derived(expandedX.x1 as FieldRef | null);
	const ex2 = $derived(expandedX.x2 as FieldRef | null);

	const expandedY = $derived.by(() => {
		if (y != null) return expandBinForExtent(y, 'y', 'rect');
		return { y1: y1Prop, y2: y2Prop };
	});
	const ey1 = $derived(expandedY.y1 as FieldRef | null);
	const ey2 = $derived(expandedY.y2 as FieldRef | null);

	// --- SCALE TYPE INFERENCE ---
	const effectiveXScaleType = $derived.by(() =>
		inferMarkScaleType(ex1, table, preferredXScaleType)
	);
	const effectiveYScaleType = $derived.by(() =>
		inferMarkScaleType(ey1, table, preferredYScaleType)
	);

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

	// Band scale config (applies only when axis resolves to band)
	const bandScaleConfig = $derived.by(() => {
		const config: Record<string, unknown> = {};
		if (padding != null) config.padding = padding;
		if (paddingInner != null) config.paddingInner = paddingInner;
		if (paddingOuter != null) config.paddingOuter = paddingOuter;
		if (align != null) config.align = align;
		return config;
	});

	// 2. Config
	const channelSelect = $derived(
		buildSelectFromChannels({
			x1: ex1,
			x2: ex2,
			y1: ey1,
			y2: ey2,
			...(markColor.selectField && { fill: markColor.selectField })
		})
	);
	const resolvedTip = $derived(resolveTip(tip, channelSelect));

	const config = $derived({
		markType: 'rect',
		supportedScaleTypes: {
			x: ['linear', 'band', 'point', 'time', 'log', 'symlog'],
			y: ['linear', 'band', 'point', 'time', 'log', 'symlog']
		},
		scaleRequirements: {
			x: effectiveXScaleType
				? {
						type: effectiveXScaleType,
						priority: SCALE_PRIORITIES.PREFER,
						...(effectiveXScaleType === 'band' && { config: bandScaleConfig })
					}
				: null,
			y: effectiveYScaleType
				? {
						type: effectiveYScaleType,
						priority: SCALE_PRIORITIES.PREFER,
						...(effectiveYScaleType === 'band' && { config: bandScaleConfig })
					}
				: null
		},
		inferredScaleColumns: {
			x: ex1,
			y: ey1
		},
		table,
		selection: resolveSelection(selection),
		transforms,
		select: { ...channelSelect, ...resolvedTip.extraSelect },
		clientOptions: { limit, filterNulls: filterNulls ? [ex1, ex2, ey1, ey2] : null },
		// Note: RectMark supports bins on both axes, but zero baseline is less clear-cut
		// (could be heatmap, 2D histogram, etc.). Use RectXMark/RectYMark for histograms.
		sort: normalizeSortConfig(sort),
		tooltip: tip === false ? false : tooltip
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data));

	// --- DATA RESOLUTION ---

	// X Data: Extent channels with band/linear branching
	let xData = $derived.by(() => {
		const scaleType = setup?.actualXScaleType || chartContext.scaleTypes?.x;
		if (isCategoricalScale(scaleType)) {
			const arr = resolveChannelData({
				value: ex1,
				channel: 'x1',
				dataAccessor: setup?.data,
				instanceCount,
				scaleState: chartContext.xScaleState,
				scaleType,
				markId
			});
			return arr ? { x0Data: arr, x1Data: arr } : null;
		}
		const x0 = resolveChannelData({
			value: ex1,
			channel: 'x1',
			dataAccessor: setup?.data,
			instanceCount
		});
		const x1 = resolveChannelData({
			value: ex2,
			channel: 'x2',
			dataAccessor: setup?.data,
			instanceCount
		});
		return x0 && x1 ? { x0Data: x0, x1Data: x1 } : null;
	});

	let x0Data = $derived(xData?.x0Data);
	let x1Data = $derived(xData?.x1Data);

	// Y Data: Extent channels with band/linear branching
	let yData = $derived.by(() => {
		const scaleType = setup?.actualYScaleType || chartContext.scaleTypes?.y;
		if (isCategoricalScale(scaleType)) {
			const arr = resolveChannelData({
				value: ey1,
				channel: 'y1',
				dataAccessor: setup?.data,
				instanceCount,
				scaleState: chartContext.yScaleState,
				scaleType,
				markId
			});
			return arr ? { y0Data: arr, y1Data: arr } : null;
		}
		const y0 = resolveChannelData({
			value: ey1,
			channel: 'y1',
			dataAccessor: setup?.data,
			instanceCount
		});
		const y1 = resolveChannelData({
			value: ey2,
			channel: 'y2',
			dataAccessor: setup?.data,
			instanceCount
		});
		return y0 && y1 ? { y0Data: y0, y1Data: y1 } : null;
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
		(void config, xScaleId, yScaleId, transforms, markColor.selectField);
		untrack(() => {
			setup?.destroy();
			setup = null;
			// Gate on BOTH scale types being resolved
			if (table && effectiveXScaleType && effectiveYScaleType) {
				setup = new MarkLifecycle(config, coordinator, chartContext, markId);
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
				markType: 'rect',
				chartContext,
				columns: { xLow: 'x1', xHigh: 'x2', yLow: 'y1', yHigh: 'y2' },
				channelFields: setup.channelFieldMap,
				colorColumn: 'fill',
				bandAxes: { x: true, y: true },
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
		>Initializing rects...</text
	>
{/if}
