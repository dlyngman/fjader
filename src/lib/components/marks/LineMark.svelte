<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { Lines } from '../rendering/index.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import {
		buildSelectFromChannels,
		resolveChannelData,
		computeInstanceCount,
		buildTooltipConfig,
		MarkColor,
		MarkSeries,
		normalizeSortConfig,
		inferMarkScaleType
	} from './utils/index.js';
	import { getGPUContext } from '$lib/gpu';
	import { M4Decimator } from '$lib/gpu/decimation/M4Decimator.svelte.js';
	import type {
		FieldRef,
		BaseMarkProps,
		ContinuousScaleTypeProps,
		ConnectedTopologyProps,
		Coordinator
	} from '$lib/types';

	interface Props extends BaseMarkProps, ContinuousScaleTypeProps, ConnectedTopologyProps {
		x: FieldRef;
		y: FieldRef;
		strokeWidth?: number;
		dotRadius?: number;
		optimize?: boolean | 'auto';
	}

	let {
		table,
		selection = undefined,
		x,
		y,
		stroke = null,
		color = null,
		scheme,
		curve = 'linear',
		strokeWidth = 2,
		dotRadius = 0,
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = [],
		sort = null,
		tooltip = true,
		optimize = 'auto'
	}: Props = $props();

	// Map user-facing aliases to axis-specific variants
	const effectiveCurve = $derived(
		curve === 'monotone' ? 'monotone-x' : curve === 'bump' ? 'bump-x' : curve
	);

	const markId = `line-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext<Coordinator>('mosaic-coordinator');
	const chartContext: any = getContext('chart');
	const scaleRegistry: any = getContext('scale-registry');

	// Ensure services are ready before inference (idempotent)
	BaseMarkSetup.ensureServices(coordinator);

	let setup = $state(null);

	// 0. Scale Type Inference
	const effectiveXScaleType = $derived.by(() => inferMarkScaleType(x, table, preferredXScaleType));
	const effectiveYScaleType = $derived.by(() => inferMarkScaleType(y, table, preferredYScaleType));

	// Series grouping - uses scale infrastructure for categorical → index mapping
	const markSeries = new MarkSeries(
		() => stroke,
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Color logic - only uses explicit color prop
	// To color by series, set color={stroke} explicitly
	const markColor = new MarkColor(
		() => color,
		() => scheme,
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Config with _connectedConfig for automatic ORDER BY
	const config = $derived({
		markType: 'line',
		supportedScaleTypes: {
			x: ['linear', 'time', 'log'],
			y: ['linear', 'time', 'log']
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
		selection,
		transforms,
		select: buildSelectFromChannels({
			x,
			y,
			...(markSeries.selectField && { stroke: markSeries.selectField }),
			...(markColor.selectField && { color: markColor.selectField })
		}),
		// Connected topology config - ensures data is ordered for line connectivity
		_connectedConfig: {
			seriesChannel: markSeries.selectField ? 'stroke' : null,
			dimensionChannel: 'x'
		},
		clientOptions: { limit, filterNulls: filterNulls ? [x, y] : null },
		sort: normalizeSortConfig(sort),
		tooltip
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
			// Don't create BaseMarkSetup until scale type inference has resolved.
			if (table && effectiveXScaleType && effectiveYScaleType) {
				setup = new BaseMarkSetup(config, coordinator, chartContext, markId);
			}
		});
	});

	// MarkColor and MarkSeries connect to setup internally via their lifecycle effects

	// --- M4 DECIMATION ---
	const gpuCoordinator = getGPUContext();
	const faceted = !!chartContext.fx;

	const m4Active = $derived.by(() => {
		if (optimize === false || faceted) return false;
		if (optimize === true) return true;
		// 'auto': activate when points exceed 10x pixel width
		const pixels = chartContext.innerWidth;
		const points = instanceCount;
		return points > 0 && pixels > 0 && points > pixels * 10;
	});

	let m4Decimator = $state(null);

	$effect(() => {
		if (m4Active && gpuCoordinator?.device && gpuCoordinator?.globalScaleLayout) {
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

	// Configure M4 decimator when chart dimensions or series count change.
	// When stroke is set, wait for the series domain to be populated (async fetch).
	$effect(() => {
		if (!m4Decimator || !chartContext.innerWidth) return;

		let numSeries;
		if (stroke) {
			const domain = markSeries.scaleState?.domain;
			if (!domain || domain.length === 0) return;
			numSeries = domain.length;
		} else {
			numSeries = 1;
		}

		const numBins = Math.ceil(chartContext.innerWidth);
		const xScaleIndex = chartContext.xScaleState
			? (gpuCoordinator.getScaleIndex?.(chartContext.xScaleState.id) ?? 0)
			: 0;
		m4Decimator.configure(numBins, numSeries, xScaleIndex);
	});

	// Tooltip registration
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !tooltip || !setup?.tooltipEnabled) return;

		// Use color channel if set, otherwise fall back to stroke for series identification
		const colorChannelField = color
			? typeof color === 'string'
				? color
				: 'color'
			: stroke
				? typeof stroke === 'string'
					? stroke
					: 'stroke'
				: null;

		tm.registerMark(
			markId,
			buildTooltipConfig({
				tempTable: setup.tooltipTableName,
				markType: 'line',
				chartContext,
				channelFields: {
					x: typeof x === 'string' ? x : 'x',
					y: typeof y === 'string' ? y : 'y',
					...(colorChannelField && { color: colorChannelField })
				},
				markColorScaleState: markColor.scaleState
			})
		);
		return () => tm.unregisterMark(markId);
	});

	onDestroy(() => {
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
			{dotRadius}
			facetData={setup?.facetData}
			dataVersion={setup?.client?.dataVersion || 0}
			m4Decimator={m4Active ? m4Decimator : null}
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
