<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycleV2 } from './lifecycle/MarkLifecycleV2.svelte';
	import { RuleX, GridLineX } from '../rendering';
	import { getGPUContext } from '$lib/gpu';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { parseColorToRGBA, DEFAULT_STROKE_COLOR } from '$lib/scales/color-utils';
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
	import type { FieldRef, BaseMarkProps, ColorProp, ChartContext } from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { QueryEngine } from '$lib/query-engine/QueryEngine';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

	interface Props extends BaseMarkProps {
		x: FieldRef | number;
		y?: FieldRef;
		y1?: FieldRef | number;
		y2?: FieldRef | number;
		stroke?: ColorProp;
		strokeWidth?: number;
		opacity?: number;
	}

	let {
		table = undefined,
		selection = undefined,
		x,
		y: yShorthand = undefined,
		y1: y1Prop = undefined,
		y2: y2Prop = undefined,
		stroke = null,
		scheme = undefined,
		strokeWidth = 1,
		opacity = 1,
		limit = undefined,
		filterNulls = false,
		transforms = [],
		sort = null,
		domain = null,
		tooltip = true,
		tip = undefined,
		fitDomain = undefined
	}: Props = $props();

	const markId = generateMarkId('rulex');
	const queryEngine = getContext<QueryEngine>('query-engine');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const gpuCoordinator = getGPUContext();

	// --- Constant-only path ---
	// When no table and x is a number, render directly via GridLineX
	const isConstant = $derived(!table && typeof x === 'number');

	const constantPositions = $derived.by(() => {
		if (!isConstant) return null;
		return new Float32Array([x as number]);
	});

	const constantColor = $derived.by(() => {
		if (!isConstant) return DEFAULT_STROKE_COLOR as [number, number, number, number];
		if (typeof stroke === 'string')
			return parseColorToRGBA(stroke) as [number, number, number, number];
		return DEFAULT_STROKE_COLOR as [number, number, number, number];
	});

	// --- Data-driven path ---

	// Observable Plot shorthand: y → y1=0, y2=y
	let y1 = $derived.by(() => {
		if (y1Prop !== undefined && y2Prop !== undefined) return y1Prop;
		if (y1Prop !== undefined) return 0; // y1 only → y1=0, y2=original y1
		if (y2Prop !== undefined) return 0; // y2 only → y1=0
		if (yShorthand !== undefined) return 0; // y shorthand → y1=0
		return undefined;
	});

	let y2 = $derived.by(() => {
		if (y1Prop !== undefined && y2Prop !== undefined) return y2Prop;
		if (y1Prop !== undefined && y2Prop === undefined) return y1Prop; // y1 only → original y1 becomes y2
		if (y2Prop !== undefined) return y2Prop;
		if (yShorthand !== undefined) return yShorthand; // y shorthand → y2=y
		return undefined;
	});

	const hasExtent = $derived(y1 !== undefined && y2 !== undefined);

	let setup = $state<MarkLifecycleV2 | null>(null);

	// Color via MarkColor (stroke channel)
	const markColor = new MarkColor(
		() => (entry ? entry.stroke : null),
		() => (entry ? entry.scheme : scheme),
		'stroke',
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// --- ChartConfig registration (data-driven only) ---
	const entry = $derived.by(() => {
		if (!table) return null;
		return chartContext.config.registerMark(markId, 'rulex', {
			table: () => table,
			x: () => x,
			y1: () => y1,
			y2: () => y2,
			stroke: () => stroke,
			scheme: () => scheme,
			opacity: () => opacity,
			transforms: () => transforms,
			selection: () => selection,
			limit: () => limit,
			filterNulls: () => filterNulls,
			sort: () => sort,
			domain: () => domain,
			tooltip: () => tooltip,
			tip: () => tip,
			fitDomain: () => fitDomain
		});
	});

	// Config for MarkLifecycle
	const channelSelect = $derived.by(() => {
		if (!entry) return {};
		return buildSelectFromChannels({
			x: entry.x,
			...(hasExtent && { y1: entry.y1, y2: entry.y2 }),
			...(markColor.selectField && { stroke: markColor.selectField })
		});
	});

	const resolvedTip = $derived(resolveTip(entry?.tip, channelSelect));

	const scaleRequirements = $derived.by(() => ({
		x: { type: 'linear', priority: SCALE_PRIORITIES.PREFER } as const,
		y: hasExtent ? { type: 'linear' as const, priority: SCALE_PRIORITIES.ACCEPT } : null
	}));

	const config = $derived.by(() => {
		if (!entry) return null;
		return {
			markType: 'rulex',
			supportedScaleTypes: {
				x: ['linear', 'time', 'log', 'symlog'],
				...(hasExtent && { y: ['linear', 'time', 'log', 'symlog'] })
			},
			scaleRequirements,
			inferredScaleColumns: {
				x: entry.x,
				...(hasExtent && { y: entry.y2 })
			},
			table: entry.table,
			transforms: entry.transforms ?? [],
			select: { ...channelSelect, ...resolvedTip.extraSelect },
			tip: entry.tip,
			constants: buildConstantsFromChannels({
				x: entry.x,
				...(hasExtent && { y1: entry.y1, y2: entry.y2 })
			}),
			clientOptions: {
				limit: entry.limit,
				filterNulls: entry.filterNulls
					? ([entry.x, ...(hasExtent ? [y1, y2] : [])] as FieldRef[])
					: null
			},
			// When y shorthand is used, include 0 in domain
			zeroBaseline: yShorthand !== undefined ? { y: true } : null,
			sort: normalizeSortConfig(entry.sort ?? null),
			domain: entry.domain ?? null,
			tooltip: entry.tip === false ? false : entry.tooltip,
			fitDomain: entry.fitDomain as 'x' | 'y' | boolean | undefined
		};
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, x));

	// --- DATA RESOLUTION ---

	let xData = $derived(
		resolveChannelData({
			value: entry?.x ?? x,
			channel: 'x',
			dataAccessor: setup?.data,
			instanceCount
		})
	);

	let y0Data = $derived.by(() => {
		if (!hasExtent) return null;
		return resolveChannelData({
			value: y1,
			channel: 'y1',
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 0
		});
	});

	let y1Data = $derived.by(() => {
		if (!hasExtent) return null;
		return resolveChannelData({
			value: y2,
			channel: 'y2',
			dataAccessor: setup?.data,
			instanceCount
		});
	});

	let opacityData = $derived(
		resolveChannelData({
			value: entry?.opacity ?? opacity,
			channel: 'opacity',
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 1
		})
	);

	// --- SETUP LIFECYCLE ---

	$effect(() => {
		if (!config) return;
		(void config, xScaleId, yScaleId);
		untrack(() => {
			if (setup) {
				gpuCoordinator?.markForRetain(markId);
			}
			setup?.destroy();
			setup = null;
			if (entry?.table && queryEngine) {
				setup = new MarkLifecycleV2(
					config,
					queryEngine,
					chartContext,
					markId,
					filterGroups.get(entry?.selection as string | undefined).selection
				);
			}
		});
	});

	// Tooltip registration — guard conditions are tracked; registration body
	// runs in untrack() to avoid reactive deps on scaleTypes/colorScaleState
	// that cause spurious unregister/re-register cycles.
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !entry?.tooltip || !setup?.tooltipEnabled) return;
		untrack(() => {
			tm.registerMark(
				markId,
				buildTooltipConfig({
					tempTable: setup!.tooltipTableName,
					markType: 'rulex',
					chartContext,
					columns: {
						x: 'x',
						...(hasExtent && { yLow: typeof y1 === 'number' ? y1 : 'y1', yHigh: 'y2' })
					},
					channelFields: setup!.channelFieldMap,
					colorColumn: 'stroke',
					markColor,
					displayFields: resolvedTip.displayFields
				})
			);
		});
		return () => tm.unregisterMark(markId);
	});

	onDestroy(() => {
		setup?.destroy();
		if (table) chartContext.config.unregisterMark(markId);
		gpuCoordinator?.releaseRetained(markId);
	});
</script>

{#if isConstant && constantPositions}
	<!-- Constant-only path: render via GridLineX -->
	<GridLineX positions={constantPositions} color={constantColor} lineWidth={strokeWidth} />
{:else if setup?.gpuReady && markColor.ready && xData}
	<!-- Data-driven path: render via RuleX mark renderer -->
	<RuleX
		{markId}
		{xData}
		{y0Data}
		{y1Data}
		colorValueData={markColor.data}
		alphaData={opacityData}
		colorMode={markColor.colorMode}
		colorScaleIndex={markColor.colorScaleIndex}
		constantColor={markColor.constantColor}
		{strokeWidth}
		facetData={setup?.facetData}
		dataVersion={setup?.dataVersion || 0}
	/>
{/if}
