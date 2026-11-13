<script lang="ts">
	import { ruleHasExtent } from '$lib/components/rendering/activity-reads';
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycleV2 } from './lifecycle/MarkLifecycleV2.svelte';
	import { RuleY, GridLine } from '../rendering';
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
		generateMarkId,
		resolveTip
	} from './utils';
	import { buildReactiveConfig } from './utils/reactive-config';
	import type { FieldRef, BaseMarkProps, ColorProp, ChartContext } from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { QueryEngine } from '$lib/query-engine/QueryEngine';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

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
		selectionResponse = undefined,
		nulls = undefined,
		holdsEntrance = undefined,
		y,
		x: xShorthand = undefined,
		x1: x1Prop = undefined,
		x2: x2Prop = undefined,
		stroke = null,
		scheme = undefined,
		strokeWidth = 1,
		opacity = 1,
		limit = undefined,
		transforms = [],
		sort = null,
		domain = null,
		tooltip = true,
		tip = undefined,
		fitDomain = undefined
	}: Props = $props();

	const markId = generateMarkId('ruley');
	const queryEngine = getContext<QueryEngine>('query-engine');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
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

	const hasExtent = $derived(ruleHasExtent(x1, x2));

	let setup = $state<MarkLifecycleV2 | null>(null);

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
	// Registered once, at mount, like every other mark. Not in a $derived:
	// registering writes the config's map, and a derived must not write state.
	// A rule without a table draws constants and has no config entry.
	const entry = untrack(() => table)
		? chartContext.config.registerMark(markId, 'ruley', {
				table: () => table,
				y: () => y,
				x1: () => x1,
				x2: () => x2,
				stroke: () => stroke,
				scheme: () => scheme,
				opacity: () => opacity,
				transforms: () => transforms,
				selection: () => selection,
				selectionResponse: () => selectionResponse,
				nulls: () => nulls,
				holdsEntrance: () => holdsEntrance,
				limit: () => limit,
				sort: () => sort,
				domain: () => domain,
				tooltip: () => tooltip,
				tip: () => tip,
				fitDomain: () => fitDomain
			})
		: null;

	const channelSelect = $derived.by(() => {
		if (!entry) return {};
		return buildSelectFromChannels({
			y: entry.y,
			...(hasExtent && { x1: entry.x1, x2: entry.x2 }),
			...(markColor.selectField && { stroke: markColor.selectField })
		});
	});

	const resolvedTip = $derived(resolveTip(entry?.tip, channelSelect));

	const scaleRequirements = $derived.by(() => ({
		x: hasExtent ? { type: 'linear' as const, priority: SCALE_PRIORITIES.ACCEPT } : null,
		y: { type: 'linear', priority: SCALE_PRIORITIES.PREFER } as const
	}));

	const resolvedFitAxis = $derived.by(() => {
		const fd = entry?.fitDomain;
		if (!fd) return null;
		return fd === 'x' ? 'x' : fd === 'y' ? 'y' : 'y';
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
			transforms: entry.transforms ?? [],
			select: { ...channelSelect, ...resolvedTip.extraSelect },
			constants: buildConstantsFromChannels({
				y: entry.y,
				...(hasExtent && { x1: entry.x1, x2: entry.x2 })
			}),
			zeroBaseline: xShorthand !== undefined ? { x: true } : null,
			// The value the renderer's x0Data is built from: routing must agree.
			ruleExtent: hasExtent,
			// Coloured by stroke: the lifecycle requests that channel's identity.
			colorChannel: 'stroke'
		};
	});

	const reactiveConfig = buildReactiveConfig(entry ?? {}, {
		resolveFitDomain: () => resolvedFitAxis
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
			if (entry?.table && queryEngine) {
				setup = new MarkLifecycleV2(
					config,
					reactiveConfig,
					queryEngine,
					chartContext,
					markId,
					filterGroups.get(entry?.selection as string | undefined)
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
					markType: 'ruley',
					chartContext,
					columns: {
						y: 'y',
						...(hasExtent && { xLow: typeof x1 === 'number' ? x1 : 'x1', xHigh: 'x2' })
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
		if (entry) chartContext.config.unregisterMark(markId);
		gpuCoordinator?.releaseRetained(markId);
	});
</script>

{#if isConstant && constantPositions}
	<!-- Constant-only path: render via GridLine -->
	<GridLine axis="y" positions={constantPositions} color={constantColor} lineWidth={strokeWidth} />
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
		groupIndex={setup?.groupIndex ?? 0}
		constantColor={markColor.constantColor}
		{strokeWidth}
		facetData={setup?.facetData}
		dataVersion={setup?.dataVersion || 0}
	/>
{/if}
