<script>
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { Dots } from '../rendering/index.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { isColorConstant, parseColorToRGBA } from '$lib/scales/color-utils.js';

	let {
		table,
		selection,
		x,
		y,
		color = null,        // Can be: null, "#ff0000", "red", "fieldName", { field, scheme }
		scheme = 'tableau10', // Default scheme for field-based color
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
		// No color prop → constant default
		if (color == null) {
			return {
				mode: 'constant',
				value: [0.13, 0.55, 0.13, 1.0] // Default forest green
			};
		}

		// Object form: { field: 'species', scheme: 'category10' }
		if (typeof color === 'object' && color.field) {
			return {
				mode: 'field',
				field: color.field,
				scheme: color.scheme || scheme
			};
		}

		// String: could be constant ("#ff0000", "red") or field name ("species")
		if (typeof color === 'string') {
			if (isColorConstant(color)) {
				return {
					mode: 'constant',
					value: parseColorToRGBA(color)
				};
			} else {
				// Treat as field name
				return {
					mode: 'field',
					field: color,
					scheme: scheme
				};
			}
		}

		// Fallback
		return {
			mode: 'constant',
			value: [0.13, 0.55, 0.13, 1.0]
		};
	});

	// Build select config based on color mode
	const selectConfig = $derived({
		x,
		y,
		...(colorConfig.mode === 'field' && { color: colorConfig.field })
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
	let instanceCount = $derived(setup?.data?.length || 0);

	// Get or create color scale when in field mode
	$effect(() => {
		if (colorConfig.mode === 'field' && scaleRegistry) {
			untrack(() => {
				// Request color scale from registry
				colorScaleState = scaleRegistry.getOrCreateScale(
					colorConfig.field,
					'color',
					{ scheme: colorConfig.scheme },
					chartContext.chartId
				);

				// Register table with color scale for ViewManager integration
				if (colorScaleState && table) {
					colorScaleState.registerTable(table);
				}
			});
		} else {
			colorScaleState = null;
		}
	});

	// Pass color scale to setup for domain discovery via DISTINCT query
	// This must happen before categorical fetch completes
	$effect(() => {
		if (setup && colorScaleState && colorConfig.mode === 'field') {
			setup.setColorScale(colorScaleState);
		}
	});

	// X data
	let xData = $derived.by(() => {
		if (!setup?.data || setup.data.length === 0) return null;

		const rawArray = setup.data.getColumn('x');
		if (!rawArray) return null;

		if (setup.actualXScaleType === 'band' || setup.actualXScaleType === 'point') {
			const processed = chartContext.xScaleState.processDataForGPU(rawArray, setup.markId);
			return processed instanceof Float32Array ? processed : new Float32Array(processed);
		}

		return rawArray;
	});

	// Y data
	let yData = $derived.by(() => {
		if (!setup?.data || setup.data.length === 0) return null;

		const rawArray = setup.data.getColumn('y');
		if (!rawArray) return null;

		if (setup.actualYScaleType === 'band' || setup.actualYScaleType === 'point') {
			const processed = chartContext.yScaleState.processDataForGPU(rawArray, setup.markId);
			return processed instanceof Float32Array ? processed : new Float32Array(processed);
		}

		return rawArray;
	});

	// Color value data (raw values for GPU lookup, or null for constant mode)
	let colorValueData = $derived.by(() => {
		if (colorConfig.mode !== 'field') return null;
		if (!setup?.data || !instanceCount || !colorScaleState?.ready) return null;

		const colorArray = setup.data.getColumn('color');
		if (!colorArray) return null;

		// Use ColorScaleState to convert to GPU-ready values
		return colorScaleState.processDataForGPU(colorArray);
	});

	// Radius data
	let radiusData = $derived.by(() => {
		if (!instanceCount) return null;

		const radii = new Float32Array(instanceCount);

		if (typeof radius === 'function') {
			const xArray = setup?.data?.getColumn('x');
			const yArray = setup?.data?.getColumn('y');

			if (!xArray || !yArray) return null;

			for (let i = 0; i < instanceCount; i++) {
				radii[i] = radius({ x: xArray[i], y: yArray[i] });
			}
		} else {
			radii.fill(radius);
		}

		return radii;
	});

	// Alpha data
	let alphaData = $derived.by(() => {
		if (!instanceCount) return null;

		const alphas = new Float32Array(instanceCount);
		alphas.fill(alpha);
		return alphas;
	});

	// Props for Dots renderer
	let colorMode = $derived(colorConfig.mode === 'field' ? 1 : 0);
	let colorScaleIndex = $derived(colorScaleState?.gpuIndex ?? 0);
	let constantColor = $derived(
		colorConfig.mode === 'constant' ? colorConfig.value : [0, 0, 0, 1]
	);

	// Ready check: include color scale readiness for field mode
	let colorReady = $derived(
		colorConfig.mode === 'constant' || (colorScaleState?.ready ?? false)
	);

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
</script>

{#if setup?.gpuReady && colorReady && xData && yData}
	<Dots
		{xData}
		{yData}
		{colorValueData}
		{radiusData}
		{alphaData}
		{colorMode}
		{colorScaleIndex}
		{constantColor}
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
		Initializing mark...
	</text>
{/if}