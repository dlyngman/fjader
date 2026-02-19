<script>
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { Lines } from '../rendering/index.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { inferScaleType } from '$lib/scales/scale-inference.js';
	import { tableSchemaService } from '$lib/data/TableSchemaService.svelte.js';
	import {
		buildSelectFromChannels,
		resolveChannel,
		toFloat32,
		MarkColor,
		MarkSeries,
		normalizeSortConfig
	} from './utils/index.js';
	import { getGPUContext } from '$lib/gpu';
	import { M4Decimator } from '$lib/gpu/decimation/M4Decimator.svelte.js';

	let {
		table,
		selection = undefined,
		x,
		y,
		stroke = null, // Series grouping field (for multi-series lines)
		color = null, // Color encoding (can be same as stroke or different)
		scheme, // Color scheme
		curve = 'linear', // Curve type: 'linear', 'step', 'step-after', 'step-before', 'catmull-rom', 'monotone', 'bump'
		strokeWidth = 2, // Line thickness in logical pixels
		dotRadius = 0, // 0 = strokeWidth/2 (gap-filling only), >0 = explicit radius in px
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = [],
		sort = null,
		tooltip = true,
		optimize = 'auto' // M4 decimation: true | false | 'auto'
	} = $props();

	// Map user-facing 'monotone' to the correct axis-specific variant
	// Map user-facing aliases to axis-specific variants
	const effectiveCurve = $derived(
		curve === 'monotone' ? 'monotone-x' : curve === 'bump' ? 'bump-x' : curve
	);

	const markId = `line-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext('mosaic-coordinator');
	const chartContext = getContext('chart');
	const scaleRegistry = getContext('scale-registry');

	// Ensure services are ready before inference (idempotent)
	BaseMarkSetup.ensureServices(coordinator);

	let setup = $state(null);

	// 0. Scale Type Inference
	const effectiveXScaleType = $derived.by(() => {
		if (preferredXScaleType != null) return preferredXScaleType;
		if (!x || typeof x !== 'string') return 'linear';
		const _v = tableSchemaService.version;
		const colType = tableSchemaService.getColumnType(table, x);
		if (!colType) {
			tableSchemaService.getSchema(table);
			return null;
		}
		return inferScaleType({ field: x, schemaType: colType, context: 'axis' });
	});

	const effectiveYScaleType = $derived.by(() => {
		if (preferredYScaleType != null) return preferredYScaleType;
		if (!y || typeof y !== 'string') return 'linear';
		const _v = tableSchemaService.version;
		const colType = tableSchemaService.getColumnType(table, y);
		if (!colType) {
			tableSchemaService.getSchema(table);
			return null;
		}
		return inferScaleType({ field: y, schemaType: colType, context: 'axis' });
	});

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

	let instanceCount = $derived.by(() => {
		if (setup?.data?.length) return setup.data.length;
		if (Array.isArray(x)) return x.length;
		if (Array.isArray(y)) return y.length;
		// @ts-ignore
		if (ArrayBuffer.isView(x)) return x.length;
		return 0;
	});

	// --- DATA RESOLUTION ---

	let xData = $derived.by(() => {
		if (!instanceCount) return null;
		const raw = resolveChannel({
			value: x,
			channel: 'x',
			dataAccessor: setup?.data,
			instanceCount
		});
		return raw ? toFloat32(raw) : null;
	});

	let yData = $derived.by(() => {
		if (!instanceCount) return null;
		const raw = resolveChannel({
			value: y,
			channel: 'y',
			dataAccessor: setup?.data,
			instanceCount
		});
		return raw ? toFloat32(raw) : null;
	});

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
			? gpuCoordinator.getScaleIndex?.(chartContext.xScaleState.id) ?? 0
			: 0;
		m4Decimator.configure(numBins, numSeries, xScaleIndex);
	});

	// Tooltip registration
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !tooltip || !setup?.tooltipEnabled) return;
		const id = markId;

		// Use color channel if set, otherwise fall back to stroke for series identification
		const colorChannelField = color
			? (typeof color === 'string' ? color : 'color')
			: (stroke ? (typeof stroke === 'string' ? stroke : 'stroke') : null);

		tm.registerMark(id, {
			tempTable: setup.tooltipTableName,
			markType: 'line',
			scaleTypes: {
				x: chartContext.scaleTypes?.x,
				y: chartContext.scaleTypes?.y
			},
			channelFields: {
				x: typeof x === 'string' ? x : 'x',
				y: typeof y === 'string' ? y : 'y',
				...(colorChannelField && { color: colorChannelField })
			},
			colorDomain: markColor.scaleState?.isOrdinal ? markColor.scaleState?.domain : null,
			colorScaleState: markColor.scaleState ?? null,
			enabled: true
		});

		return () => tm.unregisterMark(id);
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
