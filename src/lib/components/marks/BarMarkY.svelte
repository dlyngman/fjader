<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycleV2 } from './lifecycle/MarkLifecycleV2.svelte';
	import { Rects } from '../rendering';
	import { getGPUContext } from '$lib/gpu';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import {
		buildSelectFromChannels,
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
		ChartContext
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { QueryEngine } from '$lib/query-engine/QueryEngine';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

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
		domain = null,
		tooltip = true,
		tip = undefined,
		fitDomain = undefined
	}: Props = $props();

	const markId = generateMarkId('bary');
	const queryEngine = getContext<QueryEngine>('query-engine');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const gpuCoordinator = getGPUContext();

	// --- ChartConfig registration ---
	const entry = chartContext.config.registerMark(markId, 'bary', {
		table: () => table,
		x: () => x,
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
		tip: () => tip,
		fitDomain: () => fitDomain
	});

	// Observable Plot pattern: y shorthand → auto-stack, explicit y1/y2 → opt-out
	const hasExplicitBounds = $derived(entry.y1 !== undefined || entry.y2 !== undefined);
	let y1 = $derived(entry.y1 ?? 0);
	let y2 = $derived(entry.y2 ?? entry.y);
	let effectiveTransforms = $derived(
		withImplicitStack(entry.transforms ?? [], hasExplicitBounds, 'y')
	);

	let setup = $state<MarkLifecycleV2 | null>(null);

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

	const xScaleConfig = $derived.by(() => {
		const config: Record<string, unknown> = {};
		if (entry.padding != null) config.padding = entry.padding;
		if (entry.paddingInner != null) config.paddingInner = entry.paddingInner;
		if (entry.paddingOuter != null) config.paddingOuter = entry.paddingOuter;
		if (entry.align != null) config.align = entry.align;
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

	// 2. Config — reads from entry
	const channelSelect = $derived(
		buildSelectFromChannels({
			x: entry.x,
			y1,
			y2,
			...(markColor.selectField && { fill: markColor.selectField })
		})
	);
	const resolvedTip = $derived(resolveTip(entry.tip, channelSelect));

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
			x: entry.x, // X scale uses categorical column
			y: y2 // Y scale uses the value column (y2, not y1 which is baseline)
		},
		table: entry.table,
		transforms: effectiveTransforms,
		select: { ...channelSelect, ...resolvedTip.extraSelect },
		tip: entry.tip,
		clientOptions: {
			limit: entry.limit,
			filterNulls: entry.filterNulls ? ([entry.x, y1, y2] as FieldRef[]) : null
		},
		// Ensures SQL ORDER BY series, dimension for consistent stacking
		...(markColor.selectField && {
			_orderConfig: {
				seriesChannel: 'fill',
				dimensionChannel: 'x'
			}
		}),
		// Bar charts with aggregates should start at zero baseline
		zeroBaseline: hasAggregateY ? { y: true } : null,
		sort: normalizeSortConfig(entry.sort ?? null),
		domain: entry.domain ?? null,
		tooltip: entry.tip === false ? false : entry.tooltip,
		fitDomain: entry.fitDomain as 'x' | 'y' | boolean | undefined
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, y2, entry.x));

	let hasStackTransform = $derived(effectiveTransforms.some((t) => t.type === 'stack'));

	// --- DATA RESOLUTION ---

	// X Data: Categorical (Band Scale) — both x0/x1 share same band indices
	let xData = $derived.by(() => {
		const scaleType = setup?.actualXScaleType || chartContext.scaleTypes?.x || 'band';
		if (scaleType !== 'band') return null;
		const arr = resolveChannelData({
			value: entry.x,
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
			if (entry.table && queryEngine) {
				setup = new MarkLifecycleV2(
					config,
					queryEngine,
					chartContext,
					markId,
					filterGroups.get(entry.selection as string | undefined).selection
				);
			}
		});
	});

	// Tooltip registration — reads from entry
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !entry.tooltip || !setup?.tooltipEnabled) return;
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
		inset={entry.inset ?? 0}
		dx={entry.dx ?? 0}
		dy={entry.dy ?? 0}
	/>
{/if}
