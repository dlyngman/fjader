<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycleV2 } from './lifecycle/MarkLifecycleV2.svelte';
	import { Rects } from '../rendering';
	import { getGPUContext } from '$lib/gpu';
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
	import { buildReactiveConfig } from './utils/reactive-config';
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
		x1?: number | FieldRef;
		x2?: FieldRef;
		y: FieldRef;
		fill?: FieldRef | null;
		opacity?: number;
	}

	let {
		table,
		selection = undefined,
		selectionResponse = undefined,
		nulls = undefined,
		holdsEntrance = undefined,
		contributeDomain = undefined,
		x,
		x1: x1Prop,
		x2: x2Prop,
		y,
		fill = null,
		scheme,
		opacity = 1,
		limit,
		transforms = [],
		padding,
		paddingInner,
		paddingOuter,
		inset = 0,
		dx = 0,
		dy = 0,
		sort = null,
		domain = null,
		tooltip = true,
		tip = undefined,
		fitDomain = undefined
	}: Props = $props();

	const markId = generateMarkId('barx');
	const queryEngine = getContext<QueryEngine>('query-engine');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const gpuCoordinator = getGPUContext();

	// --- ChartConfig registration ---
	const entry = chartContext.config.registerMark(markId, 'barx', {
		table: () => table,
		x: () => x,
		x1: () => x1Prop,
		x2: () => x2Prop,
		y: () => y,
		fill: () => fill,
		scheme: () => scheme,
		opacity: () => opacity,
		transforms: () => transforms,
		selection: () => selection,
		selectionResponse: () => selectionResponse,
		nulls: () => nulls,
		holdsEntrance: () => holdsEntrance,
		contributeDomain: () => contributeDomain,
		limit: () => limit,
		padding: () => padding,
		paddingInner: () => paddingInner,
		paddingOuter: () => paddingOuter,
		inset: () => inset,
		dx: () => dx,
		dy: () => dy,
		sort: () => sort,
		domain: () => domain,
		tooltip: () => tooltip,
		tip: () => tip,
		fitDomain: () => fitDomain
	});

	// Observable Plot pattern: x shorthand → auto-stack, explicit x1/x2 → opt-out
	const hasExplicitBounds = $derived(entry.x1 !== undefined || entry.x2 !== undefined);
	let x1 = $derived(entry.x1 ?? 0);
	let x2 = $derived(entry.x2 ?? entry.x);
	let effectiveTransforms = $derived(
		withImplicitStack(entry.transforms ?? [], hasExplicitBounds, 'x')
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

	const yScaleConfig = $derived.by(() => {
		const config: Record<string, unknown> = {};
		if (entry.padding != null) config.padding = entry.padding;
		if (entry.paddingInner != null) config.paddingInner = entry.paddingInner;
		if (entry.paddingOuter != null) config.paddingOuter = entry.paddingOuter;
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

	// 2. Config — reads from entry
	const channelSelect = $derived(
		buildSelectFromChannels({
			x1,
			x2,
			y: entry.y,
			...(markColor.selectField && { fill: markColor.selectField })
		})
	);
	const resolvedTip = $derived(resolveTip(entry.tip, channelSelect));

	const config = $derived({
		markType: 'barx',
		supportedScaleTypes: { x: ['linear', 'identity'], y: ['band'] },
		scaleRequirements: {
			x: { type: 'linear', priority: SCALE_PRIORITIES.PREFER },
			y: { type: 'band', priority: SCALE_PRIORITIES.MANDATE, config: yScaleConfig }
		},
		inferredScaleColumns: {
			x: x2, // X scale uses the value column (x2, not x1 which is baseline)
			y: entry.y // Y scale uses categorical column
		},
		table: entry.table,
		transforms: effectiveTransforms,
		select: { ...channelSelect, ...resolvedTip.extraSelect },
		constants: buildConstantsFromChannels({ x1, x2, y: entry.y }),
		// Ensures SQL ORDER BY series, dimension for consistent stacking
		...(markColor.selectField && {
			_orderConfig: {
				seriesChannel: 'fill',
				dimensionChannel: 'y'
			}
		}),
		// Bar charts with aggregates should start at zero baseline
		zeroBaseline: hasAggregateX ? { x: true } : null
	});

	const reactiveConfig = buildReactiveConfig(entry);

	// Rebuild only when a scale is replaced, not on its first resolution.
	let scaleGeneration = $derived(chartContext.scaleGeneration);

	let instanceCount = $derived(computeInstanceCount(setup?.data, x2, entry.y));

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
			value: entry.y,
			channel: 'y',
			dataAccessor: setup?.data,
			instanceCount,
			scaleState: chartContext.yScaleState,
			scaleType,
			markId
		});
		return arr ? { y0Data: arr, y1Data: arr } : null;
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
		(void config, scaleGeneration);
		untrack(() => {
			if (setup) {
				gpuCoordinator?.markForRetain(markId);
			}
			setup?.destroy();
			setup = null;
			if (entry.table && queryEngine) {
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
					markType: 'barx',
					chartContext,
					columns: {
						xLow: hasStackTransform ? 'x0' : typeof x1 === 'number' ? x1 : 'x1',
						xHigh: hasStackTransform ? 'x1' : 'x2',
						y: 'y'
					},
					channelFields: setup!.channelFieldMap,
					colorColumn: 'fill',
					bandAxes: { y: true },
					markColor,
					displayFields: resolvedTip.displayFields,
					otherStats: (point) => {
						const id = point.__bandIdY;
						const facet = point.__facetId;
						return typeof id === 'number'
							? setup!.otherRows.statsAt(id, typeof facet === 'number' ? facet : null)
							: null;
					}
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
		share={setup?.otherRows.split ?? null}
		colorMode={markColor.colorMode}
		colorScaleIndex={markColor.colorScaleIndex}
		groupIndex={setup?.groupIndex ?? 0}
		constantColor={markColor.constantColor}
		facetData={setup?.facetData}
		dataVersion={setup?.dataVersion || 0}
		landsFor={setup?.landsFor ?? 0}
		bandAxis={setup?.alignedBand ?? null}
		grow={hasExplicitBounds ? null : 'x'}
		inset={entry.inset ?? 0}
		dx={entry.dx ?? 0}
		dy={entry.dy ?? 0}
	/>
{/if}
