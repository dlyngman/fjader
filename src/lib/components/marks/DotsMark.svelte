<script>
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { Dots } from '../rendering/index.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { isColorConstant, parseColorToRGBA } from '$lib/scales/color-utils.js';
	import { buildSelectFromChannels, resolveChannel, toFloat32 } from './utils/index.js';

	let {
		table,
		selection,
		x,
		y,
		color = null,
		scheme = 'tableau10',
		alpha = 0.5,
		radius = 3,
		limit,
		filterNulls = false,
		preferredXScaleType = 'linear',
		preferredYScaleType = 'linear',
		transforms = []
	} = $props();

	const markId = `dot-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext('mosaic-coordinator');
	const chartContext = getContext('chart');
	const scaleRegistry = getContext('scale-registry');

	let setup = $state(null);
	let colorScaleState = $state(null);

	// Detect color type
	const colorConfig = $derived.by(() => {
		if (color == null) {
			return { mode: 'constant', value: [0.13, 0.55, 0.13, 1.0] };
		}
		if (typeof color === 'object' && color.field) {
			return { mode: 'field', field: color.field, scheme: color.scheme || scheme };
		}
		if (typeof color === 'string') {
			if (isColorConstant(color)) {
				return { mode: 'constant', value: parseColorToRGBA(color) };
			} else {
				return { mode: 'field', field: color, scheme: scheme };
			}
		}
		return { mode: 'constant', value: [0.13, 0.55, 0.13, 1.0] };
	});

	// Build select config: Include radius if it's a string (field name)
	const selectConfig = $derived({
		x,
		y,
		...(colorConfig.mode === 'field' && { color: colorConfig.field }),
		...(typeof radius === 'string' && { radius: radius })
	});

	const config = $derived({
		markType: 'dot',
		supportedScaleTypes: {
			x: ['linear', 'identity', 'band', 'point', 'time', 'log'],
			y: ['linear', 'identity', 'band', 'point', 'time', 'log']
		},
		scaleRequirements: {
			x: { type: preferredXScaleType, priority: SCALE_PRIORITIES.PREFER },
			y: { type: preferredYScaleType, priority: SCALE_PRIORITIES.PREFER }
		},
		table,
		selection,
		select: selectConfig,
		transforms,
		clientOptions: {
			limit,
			filterNulls: filterNulls ? [x, y] : null
		}
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	// Support No-DB Mode: Determine count from DB data OR input arrays
	let instanceCount = $derived.by(() => {
		if (setup?.data?.length) return setup.data.length;
		if (Array.isArray(x)) return x.length;
		if (Array.isArray(y)) return y.length;
		if (ArrayBuffer.isView(x)) return x.length;
		return 0;
	});

	// --- SETUP LIFECYCLE ---

	$effect(() => {
		if (colorConfig.mode === 'field' && scaleRegistry) {
			untrack(() => {
				colorScaleState = scaleRegistry.getOrCreateScale(
					colorConfig.field,
					'color',
					{ scheme: colorConfig.scheme },
					chartContext.chartId
				);
				if (colorScaleState && table) {
					colorScaleState.registerTable(table);
				}
			});
		} else {
			colorScaleState = null;
		}
	});

	$effect(() => {
		if (setup && colorScaleState && colorConfig.mode === 'field') {
			setup.setColorScale(colorScaleState);
		}
	});

	// --- DATA RESOLUTION ---

	// X Data: Handles both Numeric and Categorical (Band/Point)
	let xData = $derived.by(() => {
		if (!instanceCount) return null;

		// 1. Resolve Raw Data
		const raw = resolveChannel({
			value: x,
			channel: 'x',
			dataAccessor: setup?.data,
			instanceCount
		});

		if (!raw) return null;

		// 2. Check Scale Type (Categorical vs Continuous)
		// Use setup type (DB mode) or context type (No-DB mode)
		const scaleType = setup?.actualXScaleType || chartContext.scaleTypes?.x;
		const isCategorical = scaleType === 'band' || scaleType === 'point';

		if (isCategorical) {
			if (!chartContext.xScaleState) return null;
			// Map strings -> indices
			const indices = chartContext.xScaleState.processDataForGPU(raw, markId);
			return toFloat32(indices);
		}

		// Continuous (Linear, Log, Time)
		return toFloat32(raw);
	});

	// Y Data: Handles both Numeric and Categorical
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
		const isCategorical = scaleType === 'band' || scaleType === 'point';

		if (isCategorical) {
			if (!chartContext.yScaleState) return null;
			const indices = chartContext.yScaleState.processDataForGPU(raw, markId);
			return toFloat32(indices);
		}

		return toFloat32(raw);
	});

	// Color Data
	let colorValueData = $derived.by(() => {
		if (colorConfig.mode !== 'field') return null;
		if (!colorScaleState?.ready) return null;

		const raw = resolveChannel({
			value: colorConfig.field,
			channel: 'color',
			dataAccessor: setup?.data,
			instanceCount
		});

		if (!raw) return null;
		return colorScaleState.processDataForGPU(raw);
	});

	// Radius Data: Function -> Field -> Constant
	let radiusData = $derived.by(() => {
		if (!instanceCount) return null;

		// 1. Function Strategy (CPU calculation)
		if (typeof radius === 'function') {
			const xArr = setup?.data?.getColumn('x');
			const yArr = setup?.data?.getColumn('y');
			if (!xArr || !yArr) return null;

			const radii = new Float32Array(instanceCount);
			for (let i = 0; i < instanceCount; i++) {
				radii[i] = radius({ x: xArr[i], y: yArr[i] });
			}
			return radii;
		}

		// 2. Standard Resolution (Field 'radius' or Constant Prop)
		const raw = resolveChannel({
			value: radius,
			channel: 'radius',
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 3
		});

		return toFloat32(raw);
	});

	// Alpha Data
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

	// --- RENDERER PROPS ---

	let colorMode = $derived(colorConfig.mode === 'field' ? 1 : 0);
	let colorScaleIndex = $derived(colorScaleState?.gpuIndex ?? 0);
	let constantColor = $derived(colorConfig.mode === 'constant' ? colorConfig.value : [0, 0, 0, 1]);
	let colorReady = $derived(colorConfig.mode === 'constant' || (colorScaleState?.ready ?? false));

	$effect(() => {
		(void config, xScaleId, yScaleId);
		untrack(() => {
			setup?.destroy();
			if (table) {
				setup = new BaseMarkSetup(config, coordinator, chartContext, markId);
			}
		});
	});

	onDestroy(() => {
		setup?.destroy();
	});
</script>

{#if (setup?.gpuReady || !table) && colorReady && xData && yData}
	<Dots
		{xData}
		{yData}
		{colorValueData}
		{radiusData}
		{alphaData}
		{colorMode}
		{colorScaleIndex}
		{constantColor}
		dataVersion={setup?.client?.dataVersion || 0}
	/>
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