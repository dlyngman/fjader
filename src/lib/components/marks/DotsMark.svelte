<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte';
	import { Dots } from '../rendering';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import {
		buildSelectFromChannels,
		resolveChannel,
		toFloat32,
		resolveChannelData,
		computeInstanceCount,
		buildTooltipConfig,
		MarkColor,
		MarkSize,
		normalizeSortConfig,
		inferMarkScaleType,
		generateMarkId
	} from './utils';
	import type {
		FieldRef,
		BaseMarkProps,
		ContinuousScaleTypeProps,
		Coordinator,
		ChartContext
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';

	interface Props extends BaseMarkProps, ContinuousScaleTypeProps {
		x: FieldRef;
		y: FieldRef;
		fill?: FieldRef | null;
		opacity?: number;
		r?: number | string | ((point: { x: number; y: number }) => number);
		radiusRange?: [number, number];
	}

	let {
		table,
		selection = undefined,
		x,
		y,
		fill = null,
		scheme,
		opacity = 0.5,
		r = 3,
		radiusRange = [2, 12],
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = [],
		sort = null,
		tooltip = true
	}: Props = $props();

	const markId = generateMarkId('dot');
	const coordinator = getContext<Coordinator>('mosaic-coordinator');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	// Ensure services are ready before inference (idempotent)
	BaseMarkSetup.ensureServices(coordinator);

	let setup = $state(null);

	// 0. Scale Type Inference
	const effectiveXScaleType = $derived.by(() => inferMarkScaleType(x, table, preferredXScaleType));
	const effectiveYScaleType = $derived.by(() => inferMarkScaleType(y, table, preferredYScaleType));

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

	// 1b. Size Logic
	const markSize = new MarkSize(
		() => r,
		() => radiusRange,
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// 2. Config
	const config = $derived({
		markType: 'dot',
		supportedScaleTypes: {
			x: ['linear', 'identity', 'band', 'point', 'time', 'log'],
			y: ['linear', 'identity', 'band', 'point', 'time', 'log']
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
			x: x, // X scale uses x column
			y: y // Y scale uses y column
		},
		table,
		selection,
		transforms,
		select: buildSelectFromChannels({
			x,
			y,
			...(markColor.selectField && { fill: markColor.selectField }),
			...(markSize.selectField && { r: markSize.selectField })
		}),
		clientOptions: { limit, filterNulls: filterNulls ? [x, y] : null },
		sort: normalizeSortConfig(sort),
		tooltip
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, x, y));

	// --- DATA RESOLUTION ---

	let xData = $derived.by(() =>
		resolveChannelData({
			value: x,
			channel: 'x',
			dataAccessor: setup?.data,
			instanceCount,
			scaleState: chartContext.xScaleState,
			scaleType: setup?.actualXScaleType || chartContext.scaleTypes?.x,
			markId
		})
	);

	let yData = $derived.by(() =>
		resolveChannelData({
			value: y,
			channel: 'y',
			dataAccessor: setup?.data,
			instanceCount,
			scaleState: chartContext.yScaleState,
			scaleType: setup?.actualYScaleType || chartContext.scaleTypes?.y,
			markId
		})
	);

	let radiusData = $derived.by(() => {
		if (!instanceCount) return null;
		// Field mode: data comes from MarkSize (raw values, shader does scaling)
		if (markSize.sizeMode === 1) return markSize.data;
		// Function mode
		if (typeof r === 'function') {
			const xArr = setup?.data?.getColumn('x');
			const yArr = setup?.data?.getColumn('y');
			if (!xArr || !yArr) return null;
			const radii = new Float32Array(instanceCount);
			for (let i = 0; i < instanceCount; i++) radii[i] = r({ x: xArr[i], y: yArr[i] });
			return radii;
		}
		// Constant or column name
		return resolveChannelData({
			value: r,
			channel: 'r',
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 3
		});
	});

	let opacityData = $derived(
		resolveChannelData({
			value: opacity,
			channel: 'opacity',
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 0.5
		})
	);

	// --- SETUP LIFECYCLE ---

	$effect(() => {
		(void config, xScaleId, yScaleId);
		untrack(() => {
			setup?.destroy();
			setup = null;
			// Don't create BaseMarkSetup until scale type inference has resolved.
			// When effectiveXScaleType or effectiveYScaleType is null (schema pending),
			// config.scaleRequirements will have null entries — skip creation to avoid
			// a throwaway instance that gets immediately destroyed when schema arrives.
			if (table && effectiveXScaleType && effectiveYScaleType) {
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
				markType: 'dot',
				chartContext,
				channelFields: {
					x: typeof x === 'string' ? x : 'x',
					y: typeof y === 'string' ? y : 'y',
					...(fill && typeof fill === 'string' && { color: fill })
				},
				bandAxes: { x: true, y: true },
				markColorScaleState: markColor.scaleState
			})
		);
		return () => tm.unregisterMark(markId);
	});

	onDestroy(() => {
		setup?.destroy();
	});
</script>

{#if (setup?.gpuReady || !table) && markColor.ready && markSize.ready && xData && yData}
	<Dots
		{xData}
		{yData}
		{radiusData}
		alphaData={opacityData}
		colorValueData={markColor.data}
		colorMode={markColor.colorMode}
		colorScaleIndex={markColor.colorScaleIndex}
		constantColor={markColor.constantColor}
		sizeMode={markSize.sizeMode}
		sizeScaleIndex={markSize.sizeScaleIndex}
		facetData={setup?.facetData}
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
		>Initializing mark...</text
	>
{/if}
