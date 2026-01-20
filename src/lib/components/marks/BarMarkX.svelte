<script>
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { Rects } from '../rendering/index.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { isColorConstant, parseColorToRGBA } from '$lib/scales/color-utils.js';
	import {
		buildSelectFromChannels,
		resolveChannel,
		toFloat32
	} from './utils/index.js';

	let {
		table,
		selection,
		x, // shorthand for x2
		x1 = 0, // baseline
		x2 = x, // end of bars
		y, // categorical data
		color = null,
		scheme = 'tableau10',
		alpha = 0.8,
		limit,
		filterNulls = false,
		transforms = [],
		padding,
		paddingInner,
		paddingOuter,
		align = 0.5
	} = $props();

	const markId = `barx-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext('mosaic-coordinator');
	const chartContext = getContext('chart');
	const scaleRegistry = getContext('scale-registry');

	let setup = $state(null);
	let colorScaleState = $state(null);
	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	// Detect color type
	const colorConfig = $derived.by(() => {
		if (color == null) {
			return { mode: 'constant', value: [0.2, 0.4, 0.8, 1.0] };
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
		return { mode: 'constant', value: [0.2, 0.4, 0.8, 1.0] };
	});

	const yScaleConfig = $derived.by(() => {
		const config = {};
		if (padding != null) config.padding = padding;
		if (paddingInner != null) config.paddingInner = paddingInner;
		if (paddingOuter != null) config.paddingOuter = paddingOuter;
		if (align != null) config.align = align;
		return config;
	});

	const config = $derived({
		markType: 'barx',
		supportedScaleTypes: {
			x: ['linear', 'identity'],
			y: ['band']
		},
		scaleRequirements: {
			x: { type: 'linear', priority: SCALE_PRIORITIES.PREFER },
			y: { type: 'band', priority: SCALE_PRIORITIES.MANDATE, config: yScaleConfig }
		},
		table,
		selection,
		select: buildSelectFromChannels({
			x1,
			x2,
			y,
			...(colorConfig.mode === 'field' && { color: colorConfig.field })
		}),
		transforms,
		clientOptions: {
			limit,
			filterNulls: filterNulls ? [x1, x2, y] : null
		}
	});

	// Support No-DB Mode: Determine count from DB data OR input arrays
	let instanceCount = $derived.by(() => {
		if (setup?.data?.length) return setup.data.length;
		if (Array.isArray(x2)) return x2.length;
		if (Array.isArray(y)) return y.length;
		// @ts-ignore
		if (ArrayBuffer.isView(x2)) return x2.length;
		return 0;
	});

	// Check if transforms modified channels
	let hasStackTransform = $derived.by(() => {
		return transforms.some((t) => t.type === 'stack');
	});

	// --- SETUP LIFECYCLE ---

	$effect(() => {
		if (setup?.client?.error) console.error('Client Error:', setup.client.error.message);
	});

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

	// X0: Stack Output -> x1 prop -> 0
	let x0Data = $derived.by(() => {
		const raw = resolveChannel({
			value: x1,
			channel: 'x1',
			tryColumns: hasStackTransform ? ['x0'] : undefined, 
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 0
		});
		return toFloat32(raw);
	});

	// X1: Stack Output -> x2 prop
	let x1Data = $derived.by(() => {
		const raw = resolveChannel({
			value: x2,
			channel: 'x2',
			tryColumns: hasStackTransform ? ['x1'] : undefined,
			dataAccessor: setup?.data,
			instanceCount
		});
		return toFloat32(raw);
	});

	// Y: Categorical Resolution (Band Scale)
	let yData = $derived.by(() => {
		if (!instanceCount) return null;

		// Pattern #3: Fallback scale type check
		// In No-DB mode (no setup), we assume 'band' if chartContext hasn't resolved it yet
		const scaleType = setup?.actualYScaleType || chartContext.scaleTypes?.y || 'band';
		if (scaleType !== 'band') return null;

		// 1. Get raw data (likely strings)
		const raw = resolveChannel({
			value: y,
			channel: 'y',
			dataAccessor: setup?.data,
			instanceCount
		});

		if (!raw) return null;

		// 2. Map to indices via scale
		// Duck-typing check: Ensure the scale actually supports GPU data processing
		if (!chartContext.yScaleState?.processDataForGPU) return null;

		const indices = chartContext.yScaleState.processDataForGPU(raw, markId);
		const yArr = toFloat32(indices);
		
		return { y0Data: yArr, y1Data: yArr };
	});

	let y0Data = $derived(yData?.y0Data);
	let y1Data = $derived(yData?.y1Data);

	// Color: Field (Scale) vs Constant
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

	// Alpha: Constant or Data
	let alphaData = $derived.by(() => {
		const raw = resolveChannel({
			value: alpha,
			channel: 'alpha',
			dataAccessor: setup?.data,
			instanceCount,
			fallback: 0.8
		});
		return toFloat32(raw);
	});

	// --- RENDERER PROPS ---

	let colorMode = $derived(colorConfig.mode === 'field' ? 1 : 0);
	let colorScaleIndex = $derived(colorScaleState?.gpuIndex ?? 0);
	let constantColor = $derived(colorConfig.mode === 'constant' ? colorConfig.value : [0, 0, 0, 1]);
	let colorReady = $derived(colorConfig.mode === 'constant' || (colorScaleState?.ready ?? false));

	$effect(() => {
		(void config, xScaleId, yScaleId);
		untrack(() => {
			setup?.destroy();
			// Pattern #2: Conditional Setup Creation
			if (table) {
				setup = new BaseMarkSetup(config, coordinator, chartContext, markId);
			}
		});
	});

	onDestroy(() => {
		setup?.destroy();
	});
</script>

<!-- Pattern #1: No-DB Render Condition -->
{#if (setup?.gpuReady || !table) && colorReady && x0Data && x1Data && y0Data && y1Data}
	<Rects
		{x0Data}
		{x1Data}
		{y0Data}
		{y1Data}
		{colorValueData}
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
		Initializing bars...
	</text>
{/if}