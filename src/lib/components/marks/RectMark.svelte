<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycleV2 } from './lifecycle/MarkLifecycleV2.svelte';
	import type { MarkLODSurface } from '$lib/lod/rung-types';
	import { Rects } from '../rendering';
	import { getGPUContext } from '$lib/gpu';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { expandBinForExtent } from '$lib/sql/bin';
	import { isCategoricalScale } from '$lib/scales/scale-categories';
	import {
		buildSelectFromChannels,
		resolveChannelData,
		computeInstanceCount,
		buildTooltipConfig,
		MarkColor,
		inferMarkScaleType,
		generateMarkId,
		resolveTip
	} from './utils';
	import { buildReactiveConfig } from './utils/reactive-config';
	import type {
		FieldRef,
		ScaleType,
		BaseMarkProps,
		BandScaleProps,
		ContinuousScaleTypeProps,
		RectOffsetProps,
		ChartContext
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { QueryEngine } from '$lib/query-engine/QueryEngine';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

	interface Props extends BaseMarkProps, BandScaleProps, ContinuousScaleTypeProps, RectOffsetProps {
		x?: FieldRef | null;
		x1?: FieldRef | null;
		x2?: FieldRef | null;
		y?: FieldRef | null;
		y1?: FieldRef | null;
		y2?: FieldRef | null;
		fill?: FieldRef | null;
		opacity?: number;
		fitDomain?: 'x' | 'y' | boolean;
		onMarkLOD?: (surface: MarkLODSurface | null) => void;
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
		inset = 0.5,
		dx = 0,
		dy = 0,
		sort = null,
		domain = null,
		tooltip = true,
		tip = undefined,
		fitDomain = undefined,
		onMarkLOD = undefined
	}: Props = $props();

	const markId = generateMarkId('rect');
	const queryEngine = getContext<QueryEngine>('query-engine');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const gpuCoordinator = getGPUContext();

	// --- ChartConfig registration ---
	const entry = chartContext.config.registerMark(markId, 'rect', {
		table: () => table,
		x: () => x,
		x1: () => x1Prop,
		x2: () => x2Prop,
		y: () => y,
		y1: () => y1Prop,
		y2: () => y2Prop,
		fill: () => fill,
		scheme: () => scheme,
		opacity: () => opacity,
		transforms: () => transforms,
		selection: () => selection,
		limit: () => limit,
		filterNulls: () => filterNulls,
		preferredXScaleType: () => preferredXScaleType,
		preferredYScaleType: () => preferredYScaleType,
		fitDomain: () => fitDomain,
		padding: () => padding,
		paddingInner: () => paddingInner,
		paddingOuter: () => paddingOuter,
		align: () => align,
		inset: () => inset,
		dx: () => dx,
		dy: () => dy,
		sort: () => sort,
		domain: () => domain,
		tooltip: () => tooltip,
		tip: () => tip
	});

	let setup = $state<MarkLifecycleV2 | null>(null);

	// --- INTERNAL BIN EXPANSION --- reads from entry
	const expandedX = $derived.by(() => {
		if (entry.x != null) return expandBinForExtent(entry.x, 'x', 'rect');
		return { x1: entry.x1, x2: entry.x2 };
	});
	const ex1 = $derived(expandedX.x1 as FieldRef | null);
	const ex2 = $derived(expandedX.x2 as FieldRef | null);

	const expandedY = $derived.by(() => {
		if (entry.y != null) return expandBinForExtent(entry.y, 'y', 'rect');
		return { y1: entry.y1, y2: entry.y2 };
	});
	const ey1 = $derived(expandedY.y1 as FieldRef | null);
	const ey2 = $derived(expandedY.y2 as FieldRef | null);

	// --- SCALE TYPE INFERENCE --- reads from entry
	const effectiveXScaleType = $derived.by(() =>
		inferMarkScaleType(ex1, entry.table, entry.preferredXScaleType)
	);
	const effectiveYScaleType = $derived.by(() =>
		inferMarkScaleType(ey1, entry.table, entry.preferredYScaleType)
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

	// Band scale config (applies only when axis resolves to band) — reads from entry
	const bandScaleConfig = $derived.by(() => {
		const config: Record<string, unknown> = {};
		if (entry.padding != null) config.padding = entry.padding;
		if (entry.paddingInner != null) config.paddingInner = entry.paddingInner;
		if (entry.paddingOuter != null) config.paddingOuter = entry.paddingOuter;
		if (entry.align != null) config.align = entry.align;
		return config;
	});

	// 2. Config — reads from entry
	const channelSelect = $derived(
		buildSelectFromChannels({
			x1: ex1,
			x2: ex2,
			y1: ey1,
			y2: ey2,
			...(markColor.selectField && { fill: markColor.selectField })
		})
	);
	const resolvedTip = $derived(resolveTip(entry.tip, channelSelect));

	const resolvedFitAxis = $derived.by(() => {
		const fd = entry.fitDomain;
		if (!fd) return null;
		return fd === 'x' ? 'x' : fd === 'y' ? 'y' : 'y';
	});

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
		table: entry.table,
		transforms: entry.transforms ?? [],
		select: { ...channelSelect, ...resolvedTip.extraSelect }
	});

	const reactiveConfig = buildReactiveConfig(entry, {
		resolveFitDomain: () => resolvedFitAxis
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
			value: entry.opacity,
			channel: 'opacity',
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 0.8
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
			// Gate on BOTH scale types being resolved
			if (entry.table && effectiveXScaleType && effectiveYScaleType && queryEngine) {
				setup = new MarkLifecycleV2(
					config,
					reactiveConfig,
					queryEngine,
					chartContext,
					markId,
					filterGroups.get(entry.selection as string | undefined),
					{ gpuCoordinator, onMarkLOD }
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
					markType: 'rect',
					chartContext,
					columns: { xLow: 'x1', xHigh: 'x2', yLow: 'y1', yHigh: 'y2' },
					channelFields: setup!.channelFieldMap,
					colorColumn: 'fill',
					bandAxes: { x: true, y: true },
					markColor,
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

{#if (setup?.gpuReady || !table) && markColor.ready && x0Data && x1Data && y0Data && y1Data}
	<Rects
		{markId}
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
		dataVersion={setup?.dataVersion || 0}
		bandAxis={null}
		inset={entry.inset ?? 0.5}
		dx={entry.dx ?? 0}
		dy={entry.dy ?? 0}
	/>
{/if}
