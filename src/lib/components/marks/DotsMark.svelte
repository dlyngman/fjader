<script>
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { Dots } from '../rendering/index.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { inferScaleType } from '$lib/scales/scale-inference.js';
	import { tableSchemaService } from '$lib/data/TableSchemaService.svelte.js';
	import { buildSelectFromChannels, resolveChannel, toFloat32, MarkColor } from './utils/index.js';

	let {
		table,
		selection,
		x,
		y,
		color = null,
		scheme, // No default - MarkColor will infer based on field type
		alpha = 0.5,
		radius = 3,
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = []
	} = $props();

	const markId = `dot-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext('mosaic-coordinator');
	const chartContext = getContext('chart');
	const scaleRegistry = getContext('scale-registry');

	// Ensure services are ready before inference (idempotent)
	BaseMarkSetup.ensureServices(coordinator);

	let setup = $state(null);

	// 0. Scale Type Inference
	// When preferredXScaleType/preferredYScaleType is null, infer from column schema.
	// Returns null while schema is loading (gates downstream registration).
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

	// 1. Color Logic
	const markColor = new MarkColor(
		() => color,
		() => scheme,
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// 2. Config
	const config = $derived({
		markType: 'dot',
		supportedScaleTypes: {
			x: ['linear', 'identity', 'band', 'point', 'time', 'log'],
			y: ['linear', 'identity', 'band', 'point', 'time', 'log']
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
			x: x, // X scale uses x column
			y: y // Y scale uses y column
		},
		table,
		selection,
		transforms,
		select: buildSelectFromChannels({
			x,
			y,
			...(markColor.selectField && { color: markColor.selectField }),
			...(typeof radius === 'string' && { radius })
		}),
		clientOptions: { limit, filterNulls: filterNulls ? [x, y] : null }
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
		if (!raw) return null;

		const scaleType = setup?.actualXScaleType || chartContext.scaleTypes?.x;
		if (scaleType === 'band' || scaleType === 'point') {
			if (!chartContext.xScaleState) return null;
			return toFloat32(chartContext.xScaleState.processDataForGPU(raw, markId));
		}
		return toFloat32(raw);
	});

	let yData = $derived.by(() => {
		if (!instanceCount) return null;
		const raw = resolveChannel({
			value: y,
			channel: 'y',
			dataAccessor: setup?.data,
			instanceCount
		});
		if (!raw) return null;

		const scaleType = setup?.actualYScaleType || chartContext.scaleTypes?.y;
		if (scaleType === 'band' || scaleType === 'point') {
			if (!chartContext.yScaleState) return null;
			return toFloat32(chartContext.yScaleState.processDataForGPU(raw, markId));
		}
		return toFloat32(raw);
	});

	let radiusData = $derived.by(() => {
		if (!instanceCount) return null;
		if (typeof radius === 'function') {
			const xArr = setup?.data?.getColumn('x');
			const yArr = setup?.data?.getColumn('y');
			if (!xArr || !yArr) return null;
			const radii = new Float32Array(instanceCount);
			for (let i = 0; i < instanceCount; i++) radii[i] = radius({ x: xArr[i], y: yArr[i] });
			return radii;
		}
		const raw = resolveChannel({
			value: radius,
			channel: 'radius',
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 3
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
				fallback: 0.5
			})
		)
	);

	// --- SETUP LIFECYCLE ---

	$effect(() => {
		(void config, xScaleId, yScaleId);
		untrack(() => {
			setup?.destroy();
			setup = null;
			// Don't create BaseMarkSetup until scale type inference has resolved.
			// When effectiveXScaleType or effectiveYScaleType is null (schema pending),
			// config.scaleRequirements will have null entries — skip creation to avoid
			// a throwaway instance that gets immediately destroyed when schema arrives.
			if (table && effectiveXScaleType && effectiveYScaleType) {
				setup = new BaseMarkSetup(config, coordinator, chartContext, markId);
			}
		});
	});

	onDestroy(() => {
		setup?.destroy();
	});
</script>

{#if (setup?.gpuReady || !table) && markColor.ready && xData && yData}
	<Dots
		{xData}
		{yData}
		{radiusData}
		{alphaData}
		colorValueData={markColor.data}
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
		>Initializing mark...</text
	>
{/if}
