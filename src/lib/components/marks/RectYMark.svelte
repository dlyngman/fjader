<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycleV2 } from './lifecycle/MarkLifecycleV2.svelte';
	import type { MarkLODSurface } from '$lib/lod/rung-types';
	import { Rects } from '../rendering';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { getGPUContext } from '$lib/gpu';
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
	import { withImplicitStack } from '$lib/transforms';
	import type {
		ChannelRef,
		FieldRef,
		ScaleType,
		BaseMarkProps,
		RectOffsetProps,
		ChartContext
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { QueryEngine } from '$lib/query-engine/QueryEngine';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

	interface Props extends BaseMarkProps, RectOffsetProps {
		x?: ChannelRef | null;
		x1?: ChannelRef | null;
		x2?: ChannelRef | null;
		y?: FieldRef;
		y1?: number | FieldRef;
		y2?: FieldRef;
		fill?: FieldRef | null;
		opacity?: number;
		preferredXScaleType?: ScaleType | null;
		fitDomain?: 'x' | 'y' | boolean;
		onMarkLOD?: (surface: MarkLODSurface | null) => void;
	}

	let {
		table,
		selection = undefined,
		selectionResponse = undefined,
		nulls = undefined,
		holdsEntrance = undefined,
		x = null,
		x1: x1Prop = null,
		x2: x2Prop = null,
		y,
		y1: y1Prop,
		y2: y2Prop,
		fill = null,
		scheme,
		opacity = 1,
		limit,
		preferredXScaleType = null,
		transforms = [],
		fitDomain = undefined,
		inset = 0.5,
		dx = 0,
		dy = 0,
		sort = null,
		domain = null,
		tooltip = true,
		tip = undefined,
		onMarkLOD = undefined
	}: Props = $props();

	const markId = generateMarkId('recty');
	const queryEngine = getContext<QueryEngine>('query-engine');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const gpuCoordinator = getGPUContext();

	// --- ChartConfig registration ---
	const entry = chartContext.config.registerMark(markId, 'recty', {
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
		selectionResponse: () => selectionResponse,
		nulls: () => nulls,
		holdsEntrance: () => holdsEntrance,
		limit: () => limit,
		preferredXScaleType: () => preferredXScaleType,
		fitDomain: () => fitDomain,
		inset: () => inset,
		dx: () => dx,
		dy: () => dy,
		sort: () => sort,
		domain: () => domain,
		tooltip: () => tooltip,
		tip: () => tip
	});

	// Observable Plot pattern: y shorthand → auto-stack, explicit y1/y2 → opt-out
	const hasExplicitBounds = $derived(entry.y1 !== undefined || entry.y2 !== undefined);
	let y1 = $derived(entry.y1 ?? 0);
	let y2 = $derived(entry.y2 ?? entry.y);
	let effectiveTransforms = $derived(
		withImplicitStack(entry.transforms ?? [], hasExplicitBounds, 'y')
	);

	let setup = $state<MarkLifecycleV2 | null>(null);

	// --- INTERNAL BIN EXPANSION --- reads from entry
	const expandedX = $derived.by(() => {
		if (entry.x != null) return expandBinForExtent(entry.x, 'x', 'rectY');
		return { x1: entry.x1, x2: entry.x2 };
	});
	const x1Expanded = $derived(expandedX.x1 as FieldRef | null);
	const x2Expanded = $derived(expandedX.x2 as FieldRef | null);

	// --- SCALE TYPE INFERENCE --- reads from entry
	const effectiveXScaleType = $derived.by(() =>
		inferMarkScaleType(x1Expanded, entry.table, entry.preferredXScaleType)
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

	// Detect if this is a histogram: binning on X + aggregate on Y
	const isHistogram = $derived.by(() => {
		// Check if x1Expanded is a bin (AutoBinNode)
		const hasBinnedX =
			typeof x1Expanded === 'object' &&
			x1Expanded != null &&
			'isAutoBinNode' in x1Expanded &&
			x1Expanded.isAutoBinNode;
		const hasAggregateY =
			typeof y2 === 'object' && y2 != null && (y2 as { type?: unknown }).type === 'AGGREGATE';
		return hasBinnedX && hasAggregateY;
	});

	// 2. Config — reads from entry
	const channelSelect = $derived(
		buildSelectFromChannels({
			x1: x1Expanded,
			x2: x2Expanded,
			y1,
			y2,
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
		markType: 'recty',
		supportedScaleTypes: {
			x: ['linear', 'band', 'point', 'time', 'log', 'symlog'],
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
			x: x1Expanded ?? undefined,
			y: y2 ?? undefined
		},
		table: entry.table,
		transforms: effectiveTransforms,
		select: { ...channelSelect, ...resolvedTip.extraSelect },
		// Ensures SQL ORDER BY series, dimension for consistent stacking
		...(markColor.selectField && {
			_orderConfig: {
				seriesChannel: 'fill',
				dimensionChannel: 'x1'
			}
		}),
		// Histograms should start at zero baseline for the aggregate dimension
		zeroBaseline: isHistogram ? { y: true } : null
	});

	const reactiveConfig = buildReactiveConfig(entry, {
		resolveFitDomain: () => resolvedFitAxis
	});

	// Rebuild only when a scale is replaced, not on its first resolution.
	let scaleGeneration = $derived(chartContext.scaleGeneration);

	let instanceCount = $derived(computeInstanceCount(setup?.data, y2));

	let hasStackTransform = $derived(effectiveTransforms.some((t) => t.type === 'stack'));

	// --- DATA RESOLUTION ---

	// X Data: Extent channels with band/linear branching
	let xData = $derived.by(() => {
		const scaleType = setup?.actualXScaleType || chartContext.scaleTypes?.x;
		if (isCategoricalScale(scaleType)) {
			const arr = resolveChannelData({
				value: x1Expanded,
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
			value: x1Expanded,
			channel: 'x1',
			dataAccessor: setup?.data,
			instanceCount
		});
		const hi = resolveChannelData({
			value: x2Expanded,
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
			// Gate on effectiveXScaleType (blocks while schema loads)
			if (entry.table && effectiveXScaleType && queryEngine) {
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
					markType: 'recty',
					chartContext,
					// Must mirror the render channels above (:260, :272): a stack transform
					// emits y0/y1, so hit-testing y1/y2 would target the unstacked extents
					// while the geometry is stacked.
					columns: {
						xLow: 'x1',
						xHigh: 'x2',
						yLow: hasStackTransform ? 'y0' : typeof y1 === 'number' ? y1 : 'y1',
						yHigh: hasStackTransform ? 'y1' : 'y2'
					},
					channelFields: setup!.channelFieldMap,
					colorColumn: 'fill',
					bandAxes: { x: true },
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
		groupIndex={setup?.groupIndex ?? 0}
		constantColor={markColor.constantColor}
		facetData={setup?.facetData}
		dataVersion={setup?.dataVersion || 0}
		landsFor={setup?.landsFor ?? 0}
		bandAxis={setup?.alignedBand ?? null}
		grow={hasExplicitBounds ? null : 'y'}
		inset={entry.inset ?? 0.5}
		dx={entry.dx ?? 0}
		dy={entry.dy ?? 0}
	/>
{/if}
