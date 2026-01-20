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
		x, // categorical data
		y, // shorthand for y2 (value)
		y1 = 0, // baseline
		y2 = y, // top of bars
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

	const markId = `bary-${crypto.randomUUID().slice(0, 8)}`;
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

	const xScaleConfig = $derived.by(() => {
		const config = {};
		if (padding != null) config.padding = padding;
		if (paddingInner != null) config.paddingInner = paddingInner;
		if (paddingOuter != null) config.paddingOuter = paddingOuter;
		if (align != null) config.align = align;
		return config;
	});

	const config = $derived({
		markType: 'bary',
		supportedScaleTypes: {
			x: ['band'],
			y: ['linear', 'identity']
		},
		scaleRequirements: {
			x: { type: 'band', priority: SCALE_PRIORITIES.MANDATE, config: xScaleConfig },
			y: { type: 'linear', priority: SCALE_PRIORITIES.PREFER }
		},
		table,
		selection,
		select: buildSelectFromChannels({
			x,
			y1,
			y2,
			...(colorConfig.mode === 'field' && { color: colorConfig.field })
		}),
		transforms,
		clientOptions: {
			limit,
			filterNulls: filterNulls ? [x, y1, y2] : null
		}
	});

	// No-DB Mode Support
	let instanceCount = $derived.by(() => {
		if (setup?.data?.length) return setup.data.length;
		if (Array.isArray(y2)) return y2.length;
		if (Array.isArray(x)) return x.length;
		// @ts-ignore
		if (ArrayBuffer.isView(y2)) return y2.length;
		return 0;
	});

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

	// X Data: Categorical (Band Scale)
	let xData = $derived.by(() => {
		if (!instanceCount) return null;

		const scaleType = setup?.actualXScaleType || chartContext.scaleTypes?.x || 'band';
		if (scaleType !== 'band') return null;

		const raw = resolveChannel({
			value: x,
			channel: 'x',
			dataAccessor: setup?.data,
			instanceCount
		});

		if (!raw) return null;
		if (!chartContext.xScaleState?.processDataForGPU) return null;

		const indices = chartContext.xScaleState.processDataForGPU(raw, markId);
		const xArr = toFloat32(indices);
		
		return { x0Data: xArr, x1Data: xArr };
	});

	let x0Data = $derived(xData?.x0Data);
	let x1Data = $derived(xData?.x1Data);

	// Y0: Stack Output -> y1 prop -> 0
	let y0Data = $derived.by(() => {
		const raw = resolveChannel({
			value: y1,
			channel: 'y1',
			tryColumns: hasStackTransform ? ['y0'] : undefined, // Stack 'vertical' output
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
			tryColumns: hasStackTransform ? ['y1'] : undefined, // Stack 'vertical' output
			dataAccessor: setup?.data,
			instanceCount
		});
		return toFloat32(raw);
	});

	// Color
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

	// Alpha
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
			if (table) {
				setup = new BaseMarkSetup(config, coordinator, chartContext, markId);
			}
		});
	});

	onDestroy(() => {
		setup?.destroy();
	});
</script>

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