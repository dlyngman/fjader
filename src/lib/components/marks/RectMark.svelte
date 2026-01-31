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
		y = null,
		y1: y1Prop = null,
		y2: y2Prop = null,
		color = null,
		scheme,
		alpha = 0.8,
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = [],
		padding,
		paddingInner,
		paddingOuter,
		align = 0.5
	} = $props();

	const markId = `rect-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext('mosaic-coordinator');
	const chartContext = getContext('chart');
	const scaleRegistry = getContext('scale-registry');

	// Ensure services are ready before inference (idempotent)
	BaseMarkSetup.ensureServices(coordinator);

	let setup = $state(null);

	// --- INTERNAL BIN EXPANSION ---
	const expandedX = $derived.by(() => {
		if (x != null) return expandBinForExtent(x, 'x', 'rect');
		return { x1: x1Prop, x2: x2Prop };
	});
	const ex1 = $derived(expandedX.x1);
	const ex2 = $derived(expandedX.x2);

	const expandedY = $derived.by(() => {
		if (y != null) return expandBinForExtent(y, 'y', 'rect');
		return { y1: y1Prop, y2: y2Prop };
	});
	const ey1 = $derived(expandedY.y1);
	const ey2 = $derived(expandedY.y2);

	// --- SCALE TYPE INFERENCE (DotsMark pattern) ---
	function inferAxisScaleType(field, preferredType) {
		if (preferredType != null) return preferredType;
		if (!field) return 'linear';
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
	}

	const effectiveXScaleType = $derived.by(() => inferAxisScaleType(ex1, preferredXScaleType));
	const effectiveYScaleType = $derived.by(() => inferAxisScaleType(ey1, preferredYScaleType));

	// 1. Color Logic
	const markColor = new MarkColor(
		() => color,
		() => scheme,
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Band scale config (applies only when axis resolves to band)
	const bandScaleConfig = $derived.by(() => {
		const config = {};
		if (padding != null) config.padding = padding;
		if (paddingInner != null) config.paddingInner = paddingInner;
		if (paddingOuter != null) config.paddingOuter = paddingOuter;
		if (align != null) config.align = align;
		return config;
	});

	// 2. Config
	const config = $derived({
		markType: 'rect',
		supportedScaleTypes: {
			x: ['linear', 'band', 'point', 'time', 'log'],
			y: ['linear', 'band', 'point', 'time', 'log']
		},
		scaleRequirements: {
			x: effectiveXScaleType
				? {
						type: effectiveXScaleType,
						priority: SCALE_PRIORITIES.PREFER,
						...(effectiveXScaleType === 'band' && { config: bandScaleConfig })
					}
				: null,
			y: effectiveYScaleType
				? {
						type: effectiveYScaleType,
						priority: SCALE_PRIORITIES.PREFER,
						...(effectiveYScaleType === 'band' && { config: bandScaleConfig })
					}
				: null
		},
		inferredScaleColumns: {
			x: ex1,
			y: ey1
		},
		table,
		selection,
		transforms,
		select: buildSelectFromChannels({
			x1: ex1,
			x2: ex2,
			y1: ey1,
			y2: ey2,
			...(markColor.selectField && { color: markColor.selectField })
		}),
		clientOptions: { limit, filterNulls: filterNulls ? [ex1, ex2, ey1, ey2] : null }
		// Note: RectMark supports bins on both axes, but zero baseline is less clear-cut
		// (could be heatmap, 2D histogram, etc.). Use RectXMark/RectYMark for histograms.
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived.by(() => {
		if (setup?.data?.length) return setup.data.length;
		return 0;
	});

	// --- DATA RESOLUTION ---

	// X Data: Extent channels with band/linear branching
	let xData = $derived.by(() => {
		if (!instanceCount) return null;

		const scaleType = setup?.actualXScaleType || chartContext.scaleTypes?.x;
		if (scaleType === 'band' || scaleType === 'point') {
			const raw = resolveChannel({
				value: ex1,
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

		const rawX1 = resolveChannel({
			value: ex1,
			channel: 'x1',
			dataAccessor: setup?.data,
			instanceCount
		});
		const rawX2 = resolveChannel({
			value: ex2,
			channel: 'x2',
			dataAccessor: setup?.data,
			instanceCount
		});
		if (!rawX1 || !rawX2) return null;
		return { x0Data: toFloat32(rawX1), x1Data: toFloat32(rawX2) };
	});

	let x0Data = $derived(xData?.x0Data);
	let x1Data = $derived(xData?.x1Data);

	// Y Data: Extent channels with band/linear branching
	let yData = $derived.by(() => {
		if (!instanceCount) return null;

		const scaleType = setup?.actualYScaleType || chartContext.scaleTypes?.y;
		if (scaleType === 'band' || scaleType === 'point') {
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
			// Gate on BOTH scale types being resolved
			if (table && effectiveXScaleType && effectiveYScaleType) {
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
