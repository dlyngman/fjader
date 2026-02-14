<script>
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { Rects } from '../rendering/index.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { inferScaleType } from '$lib/scales/scale-inference.js';
	import { tableSchemaService } from '$lib/data/TableSchemaService.svelte.js';
	import { expandBinForExtent } from '$lib/sql/bin.js';
	import {
		buildSelectFromChannels,
		resolveChannel,
		toFloat32,
		MarkColor,
		normalizeSortConfig
	} from './utils/index.js';

	let {
		table,
		selection,
		x,
		x1 = 0,
		x2 = x,
		y = null,
		y1: y1Prop = null,
		y2: y2Prop = null,
		color = null,
		scheme,
		alpha = 1,
		limit,
		filterNulls = false,
		preferredYScaleType = null,
		transforms = [],
		viewportLocalDomain = false,
		inset = 0,
		dx = 0,
		dy = 0,
		sort = null,
		tooltip = true
	} = $props();

	const markId = `rectx-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext('mosaic-coordinator');
	const chartContext = getContext('chart');
	const scaleRegistry = getContext('scale-registry');

	// Ensure services are ready before inference (idempotent)
	BaseMarkSetup.ensureServices(coordinator);

	let setup = $state(null);

	// --- INTERNAL BIN EXPANSION ---
	// If user provides singular y (e.g. bin('field')), expand internally to y1/y2
	const expandedY = $derived.by(() => {
		if (y != null) return expandBinForExtent(y, 'y', 'rectX');
		return { y1: y1Prop, y2: y2Prop };
	});
	const ey1 = $derived(expandedY.y1);
	const ey2 = $derived(expandedY.y2);

	// --- SCALE TYPE INFERENCE (DotsMark pattern) ---
	const effectiveYScaleType = $derived.by(() => {
		if (preferredYScaleType != null) return preferredYScaleType;
		const field = ey1;
		if (!field) return 'linear';
		// Unwrap AutoBinNode to get underlying column for schema lookup
		if (field.isAutoBinNode) {
			const colName = typeof field.field === 'string' ? field.field : null;
			if (!colName) return 'linear';
			const _v = tableSchemaService.version;
			const colType = tableSchemaService.getColumnType(table, colName);
			if (!colType) {
				tableSchemaService.getSchema(table);
				return null;
			}
			return inferScaleType({ field: colName, schemaType: colType, context: 'axis' });
		}
		if (typeof field !== 'string') return 'linear';
		const _v = tableSchemaService.version;
		const colType = tableSchemaService.getColumnType(table, field);
		if (!colType) {
			tableSchemaService.getSchema(table);
			return null;
		}
		return inferScaleType({ field, schemaType: colType, context: 'axis' });
	});

	// 1. Color Logic
	const markColor = new MarkColor(
		() => color,
		() => scheme,
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Detect if this is a histogram: binning on Y + aggregate on X
	const isHistogram = $derived.by(() => {
		// Check if y1 is a bin (AutoBinNode)
		const hasBinnedY = ey1?.isAutoBinNode;
		// Check if x2 is an aggregate expression
		const hasAggregateX = x2?.aggregate || (typeof x2 === 'object' && x2?.constructor?.name === '_AggregateNode');
		return hasBinnedY && hasAggregateX;
	});

	// 2. Config
	const config = $derived({
		markType: 'rectx',
		supportedScaleTypes: {
			x: ['linear', 'identity'],
			y: ['linear', 'band', 'point', 'time', 'log']
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
		table,
		selection,
		transforms,
		select: buildSelectFromChannels({
			x1,
			x2,
			y1: ey1,
			y2: ey2,
			...(markColor.selectField && { color: markColor.selectField })
		}),
		clientOptions: { limit, filterNulls: filterNulls ? [x1, x2, ey1, ey2] : null },
		// Histograms should start at zero baseline for the aggregate dimension
		zeroBaseline: isHistogram ? { x: true } : null,
		// Viewport-local domain: compute X extent from visible Y range only
		viewportLocalDomain,
		sort: normalizeSortConfig(sort),
		tooltip
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived.by(() => {
		if (setup?.data?.length) return setup.data.length;
		if (Array.isArray(x2)) return x2.length;
		// @ts-ignore
		if (ArrayBuffer.isView(x2)) return x2.length;
		return 0;
	});

	let hasStackTransform = $derived(transforms.some((t) => t.type === 'stack'));

	// --- DATA RESOLUTION ---

	// X0: Stack Output -> x1 prop -> 0
	let x0Data = $derived(
		toFloat32(
			resolveChannel({
				value: x1,
				channel: 'x1',
				tryColumns: hasStackTransform ? ['x0', 'x1'] : ['x1'],
				dataAccessor: setup?.data,
				instanceCount,
				fallback: 0
			})
		)
	);

	// X1: Stack Output -> x2 prop
	let x1Data = $derived(
		toFloat32(
			resolveChannel({
				value: x2,
				channel: 'x2',
				tryColumns: hasStackTransform ? ['x1', 'x2'] : ['x2'],
				dataAccessor: setup?.data,
				instanceCount
			})
		)
	);

	// Y Data: Extent channels with band/linear branching
	let yData = $derived.by(() => {
		if (!instanceCount) return null;

		const scaleType = setup?.actualYScaleType || chartContext.scaleTypes?.y;
		if (scaleType === 'band' || scaleType === 'point') {
			// Categorical: resolve ey1 via processDataForGPU, same array for both extents
			const raw = resolveChannel({
				value: ey1,
				channel: 'y1',
				dataAccessor: setup?.data,
				instanceCount
			});
			if (!raw) return null;
			if (!chartContext.yScaleState?.processDataForGPU) return null;
			const indices = chartContext.yScaleState.processDataForGPU(raw, markId);
			const arr = toFloat32(indices);
			return { y0Data: arr, y1Data: arr };
		}

		// Continuous: resolve y1 and y2 separately
		const rawY1 = resolveChannel({
			value: ey1,
			channel: 'y1',
			dataAccessor: setup?.data,
			instanceCount
		});
		const rawY2 = resolveChannel({
			value: ey2,
			channel: 'y2',
			dataAccessor: setup?.data,
			instanceCount
		});
		if (!rawY1 || !rawY2) return null;
		return { y0Data: toFloat32(rawY1), y1Data: toFloat32(rawY2) };
	});

	let y0Data = $derived(yData?.y0Data);
	let y1Data = $derived(yData?.y1Data);

	let alphaData = $derived(
		toFloat32(
			resolveChannel({
				value: alpha,
				channel: 'alpha',
				dataAccessor: setup?.data,
				instanceCount,
				fallback: 0.8
			})
		)
	);

	// --- SETUP LIFECYCLE ---

	$effect(() => {
		(void config, xScaleId, yScaleId, transforms, markColor.selectField);
		untrack(() => {
			setup?.destroy();
			setup = null;
			// Gate on effectiveYScaleType (blocks while schema loads)
			if (table && effectiveYScaleType) {
				setup = new BaseMarkSetup(config, coordinator, chartContext, markId);
			}
		});
	});

	// Tooltip registration
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !tooltip || !setup?.tooltipEnabled) return;
		const id = markId;

		tm.registerMark(id, {
			tempTable: setup.tooltipTableName,
			markType: 'rectx',
			scaleTypes: {
				x: chartContext.scaleTypes?.x,
				y: chartContext.scaleTypes?.y
			},
			columns: { xLow: typeof x1 === 'number' ? x1 : 'x1', xHigh: 'x2', yLow: 'y1', yHigh: 'y2' },
			channelFields: {
				x: typeof x2 === 'string' ? x2 : (typeof x === 'string' ? x : 'x'),
				y: typeof ey1 === 'string' ? ey1 : (typeof y === 'string' ? y : 'y'),
				...(color && { color: typeof color === 'string' ? color : 'color' })
			},
			bandDomains: {
				...(chartContext.scaleTypes?.y === 'band' && {
					y: chartContext.yScaleState?.effectiveDomain
				})
			},
			colorDomain: markColor.scaleState?.isOrdinal ? markColor.scaleState?.domain : null,
			colorScaleState: markColor.scaleState ?? null,
			enabled: true
		});

		return () => tm.unregisterMark(id);
	});

	onDestroy(() => {
		setup?.destroy();
	});
</script>

{#if (setup?.gpuReady || !table) && markColor.ready && x0Data && x1Data && y0Data && y1Data}
	<Rects
		{x0Data}
		{x1Data}
		{y0Data}
		{y1Data}
		colorValueData={markColor.data}
		{alphaData}
		colorMode={markColor.colorMode}
		colorScaleIndex={markColor.colorScaleIndex}
		constantColor={markColor.constantColor}
		dataVersion={setup?.client?.dataVersion || 0}
		{inset}
		{dx}
		{dy}
	/>
{:else if setup?.client?.error}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="red" font-size="12"
		>Error: {setup.client.error.message}</text
	>
{:else if setup?.client?.delayedLoading}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12"
		>Loading data...</text
	>
{:else}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12"
		>Initializing rects...</text
	>
{/if}
