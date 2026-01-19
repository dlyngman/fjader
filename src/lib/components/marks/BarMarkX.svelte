<script>
	import { getContext, onDestroy, untrack } from 'svelte';
	import { getScaleState } from '$lib/scales';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { Rects } from '../rendering/index.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import {
		getSourceType,
		processData,
		processColorData,
		processAlphaData,
		buildSelectFromChannels
	} from './utils/index.js';

	let {
		table,
		selection,
		x, // shorthand for x2
		x1 = 0, // baseline (start of bars) - overridden by stack transform
		x2 = x, // end of bars (the data values)
		y, // categorical data
		color,
		alpha = 0.8,
		limit,
		filterNulls = false,
		transforms = [], // NEW: Transform pipeline

		padding,
		paddingInner,
		paddingOuter,
		align = 0.5
	} = $props();

	const markId = `barx-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext('mosaic-coordinator');
	const chartContext = getContext('chart');
	const colorScale = $derived(getScaleState('color', 'ordinal'));

	let setup = $state(null);
	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

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
		select: buildSelectFromChannels({ x1, x2, y, color }),
		transforms, // NEW: Pass transforms to setup
		clientOptions: {
			limit,
			filterNulls: filterNulls ? [x1, x2, y] : null
		}
	});

	// NEW: Use data accessor
	let instanceCount = $derived(setup?.data?.length || 0);

	// Check if transforms modified channels (e.g., stack adds x0/x1)
	let hasStackTransform = $derived(transforms.some((t) => t.type === 'stack'));

	let dataStrategies = $derived({
		x1: getSourceType(x1),
		x2: getSourceType(x2),
		y: getSourceType(y),
		color: getSourceType(color),
		alpha: getSourceType(alpha)
	});

	// X data - use x0/x1 from stack transform if present
	let x0Data = $derived.by(() => {
		if (!setup?.data || !instanceCount) return null;

		// If stack transform provided x0, use it
		if (hasStackTransform) {
			const x0Array = setup.data.getColumn('x0');
			if (x0Array) return x0Array;
		}

		// Otherwise use x1 prop (baseline)
		if (dataStrategies.x1.type === 'constant') {
			const arr = new Float32Array(instanceCount);
			arr.fill(dataStrategies.x1.value);
			return arr;
		}

		return setup.data.getColumn('x1');
	});

	let x1Data = $derived.by(() => {
		if (!setup?.data || !instanceCount) return null;

		// If stack transform provided x1, use it
		if (hasStackTransform) {
			const x1Array = setup.data.getColumn('x1');
			if (x1Array) return x1Array;
		}

		// Otherwise use x2 prop (data values)
		if (dataStrategies.x2.type === 'constant') {
			const arr = new Float32Array(instanceCount);
			arr.fill(dataStrategies.x2.value);
			return arr;
		}

		return setup.data.getColumn('x2');
	});

	// Y data - categorical (band scale)
	let yData = $derived.by(() => {
		if (!setup?.data || !instanceCount || !setup?.actualYScaleType) return null;

		if (setup.actualYScaleType === 'band') {
			const rawArray = setup.data.getColumn('y');
			if (!rawArray) return null;

			const indices = chartContext.yScaleState.processDataForGPU(rawArray, setup.markId);

			// Convert to rectangle coordinates
			const y0Data = new Float32Array(instanceCount);
			const y1Data = new Float32Array(instanceCount);

			for (let i = 0; i < instanceCount; i++) {
				const categoryIndex = indices[i];
				y0Data[i] = categoryIndex;
				y1Data[i] = categoryIndex;
			}

			console.log(`📊 BarMarkX Y data for band scale:`, {
				instanceCount,
				rawCategories: Array.from(rawArray.slice(0, 5)),
				indices: Array.from(indices.slice(0, 5)),
				y0Data: Array.from(y0Data.slice(0, 5)),
				y1Data: Array.from(y1Data.slice(0, 5)), // ← Add this
				scaleReady: chartContext.yScaleState.isReadyForGPU,
				domain: Array.from(chartContext.yScaleState.effectiveDomain) // ← Convert to array
			});

			return { y0Data, y1Data };
		}

		return null;
	});

	let y0Data = $derived(yData?.y0Data);
	let y1Data = $derived(yData?.y1Data);

	// Color data
	let colorData = $derived.by(() => {
		if (!setup?.data || !instanceCount) return null;

		console.log('🎨 colorData strategy:', dataStrategies.color);

		if (dataStrategies.color === 'constant-color') {
			// Use the color prop directly!
			const rgba = new Float32Array(instanceCount * 4);
			const parsed = parseColor(color); // ← Use 'color' prop, not dataStrategies

			console.log('🎨 Constant color parsed:', parsed);

			for (let i = 0; i < instanceCount; i++) {
				rgba.set(parsed, i * 4);
			}

			console.log('🎨 Color array created:', Array.from(rgba.slice(0, 12)));

			return rgba;
		}

		// Variable color needs colorScale
		if (!colorScale) return null;

		const colorArray = setup.data.getColumn('color');
		if (!colorArray) return null;

		const rgba = new Float32Array(instanceCount * 4);
		for (let i = 0; i < instanceCount; i++) {
			const colorValue = colorArray[i];
			const fillColor = colorScale(colorValue);
			const parsed = parseColor(fillColor);
			rgba.set(parsed, i * 4);
		}

		return rgba;
	});

	// Alpha data
	let alphaData = $derived.by(() => {
		if (!instanceCount) return null;

		const alphas = new Float32Array(instanceCount);

		if (dataStrategies.alpha.type === 'constant') {
			alphas.fill(dataStrategies.alpha.value);
		} else {
			const alphaArray = setup.data.getColumn('alpha');
			if (alphaArray) {
				for (let i = 0; i < instanceCount; i++) {
					alphas[i] = alphaArray[i];
				}
			} else {
				alphas.fill(0.8);
			}
		}

		return alphas;
	});

	// Helper to parse color
	function parseColor(color) {
		if (typeof color === 'string' && color.startsWith('#')) {
			const r = parseInt(color.slice(1, 3), 16) / 255;
			const g = parseInt(color.slice(3, 5), 16) / 255;
			const b = parseInt(color.slice(5, 7), 16) / 255;
			return [r, g, b, 1.0];
		}
		return [0.5, 0.5, 0.5, 1.0]; // Default gray
	}

	$effect(() => {
		(void config, xScaleId, yScaleId);

		untrack(() => {
			setup?.destroy();
			setup = new BaseMarkSetup(config, coordinator, chartContext, markId);
		});
	});

	onDestroy(() => {
		setup?.destroy();
	});

	// Temp logging
	$effect(() => {
		if (chartContext?.yScaleState?.isReadyForGPU && chartContext.innerHeight) {
			console.log('📏 Band scale calculations:', {
				innerHeight: chartContext.innerHeight,
				categoryCount: chartContext.yScaleState.effectiveDomain.length,
				bandwidth: chartContext.yScaleState.bandwidth(chartContext.innerHeight),
				step: chartContext.yScaleState.step(chartContext.innerHeight)
			});
		}
	});
</script>

{#if setup?.gpuReady && x0Data && x1Data && y0Data && y1Data}
	<Rects
		{x0Data}
		{x1Data}
		{y0Data}
		{y1Data}
		{colorData}
		{alphaData}
		dataVersion={setup.client.dataVersion}
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
