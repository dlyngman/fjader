<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte';
	import { Rects } from '../rendering';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { expandBinForExtent } from '$lib/sql/bin';
	import {
		buildSelectFromChannels,
		resolveChannelData,
		computeInstanceCount,
		buildTooltipConfig,
		MarkColor,
		normalizeSortConfig,
		inferMarkScaleType
	} from './utils';
	import type {
		FieldRef,
		ScaleType,
		BaseMarkProps,
		RectOffsetProps,
		Coordinator
	} from '$lib/types';

	interface Props extends BaseMarkProps, RectOffsetProps {
		x?: FieldRef | null;
		x1?: FieldRef | null;
		x2?: FieldRef | null;
		y: FieldRef;
		y1?: number | FieldRef;
		y2?: FieldRef;
		alpha?: number;
		preferredXScaleType?: ScaleType | null;
		viewportLocalDomain?: boolean;
	}

	let {
		table,
		selection = undefined,
		x = null,
		x1: x1Prop = null,
		x2: x2Prop = null,
		y,
		y1 = 0,
		y2 = y,
		color = null,
		scheme,
		alpha = 1,
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		transforms = [],
		viewportLocalDomain = false,
		inset = 0,
		dx = 0,
		dy = 0,
		sort = null,
		tooltip = true
	}: Props = $props();

	const markId = `recty-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext<Coordinator>('mosaic-coordinator');
	const chartContext: any = getContext('chart');
	const scaleRegistry: any = getContext('scale-registry');

	// Ensure services are ready before inference (idempotent)
	BaseMarkSetup.ensureServices(coordinator);

	let setup = $state(null);

	// --- INTERNAL BIN EXPANSION ---
	// If user provides singular x (e.g. bin('field')), expand internally to x1/x2
	const expandedX = $derived.by(() => {
		if (x != null) return expandBinForExtent(x, 'x', 'rectY');
		return { x1: x1Prop, x2: x2Prop };
	});
	const x1 = $derived(expandedX.x1);
	const x2 = $derived(expandedX.x2);

	// --- SCALE TYPE INFERENCE ---
	const effectiveXScaleType = $derived.by(() => inferMarkScaleType(x1, table, preferredXScaleType));

	// 1. Color Logic
	const markColor = new MarkColor(
		() => color,
		() => scheme,
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Detect if this is a histogram: binning on X + aggregate on Y
	const isHistogram = $derived.by(() => {
		// Check if x1 is a bin (AutoBinNode)
		const hasBinnedX = x1?.isAutoBinNode;
		// Check if y2 is an aggregate expression (has aggregate property or is SQL aggregate)
		const hasAggregateY =
			y2?.aggregate || (typeof y2 === 'object' && y2?.constructor?.name === '_AggregateNode');
		return hasBinnedX && hasAggregateY;
	});

	// 2. Config
	const config = $derived({
		markType: 'recty',
		supportedScaleTypes: {
			x: ['linear', 'band', 'point', 'time', 'log'],
			y: ['linear', 'identity']
		},
		scaleRequirements: {
			x: effectiveXScaleType
				? { type: effectiveXScaleType, priority: SCALE_PRIORITIES.PREFER }
				: null,
			y: {
				type: 'linear',
				priority: SCALE_PRIORITIES.PREFER,
				config: isHistogram ? { disableZoom: true } : {}
			}
		},
		inferredScaleColumns: {
			x: x1,
			y: y2
		},
		table,
		selection,
		transforms,
		select: buildSelectFromChannels({
			x1,
			x2,
			y1,
			y2,
			...(markColor.selectField && { color: markColor.selectField })
		}),
		clientOptions: { limit, filterNulls: filterNulls ? [x1, x2, y1, y2] : null },
		// Histograms should start at zero baseline for the aggregate dimension
		zeroBaseline: isHistogram ? { y: true } : null,
		// Viewport-local domain: compute Y extent from visible X range only
		viewportLocalDomain,
		sort: normalizeSortConfig(sort),
		tooltip
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, y2));

	let hasStackTransform = $derived(transforms.some((t) => t.type === 'stack'));

	// --- DATA RESOLUTION ---

	// X Data: Extent channels with band/linear branching
	let xData = $derived.by(() => {
		const scaleType = setup?.actualXScaleType || chartContext.scaleTypes?.x;
		if (scaleType === 'band' || scaleType === 'point') {
			const arr = resolveChannelData({
				value: x1,
				channel: 'x1',
				dataAccessor: setup?.data,
				instanceCount,
				scaleState: chartContext.xScaleState,
				scaleType,
				markId
			});
			return arr ? { x0Data: arr, x1Data: arr } : null;
		}
		const lo = resolveChannelData({
			value: x1,
			channel: 'x1',
			dataAccessor: setup?.data,
			instanceCount
		});
		const hi = resolveChannelData({
			value: x2,
			channel: 'x2',
			dataAccessor: setup?.data,
			instanceCount
		});
		return lo && hi ? { x0Data: lo, x1Data: hi } : null;
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

	let alphaData = $derived(
		resolveChannelData({
			value: alpha,
			channel: 'alpha',
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
			// Gate on effectiveXScaleType (blocks while schema loads)
			if (table && effectiveXScaleType) {
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
				markType: 'recty',
				chartContext,
				columns: { xLow: 'x1', xHigh: 'x2', yLow: typeof y1 === 'number' ? y1 : 'y1', yHigh: 'y2' },
				channelFields: {
					x: typeof x1 === 'string' ? x1 : typeof x === 'string' ? x : 'x',
					y: typeof y2 === 'string' ? y2 : typeof y === 'string' ? y : 'y',
					...(color && { color: typeof color === 'string' ? color : 'color' })
				},
				bandAxes: { x: true },
				markColorScaleState: markColor.scaleState
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
		{alphaData}
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
