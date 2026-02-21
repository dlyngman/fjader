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
		inferMarkScaleType,
		generateMarkId
	} from './utils';
	import type {
		FieldRef,
		ScaleType,
		BaseMarkProps,
		RectOffsetProps,
		Coordinator,
		ChartContext
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';

	interface Props extends BaseMarkProps, RectOffsetProps {
		x: FieldRef;
		x1?: number | FieldRef;
		x2?: FieldRef;
		y?: FieldRef | null;
		y1?: FieldRef | null;
		y2?: FieldRef | null;
		fill?: FieldRef | null;
		opacity?: number;
		preferredYScaleType?: ScaleType | null;
		viewportLocalDomain?: boolean;
	}

	let {
		table,
		selection = undefined,
		x,
		x1 = 0,
		x2 = x,
		y = null,
		y1: y1Prop = null,
		y2: y2Prop = null,
		fill = null,
		scheme,
		opacity = 1,
		limit,
		filterNulls = false,
		preferredYScaleType = null,
		transforms = [],
		viewportLocalDomain = false,
		inset = 0,
		dx = 0,
		dy = 0,
		sort = null,
		tooltip = true
	}: Props = $props();

	const markId = generateMarkId('rectx');
	const coordinator = getContext<Coordinator>('mosaic-coordinator');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	// Ensure services are ready before inference (idempotent)
	BaseMarkSetup.ensureServices(coordinator);

	let setup = $state(null);

	// --- INTERNAL BIN EXPANSION ---
	// If user provides singular y (e.g. bin('field')), expand internally to y1/y2
	const expandedY = $derived.by(() => {
		if (y != null) return expandBinForExtent(y, 'y', 'rectX');
		return { y1: y1Prop, y2: y2Prop };
	});
	const ey1 = $derived(expandedY.y1);
	const ey2 = $derived(expandedY.y2);

	// --- SCALE TYPE INFERENCE ---
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

	// Detect if this is a histogram: binning on Y + aggregate on X
	const isHistogram = $derived.by(() => {
		// Check if y1 is a bin (AutoBinNode)
		const hasBinnedY = ey1?.isAutoBinNode;
		// Check if x2 is an aggregate expression
		const hasAggregateX =
			x2?.aggregate || (typeof x2 === 'object' && x2?.constructor?.name === '_AggregateNode');
		return hasBinnedY && hasAggregateX;
	});

	// 2. Config
	const config = $derived({
		markType: 'rectx',
		supportedScaleTypes: {
			x: ['linear', 'identity'],
			y: ['linear', 'band', 'point', 'time', 'log']
		},
		scaleRequirements: {
			x: {
				type: 'linear',
				priority: SCALE_PRIORITIES.PREFER,
				config: isHistogram ? { disableZoom: true } : {}
			},
			y: effectiveYScaleType
				? { type: effectiveYScaleType, priority: SCALE_PRIORITIES.PREFER }
				: null
		},
		inferredScaleColumns: {
			x: x2,
			y: ey1
		},
		table,
		selection,
		transforms,
		select: buildSelectFromChannels({
			x1,
			x2,
			y1: ey1,
			y2: ey2,
			...(markColor.selectField && { fill: markColor.selectField })
		}),
		clientOptions: { limit, filterNulls: filterNulls ? [x1, x2, ey1, ey2] : null },
		// Histograms should start at zero baseline for the aggregate dimension
		zeroBaseline: isHistogram ? { x: true } : null,
		// Viewport-local domain: compute X extent from visible Y range only
		viewportLocalDomain,
		sort: normalizeSortConfig(sort),
		tooltip
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, x2));

	let hasStackTransform = $derived(transforms.some((t) => t.type === 'stack'));

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

	// Y Data: Extent channels with band/linear branching
	let yData = $derived.by(() => {
		const scaleType = setup?.actualYScaleType || chartContext.scaleTypes?.y;
		if (scaleType === 'band' || scaleType === 'point') {
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
			// Gate on effectiveYScaleType (blocks while schema loads)
			if (table && effectiveYScaleType) {
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
				markType: 'rectx',
				chartContext,
				columns: { xLow: typeof x1 === 'number' ? x1 : 'x1', xHigh: 'x2', yLow: 'y1', yHigh: 'y2' },
				channelFields: {
					x: typeof x2 === 'string' ? x2 : typeof x === 'string' ? x : 'x',
					y: typeof ey1 === 'string' ? ey1 : typeof y === 'string' ? y : 'y',
					...(fill && typeof fill === 'string' && { color: fill })
				},
				bandAxes: { y: true },
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
