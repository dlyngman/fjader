<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycle } from './lifecycle/MarkLifecycle.svelte';
	import { RuleY, GridLineY } from '../rendering';
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
		resolveTip,
		resolveSelection
	} from './utils';
	import type { FieldRef, BaseMarkProps, ColorProp, Coordinator, ChartContext } from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';

	interface Props extends BaseMarkProps {
		y: FieldRef | number;
		x?: FieldRef;
		x1?: FieldRef | number;
		x2?: FieldRef | number;
		stroke?: ColorProp;
		strokeWidth?: number;
		opacity?: number;
	}

	let {
		table = undefined,
		selection = undefined,
		y,
		x: xShorthand = undefined,
		x1: x1Prop = undefined,
		x2: x2Prop = undefined,
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

	const markId = generateMarkId('ruley');
	const coordinator = getContext<Coordinator>('mosaic-coordinator');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const gpuCoordinator = getGPUContext();

	// --- Constant-only path ---
	const isConstant = $derived(!table && typeof y === 'number');

	const constantPositions = $derived.by(() => {
		if (!isConstant) return null;
		return new Float32Array([y as number]);
	});

	const constantColor = $derived.by(() => {
		if (!isConstant) return DEFAULT_STROKE_COLOR as [number, number, number, number];
		if (typeof stroke === 'string')
			return parseColorToRGBA(stroke) as [number, number, number, number];
		return DEFAULT_STROKE_COLOR as [number, number, number, number];
	});

	// --- Data-driven path ---

	// Observable Plot shorthand: x → x1=0, x2=x
	let x1 = $derived.by(() => {
		if (x1Prop !== undefined && x2Prop !== undefined) return x1Prop;
		if (x1Prop !== undefined) return 0;
		if (x2Prop !== undefined) return 0;
		if (xShorthand !== undefined) return 0;
		return undefined;
	});

	let x2 = $derived.by(() => {
		if (x1Prop !== undefined && x2Prop !== undefined) return x2Prop;
		if (x1Prop !== undefined && x2Prop === undefined) return x1Prop;
		if (x2Prop !== undefined) return x2Prop;
		if (xShorthand !== undefined) return xShorthand;
		return undefined;
	});

	const hasExtent = $derived(x1 !== undefined && x2 !== undefined);

	let setup = $state(null);

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
		return chartContext.config.registerMark(markId, 'ruley', {
			table: () => table,
			y: () => y,
			x1: () => x1,
			x2: () => x2,
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

	const channelSelect = $derived.by(() => {
		if (!entry) return {};
		return buildSelectFromChannels({
			y: entry.y,
			...(hasExtent && { x1: entry.x1, x2: entry.x2 }),
			...(markColor.selectField && { stroke: markColor.selectField })
		});
	});

	const resolvedTip = $derived(resolveTip(entry?.tip, channelSelect));

	const scaleRequirements = $derived.by(() => {
		const reqs: Record<string, unknown> = {
			y: { type: 'linear', priority: SCALE_PRIORITIES.PREFER }
		};
		if (hasExtent) {
			reqs.x = { type: 'linear', priority: SCALE_PRIORITIES.ACCEPT };
		}
		return reqs;
	});

	const config = $derived.by(() => {
		if (!entry) return null;
		return {
			markType: 'ruley',
			supportedScaleTypes: {
				y: ['linear', 'time', 'log', 'symlog'],
				...(hasExtent && { x: ['linear', 'time', 'log', 'symlog'] })
			},
			scaleRequirements,
			inferredScaleColumns: {
				y: entry.y,
				...(hasExtent && { x: entry.x2 })
			},
			table: entry.table,
			selection: resolveSelection(entry.selection),
			transforms: entry.transforms ?? [],
			select: { ...channelSelect, ...resolvedTip.extraSelect },
			tip: entry.tip,
			constants: buildConstantsFromChannels({
				y: entry.y,
				...(hasExtent && { x1: entry.x1, x2: entry.x2 })
			}),
			clientOptions: {
				limit: entry.limit,
				filterNulls: entry.filterNulls
					? ([entry.y, ...(hasExtent ? [x1, x2] : [])] as FieldRef[])
					: null
			},
			zeroBaseline: xShorthand !== undefined ? { x: true } : null,
			sort: normalizeSortConfig(entry.sort ?? null),
			domain: entry.domain ?? null,
			tooltip: entry.tip === false ? false : entry.tooltip,
			fitDomain: entry.fitDomain as 'x' | 'y' | boolean | undefined
		};
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, y));

	// --- DATA RESOLUTION ---

	let yData = $derived(
		resolveChannelData({
			value: entry?.y ?? y,
			channel: 'y',
			dataAccessor: setup?.data,
			instanceCount
		})
	);

	let x0Data = $derived.by(() => {
		if (!hasExtent) return null;
		return resolveChannelData({
			value: x1,
			channel: 'x1',
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 0
		});
	});

	let x1Data = $derived.by(() => {
		if (!hasExtent) return null;
		return resolveChannelData({
			value: x2,
			channel: 'x2',
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
			if (entry?.table) setup = new MarkLifecycle(config, coordinator, chartContext, markId);
		});
	});

	// Tooltip registration
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !entry?.tooltip || !setup?.tooltipEnabled) return;
		tm.registerMark(
			markId,
			buildTooltipConfig({
				tempTable: setup.tooltipTableName,
				markType: 'ruley',
				chartContext,
				columns: {
					y: 'y',
					...(hasExtent && { xLow: typeof x1 === 'number' ? x1 : 'x1', xHigh: 'x2' })
				},
				channelFields: setup.channelFieldMap,
				colorColumn: 'stroke',
				markColor,
				displayFields: resolvedTip.displayFields
			})
		);
		return () => tm.unregisterMark(markId);
	});

	onDestroy(() => {
		setup?.destroy();
		if (table) chartContext.config.unregisterMark(markId);
		gpuCoordinator?.releaseRetained(markId);
	});
</script>

{#if isConstant && constantPositions}
	<!-- Constant-only path: render via GridLineY -->
	<GridLineY positions={constantPositions} color={constantColor} lineWidth={strokeWidth} />
{:else if setup?.gpuReady && markColor.ready && yData}
	<!-- Data-driven path: render via RuleY mark renderer -->
	<RuleY
		{markId}
		{yData}
		{x0Data}
		{x1Data}
		colorValueData={markColor.data}
		alphaData={opacityData}
		colorMode={markColor.colorMode}
		colorScaleIndex={markColor.colorScaleIndex}
		constantColor={markColor.constantColor}
		{strokeWidth}
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
{/if}
