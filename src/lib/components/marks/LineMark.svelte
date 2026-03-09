<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycle } from './lifecycle/MarkLifecycle.svelte';
	import { Lines } from '../rendering';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import {
		buildSelectFromChannels,
		resolveChannelData,
		computeInstanceCount,
		buildTooltipConfig,
		MarkColor,
		MarkSeries,
		normalizeSortConfig,
		inferMarkScaleType,
		generateMarkId,
		resolveTip,
		resolveSelection
	} from './utils';
	import { getGPUContext } from '$lib/gpu';
	import { M4Decimator } from '$lib/gpu/decimation/M4Decimator.svelte';
	import { LODController } from '$lib/lod';
	import type {
		FieldRef,
		BaseMarkProps,
		ContinuousScaleTypeProps,
		ConnectedTopologyProps,
		Coordinator,
		ChartContext
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';

	interface Props extends BaseMarkProps, ContinuousScaleTypeProps, ConnectedTopologyProps {
		x: FieldRef;
		y: FieldRef;
		stroke?: FieldRef | null;
		strokeWidth?: number;
		dotRadius?: number;
		autoDots?: boolean;
		optimize?: boolean | 'auto';
		lod?: boolean;
		onLodController?: (ctrl: LODController | null) => void;
	}

	let {
		table,
		selection = undefined,
		x,
		y,
		stroke = null,
		z = null,
		scheme,
		curve = 'linear',
		strokeWidth = 2,
		dotRadius = 0,
		autoDots = false,
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = [],
		sort = null,
		tooltip = true,
		tooltipProximity,
		optimize = 'auto',
		tip = undefined,
		lod = false,
		onLodController = undefined
	}: Props = $props();

	// Map user-facing aliases to axis-specific variants
	const effectiveCurve = $derived(
		curve === 'monotone' ? 'monotone-x' : curve === 'bump' ? 'bump-x' : curve
	);

	const markId = generateMarkId('line');
	const coordinator = getContext<Coordinator>('mosaic-coordinator');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	// Ensure services are ready before inference (idempotent)
	MarkLifecycle.ensureServices(coordinator);

	let setup = $state(null);

	// 0. Scale Type Inference
	const effectiveXScaleType = $derived.by(() => inferMarkScaleType(x, table, preferredXScaleType));
	const effectiveYScaleType = $derived.by(() => inferMarkScaleType(y, table, preferredYScaleType));

	// Series grouping: z overrides stroke for grouping
	const seriesChannelKey = z != null ? 'z' : 'stroke';
	const markSeries = new MarkSeries(
		() => z ?? stroke,
		seriesChannelKey,
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Color: stroke determines line color
	// (stroke="steelblue" → constant color, stroke="species" → color by species)
	const markColor = new MarkColor(
		() => stroke,
		() => scheme,
		'stroke',
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Config with _connectedConfig for automatic ORDER BY
	const channelSelect = $derived(
		buildSelectFromChannels({
			x,
			y,
			...(markColor.selectField && { stroke: markColor.selectField }),
			...(z != null && markSeries.selectField && { z: markSeries.selectField })
		})
	);
	const resolvedTip = $derived(resolveTip(tip, channelSelect));

	const config = $derived({
		markType: 'line',
		supportedScaleTypes: {
			x: ['linear', 'time', 'log', 'symlog'],
			y: ['linear', 'time', 'log', 'symlog']
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
			x: x,
			y: y
		},
		table,
		selection: resolveSelection(selection),
		transforms,
		select: { ...channelSelect, ...resolvedTip.extraSelect },
		colorChannel: 'stroke',
		// Connected topology config - ensures data is ordered for line connectivity
		_connectedConfig: {
			seriesChannel: markSeries.selectField ? seriesChannelKey : null,
			dimensionChannel: 'x'
		},
		clientOptions: { limit, filterNulls: filterNulls ? [x, y] : null },
		sort: normalizeSortConfig(sort),
		tooltip: tip === false ? false : tooltip
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
			instanceCount
		})
	);

	let yData = $derived.by(() =>
		resolveChannelData({
			value: y,
			channel: 'y',
			dataAccessor: setup?.data,
			instanceCount
		})
	);

	// Series data comes from MarkSeries (uses scale infrastructure)
	let seriesData = $derived(markSeries.data);

	// --- SETUP LIFECYCLE ---

	$effect(() => {
		(void config, xScaleId, yScaleId);
		untrack(() => {
			setup?.destroy();
			setup = null;
			// Don't create MarkLifecycle until scale type inference has resolved.
			if (table && effectiveXScaleType && effectiveYScaleType) {
				setup = new MarkLifecycle(config, coordinator, chartContext, markId);
			}
		});
	});

	// MarkColor and MarkSeries connect to setup internally via their lifecycle effects

	// --- M4 DECIMATION + AUTO-DOTS ---
	const gpuCoordinator = getGPUContext();
	const faceted = !!chartContext.fx;

	// M4 always created when eligible — GPU decides per-frame whether to decimate or passthrough
	const m4Eligible = $derived.by(() => {
		if (optimize === false || faceted) return false;
		const xType = chartContext.scaleTypes?.x;
		if (xType === 'log' || xType === 'symlog') return false;
		return true;
	});

	// Auto-dots: negative dotRadius signals density-based fade to the vertex shader.
	// When LOD is active, LODController writes dotRadius directly to the GPU buffer
	// via its frame callback — no reactive chain. We set 0 here to disable the GPU
	// auto-dots path (vertex shader's dotRadius < 0.0 branch).
	const effectiveDotRadius = $derived.by(() => {
		if (lod && lodController) return 0; // LODController writes directly to GPU
		if (!autoDots) return dotRadius;
		if (optimize === true) return 0; // forced M4 — no dots on representatives
		const baseR = dotRadius > 0 ? dotRadius : 2.5;
		return -baseR; // negative = auto mode
	});

	// Full data domain span for density calculation
	const fullDomainSpan = $derived.by(() => {
		const xScale = chartContext.xScaleState;
		if (!xScale || !('effectiveExtent' in xScale)) return 0;
		const [min, max] = xScale.effectiveExtent;
		return max - min;
	});

	let m4Decimator = $state(null);

	$effect(() => {
		if (m4Eligible && gpuCoordinator?.device && gpuCoordinator?.globalScaleLayout) {
			const decimator = new M4Decimator(gpuCoordinator.device, gpuCoordinator.globalScaleLayout);
			m4Decimator = decimator;
			return () => {
				decimator.destroy();
				m4Decimator = null;
			};
		} else {
			m4Decimator = null;
		}
	});

	// --- LOD CONTROLLER ---
	let lodController: LODController | null = $state(null);

	$effect(() => {
		if (!lod || !setup || !coordinator || !gpuCoordinator) {
			lodController?.destroy();
			lodController = null;
			onLodController?.(null);
			return;
		}
		const ctrl = new LODController(coordinator, gpuCoordinator, chartContext, {
			table,
			xField: String(x),
			setup,
			m4Decimator,
			baseR: dotRadius > 0 ? dotRadius : 2.5
		});
		lodController = ctrl;
		onLodController?.(ctrl);
		return () => {
			ctrl.destroy();
			lodController = null;
			onLodController?.(null);
		};
	});

	// Configure M4 decimator when chart dimensions or series count change.
	// When stroke is set, wait for the series domain to be populated (async fetch).
	$effect(() => {
		if (!m4Decimator || !chartContext.innerWidth) return;

		let numSeries;
		if (markSeries.selectField) {
			const domain = markSeries.scaleState?.domain;
			if (!domain || domain.length === 0) return;
			numSeries = domain.length;
		} else {
			numSeries = 1;
		}

		const dpr = window.devicePixelRatio || 1;
		const numBins = Math.ceil(chartContext.innerWidth * dpr);
		const pixelWidth = chartContext.innerWidth * dpr;
		const xScaleIndex = chartContext.xScaleState
			? (gpuCoordinator.getScaleIndex?.(chartContext.xScaleState.id) ?? 0)
			: 0;
		m4Decimator.configure(numBins, numSeries, xScaleIndex, fullDomainSpan, pixelWidth);
	});

	// Tooltip registration
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !tooltip || !setup?.tooltipEnabled) return;

		tm.registerMark(
			markId,
			buildTooltipConfig({
				tempTable: setup.tooltipTableName,
				markType: 'line',
				chartContext,
				channelFields: setup.channelFieldMap,
				colorColumn: 'stroke',
				markColor,
				proximityAxis: tooltipProximity,
				constantRadius: dotRadius ? Number(dotRadius) : undefined,
				displayFields: resolvedTip.displayFields
			})
		);
		return () => tm.unregisterMark(markId);
	});

	onDestroy(() => {
		lodController?.destroy();
		m4Decimator?.destroy();
		setup?.destroy();
	});
</script>

{#if (setup?.gpuReady || !table) && markColor.ready && markSeries.ready && xData && yData}
	{#key effectiveCurve}
		<Lines
			{xData}
			{yData}
			{seriesData}
			curve={effectiveCurve}
			colorValueData={markColor.data}
			colorMode={markColor.colorMode}
			colorScaleIndex={markColor.colorScaleIndex}
			constantColor={markColor.constantColor}
			{strokeWidth}
			dotRadius={effectiveDotRadius}
			{fullDomainSpan}
			facetData={setup?.facetData}
			dataVersion={setup?.client?.dataVersion || 0}
			m4Decimator={m4Eligible ? m4Decimator : null}
			{lodController}
		/>
	{/key}
{:else if setup?.client?.error}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="red" font-size="12">
		Error: {setup.client.error.message}
	</text>
{:else if setup?.client?.delayedLoading}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12">
		Loading data...
	</text>
{:else}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12">
		Initializing mark...
	</text>
{/if}
