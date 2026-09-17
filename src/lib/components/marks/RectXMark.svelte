<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycleV2 } from './lifecycle/MarkLifecycleV2.svelte';
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
	import { withImplicitStack } from '$lib/transforms';
	import { isNode } from '@uwdata/mosaic-sql';
	import type {
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
		x: FieldRef;
		x1?: number | FieldRef;
		x2?: FieldRef;
		y?: FieldRef | null;
		y1?: FieldRef | null;
		y2?: FieldRef | null;
		fill?: FieldRef | null;
		opacity?: number;
		preferredYScaleType?: ScaleType | null;
		fitDomain?: 'x' | 'y' | boolean;
	}

	let {
		table,
		selection = undefined,
		x,
		x1: x1Prop,
		x2: x2Prop,
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
		fitDomain = undefined,
		inset = 0.5,
		dx = 0,
		dy = 0,
		sort = null,
		domain = null,
		tooltip = true,
		tip = undefined
	}: Props = $props();

	const markId = generateMarkId('rectx');
	const queryEngine = getContext<QueryEngine>('query-engine');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const gpuCoordinator = getGPUContext();

	// --- ChartConfig registration ---
	const entry = chartContext.config.registerMark(markId, 'rectx', {
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
		preferredYScaleType: () => preferredYScaleType,
		fitDomain: () => fitDomain,
		inset: () => inset,
		dx: () => dx,
		dy: () => dy,
		sort: () => sort,
		domain: () => domain,
		tooltip: () => tooltip,
		tip: () => tip
	});

	// Observable Plot pattern: x shorthand → auto-stack, explicit x1/x2 → opt-out
	const hasExplicitBounds = $derived(entry.x1 !== undefined || entry.x2 !== undefined);
	let x1 = $derived(entry.x1 ?? 0);
	let x2 = $derived(entry.x2 ?? entry.x);
	let effectiveTransforms = $derived(
		withImplicitStack(entry.transforms ?? [], hasExplicitBounds, 'x')
	);

	let setup = $state<MarkLifecycleV2 | null>(null);

	// --- INTERNAL BIN EXPANSION --- reads from entry
	const expandedY = $derived.by(() => {
		if (entry.y != null) return expandBinForExtent(entry.y, 'y', 'rectX');
		return { y1: entry.y1, y2: entry.y2 };
	});
	const ey1 = $derived(expandedY.y1 as FieldRef | null);
	const ey2 = $derived(expandedY.y2 as FieldRef | null);

	// --- SCALE TYPE INFERENCE --- reads from entry
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

	// Detect if this is a histogram: binning on Y + aggregate on X
	const isHistogram = $derived.by(() => {
		// Check if y1 is a bin (AutoBinNode)
		const hasBinnedY =
			ey1 != null && typeof ey1 === 'object' && 'isAutoBinNode' in ey1 && ey1.isAutoBinNode;
		const hasAggregateX = isNode(x2) && x2.type === 'AGGREGATE';
		return hasBinnedY && hasAggregateX;
	});

	// 2. Config — reads from entry
	const channelSelect = $derived(
		buildSelectFromChannels({
			x1,
			x2,
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
		markType: 'rectx',
		supportedScaleTypes: {
			x: ['linear', 'identity'],
			y: ['linear', 'band', 'point', 'time', 'log', 'symlog']
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
		table: entry.table,
		transforms: effectiveTransforms,
		select: { ...channelSelect, ...resolvedTip.extraSelect },
		// Ensures SQL ORDER BY series, dimension for consistent stacking
		...(markColor.selectField && {
			_orderConfig: {
				seriesChannel: 'fill',
				dimensionChannel: 'y1'
			}
		}),
		// Histograms should start at zero baseline for the aggregate dimension
		zeroBaseline: isHistogram ? { x: true } : null
	});

	const reactiveConfig = buildReactiveConfig(entry, {
		resolveFitDomain: () => resolvedFitAxis
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, x2));

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
			// Gate on effectiveYScaleType (blocks while schema loads)
			if (entry.table && effectiveYScaleType && queryEngine) {
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
					markType: 'rectx',
					chartContext,
					// Must mirror the render channels above (:221, :233): a stack transform
					// emits x0/x1, so hit-testing x1/x2 would target the unstacked extents
					// while the geometry is stacked.
					columns: {
						xLow: hasStackTransform ? 'x0' : typeof x1 === 'number' ? x1 : 'x1',
						xHigh: hasStackTransform ? 'x1' : 'x2',
						yLow: 'y1',
						yHigh: 'y2'
					},
					channelFields: setup!.channelFieldMap,
					colorColumn: 'fill',
					bandAxes: { y: true },
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
		bandAxis={setup?.alignedBand ?? null}
		inset={entry.inset ?? 0.5}
		dx={entry.dx ?? 0}
		dy={entry.dy ?? 0}
	/>
{:else}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12"
		>Initializing rects...</text
	>
{/if}
