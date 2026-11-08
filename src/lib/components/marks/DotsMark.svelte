<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycleV2 } from './lifecycle/MarkLifecycleV2.svelte';
	import { Dots } from '../rendering';
	import { getGPUContext } from '$lib/gpu';
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
		generateMarkId,
		resolveTip
	} from './utils';
	import { buildReactiveConfig } from './utils/reactive-config';
	import type {
		FieldRef,
		ColorProp,
		BaseMarkProps,
		ContinuousScaleTypeProps,
		ChartContext
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { QueryEngine } from '$lib/query-engine/QueryEngine';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

	interface Props extends BaseMarkProps, ContinuousScaleTypeProps {
		x: FieldRef;
		y: FieldRef;
		fill?: ColorProp;
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
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = [],
		sort = null,
		domain = null,
		tooltip = true,
		tooltipProximity,
		tip = undefined,
		fitDomain = undefined
	}: Props = $props();

	const markId = generateMarkId('dot');
	const queryEngine = getContext<QueryEngine>('query-engine');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const gpuCoordinator = getGPUContext();

	// --- ChartConfig registration ---
	const entry = chartContext.config.registerMark(markId, 'dot', {
		table: () => table,
		x: () => x,
		y: () => y,
		fill: () => fill,
		scheme: () => scheme,
		opacity: () => opacity,
		r: () => r,
		radiusRange: () => radiusRange,
		transforms: () => transforms,
		selection: () => selection,
		limit: () => limit,
		preferredXScaleType: () => preferredXScaleType,
		preferredYScaleType: () => preferredYScaleType,
		sort: () => sort,
		domain: () => domain,
		tooltip: () => tooltip,
		tooltipProximity: () => tooltipProximity,
		tip: () => tip,
		fitDomain: () => fitDomain
	});

	let setup = $state<MarkLifecycleV2 | null>(null);

	// 0. Scale Type Inference — reads from entry
	const effectiveXScaleType = $derived.by(() =>
		inferMarkScaleType(entry.x, entry.table, entry.preferredXScaleType)
	);
	const effectiveYScaleType = $derived.by(() =>
		inferMarkScaleType(entry.y, entry.table, entry.preferredYScaleType)
	);

	// 1. Color Logic — reads from entry
	const markColor = new MarkColor(
		() => entry.fill,
		() => entry.scheme,
		'fill',
		() => entry.table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// 1b. Size Logic — reads from entry
	const markSize = new MarkSize(
		() => entry.r,
		() => entry.radiusRange,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// 2. Config — reads from entry
	const channelSelect = $derived(
		buildSelectFromChannels({
			x: entry.x,
			y: entry.y,
			...(markColor.selectField && { fill: markColor.selectField }),
			...(markSize.selectField && { r: markSize.selectField })
		})
	);
	const resolvedTip = $derived(resolveTip(entry.tip, channelSelect));

	const resolvedFitAxis = $derived.by(() => {
		const fd = entry.fitDomain;
		if (!fd) return null;
		return fd === 'x' ? 'x' : fd === 'y' ? 'y' : 'y';
	});

	const config = $derived({
		markType: 'dot',
		supportedScaleTypes: {
			x: ['linear', 'identity', 'band', 'point', 'time', 'log', 'symlog'],
			y: ['linear', 'identity', 'band', 'point', 'time', 'log', 'symlog']
		},
		scaleRequirements: {
			x: effectiveXScaleType
				? {
						type: effectiveXScaleType,
						priority: SCALE_PRIORITIES.PREFER,
						config: resolvedFitAxis === 'x' ? { __fitDomain: true } : {}
					}
				: null,
			y: effectiveYScaleType
				? {
						type: effectiveYScaleType,
						priority: SCALE_PRIORITIES.PREFER,
						config: resolvedFitAxis === 'y' ? { __fitDomain: true } : {}
					}
				: null
		},
		inferredScaleColumns: {
			x: entry.x,
			y: entry.y
		},
		table: entry.table,
		transforms: entry.transforms ?? [],
		select: { ...channelSelect, ...resolvedTip.extraSelect }
	});

	const reactiveConfig = buildReactiveConfig(entry, {
		resolveFitDomain: () => resolvedFitAxis
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, entry.x, entry.y));

	// --- DATA RESOLUTION --- reads from entry

	let xData = $derived.by(() =>
		resolveChannelData({
			value: entry.x,
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
			value: entry.y,
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
		if (typeof entry.r === 'function') {
			const xArr = setup?.data?.getColumn('x');
			const yArr = setup?.data?.getColumn('y');
			if (!xArr || !yArr) return null;
			const rFn = entry.r;
			const radii = new Float32Array(instanceCount);
			for (let i = 0; i < instanceCount; i++)
				radii[i] = rFn({ x: xArr[i] as number, y: yArr[i] as number });
			return radii;
		}
		// Constant or column name
		return resolveChannelData({
			value: entry.r,
			channel: 'r',
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 3
		});
	});

	let opacityData = $derived(
		resolveChannelData({
			value: entry.opacity,
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
			if (setup) {
				gpuCoordinator?.markForRetain(markId);
			}
			setup?.destroy();
			setup = null;
			if (entry.table && effectiveXScaleType && effectiveYScaleType && queryEngine) {
				setup = new MarkLifecycleV2(
					config,
					reactiveConfig,
					queryEngine,
					chartContext,
					markId,
					filterGroups.get(entry.selection as string | undefined)
				);
			}
		});
	});

	// Tooltip registration — guard conditions are tracked; registration body
	// runs in untrack() to avoid reactive deps on scaleTypes/colorScaleState
	// that cause spurious unregister/re-register cycles.
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !entry.tooltip || !setup?.tooltipEnabled) return;
		untrack(() => {
			tm.registerMark(
				markId,
				buildTooltipConfig({
					tempTable: setup!.tooltipTableName,
					markType: 'dot',
					chartContext,
					channelFields: setup!.channelFieldMap,
					colorColumn: 'fill',
					bandAxes: { x: true, y: true },
					markColor,
					proximityAxis: entry.tooltipProximity,
					constantRadius: typeof entry.r === 'number' ? entry.r : undefined,
					sizeScaleState: markSize.scaleState,
					displayFields: resolvedTip.displayFields
				})
			);
		});
		return () => tm.unregisterMark(markId);
	});

	onDestroy(() => {
		setup?.destroy();
		chartContext.config.unregisterMark(markId);
		gpuCoordinator?.releaseRetained(markId);
	});
</script>

{#if (setup?.gpuReady || !table) && markColor.ready && markSize.ready && xData && yData}
	<Dots
		{markId}
		{xData}
		{yData}
		{radiusData}
		alphaData={opacityData}
		colorValueData={markColor.data}
		colorMode={markColor.colorMode}
		colorScaleIndex={markColor.colorScaleIndex}
		groupIndex={setup?.groupIndex ?? 0}
		constantColor={markColor.constantColor}
		sizeMode={markSize.sizeMode}
		sizeScaleIndex={markSize.sizeScaleIndex}
		facetData={setup?.facetData}
		dataVersion={setup?.dataVersion || 0}
		bandAxis={setup?.alignedBand ?? null}
	/>
{/if}
