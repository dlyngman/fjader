<script>
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { Rects } from '../rendering/index.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { inferScaleType } from '$lib/scales/scale-inference.js';
	import { tableSchemaService } from '$lib/data/TableSchemaService.svelte.js';
	import { expandBinForExtent } from '$lib/sql/bin.js';
	import { buildSelectFromChannels, resolveChannel, toFloat32, MarkColor } from './utils/index.js';

	let {
		table,
		selection,
		x = null,
		x1: x1Prop = null,
		x2: x2Prop = null,
		y,
		y1 = 0,
		y2 = y,
		color = null,
		scheme,
		alpha = 0.8,
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		transforms = [],
		viewportLocalDomain = false
	} = $props();

	const markId = `recty-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext('mosaic-coordinator');
	const chartContext = getContext('chart');
	const scaleRegistry = getContext('scale-registry');

	// Ensure services are ready before inference (idempotent)
	BaseMarkSetup.ensureServices(coordinator);

	let setup = $state(null);

	// --- INTERNAL BIN EXPANSION ---
	// If user provides singular x (e.g. bin('field')), expand internally to x1/x2
	const expandedX = $derived.by(() => {
		if (x != null) return expandBinForExtent(x, 'x', 'rectY');
		return { x1: x1Prop, x2: x2Prop };
	});
	const x1 = $derived(expandedX.x1);
	const x2 = $derived(expandedX.x2);

	// --- SCALE TYPE INFERENCE (DotsMark pattern) ---
	const effectiveXScaleType = $derived.by(() => {
		if (preferredXScaleType != null) return preferredXScaleType;
		const field = x1;
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

	// Detect if this is a histogram: binning on X + aggregate on Y
	const isHistogram = $derived.by(() => {
		// Check if x1 is a bin (AutoBinNode)
		const hasBinnedX = x1?.isAutoBinNode;
		// Check if y2 is an aggregate expression (has aggregate property or is SQL aggregate)
		const hasAggregateY = y2?.aggregate || (typeof y2 === 'object' && y2?.constructor?.name === '_AggregateNode');
		return hasBinnedX && hasAggregateY;
	});

	// 2. Config
	const config = $derived({
		markType: 'recty',
		supportedScaleTypes: {
			x: ['linear', 'band', 'point', 'time', 'log'],
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
			x: x1,
			y: y2
		},
		table,
		selection,
		transforms,
		select: buildSelectFromChannels({
			x1,
			x2,
			y1,
			y2,
			...(markColor.selectField && { color: markColor.selectField })
		}),
		clientOptions: { limit, filterNulls: filterNulls ? [x1, x2, y1, y2] : null },
		// Histograms should start at zero baseline for the aggregate dimension
		zeroBaseline: isHistogram ? { y: true } : null,
		// Viewport-local domain: compute Y extent from visible X range only
		viewportLocalDomain
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived.by(() => {
		if (setup?.data?.length) return setup.data.length;
		if (Array.isArray(y2)) return y2.length;
		// @ts-ignore
		if (ArrayBuffer.isView(y2)) return y2.length;
		return 0;
	});

	let hasStackTransform = $derived(transforms.some((t) => t.type === 'stack'));

	// --- DATA RESOLUTION ---

	// X Data: Extent channels with band/linear branching
	let xData = $derived.by(() => {
		if (!instanceCount) return null;

		const scaleType = setup?.actualXScaleType || chartContext.scaleTypes?.x;
		if (scaleType === 'band' || scaleType === 'point') {
			// Categorical: resolve x1 via processDataForGPU, same array for both extents
			const raw = resolveChannel({
				value: x1,
				channel: 'x1',
				dataAccessor: setup?.data,
				instanceCount
			});
			if (!raw) return null;
			if (!chartContext.xScaleState?.processDataForGPU) return null;
			const indices = chartContext.xScaleState.processDataForGPU(raw, markId);
			const arr = toFloat32(indices);
			return { x0Data: arr, x1Data: arr };
		}

		// Continuous: resolve x1 and x2 separately
		const rawX1 = resolveChannel({
			value: x1,
			channel: 'x1',
			dataAccessor: setup?.data,
			instanceCount
		});
		const rawX2 = resolveChannel({
			value: x2,
			channel: 'x2',
			dataAccessor: setup?.data,
			instanceCount
		});
		if (!rawX1 || !rawX2) return null;
		return { x0Data: toFloat32(rawX1), x1Data: toFloat32(rawX2) };
	});

	let x0Data = $derived(xData?.x0Data);
	let x1Data = $derived(xData?.x1Data);

	// Y0: Stack Output -> y1 prop -> 0
	let y0Data = $derived.by(() => {
		const raw = resolveChannel({
			value: y1,
			channel: 'y1',
			tryColumns: hasStackTransform ? ['y0'] : undefined,
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 0
		});
		return toFloat32(raw);
	});

	// Y1: Stack Output -> y2 prop
	let y1Data = $derived.by(() => {
		const raw = resolveChannel({
			value: y2,
			channel: 'y2',
			tryColumns: hasStackTransform ? ['y1'] : undefined,
			dataAccessor: setup?.data,
			instanceCount
		});
		return toFloat32(raw);
	});

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
			// Gate on effectiveXScaleType (blocks while schema loads)
			if (table && effectiveXScaleType) {
				setup = new BaseMarkSetup(config, coordinator, chartContext, markId);
			}
		});
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
