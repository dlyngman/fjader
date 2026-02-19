<script>
	import { getContext, onDestroy, untrack } from 'svelte';
	import { BaseMarkSetup } from './BaseMarkSetup.svelte.js';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { inferScaleType } from '$lib/scales/scale-inference.js';
	import { tableSchemaService } from '$lib/data/TableSchemaService.svelte.js';
	import { isColorConstant } from '$lib/scales/color-utils.js';
	import {
		buildSelectFromChannels,
		resolveChannel,
		MarkColor,
		normalizeSortConfig
	} from './utils/index.js';

	const FADE_THRESHOLD = 100;

	let {
		table,
		selection = undefined,
		x,
		y,
		text,
		color = null,
		scheme,
		fontSize = 12,
		fontWeight = 'normal',
		fontFamily = null,
		dx = 0,
		dy = 0,
		textAnchor = 'middle',
		lineAnchor = 'middle',
		rotate = 0,
		format = String,
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = [],
		sort = null,
		tooltip = false
	} = $props();

	const markId = `text-${crypto.randomUUID().slice(0, 8)}`;
	const coordinator = getContext('mosaic-coordinator');
	const chartContext = getContext('chart');
	const scaleRegistry = getContext('scale-registry');

	BaseMarkSetup.ensureServices(coordinator);

	let setup = $state(null);

	// --- Scale Type Inference ---

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

	// --- Color ---

	const markColor = new MarkColor(
		() => color,
		() => scheme,
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// --- Config ---

	const config = $derived({
		markType: 'text',
		supportedScaleTypes: {
			x: ['linear', 'band', 'point', 'time', 'log'],
			y: ['linear', 'band', 'point', 'time', 'log']
		},
		scaleRequirements: {
			x: effectiveXScaleType
				? { type: effectiveXScaleType, priority: SCALE_PRIORITIES.ACCEPT }
				: null,
			y: effectiveYScaleType
				? { type: effectiveYScaleType, priority: SCALE_PRIORITIES.ACCEPT }
				: null
		},
		inferredScaleColumns: { x, y },
		table,
		selection,
		transforms,
		select: buildSelectFromChannels({
			x,
			y,
			text,
			...(markColor.selectField && { color: markColor.selectField })
		}),
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
		if (ArrayBuffer.isView(x)) return x.length;
		return 0;
	});

	// --- Data Resolution (raw values, not Float32) ---

	let xRaw = $derived.by(() => {
		if (!instanceCount) return null;
		return resolveChannel({
			value: x,
			channel: 'x',
			dataAccessor: setup?.data,
			instanceCount
		});
	});

	let yRaw = $derived.by(() => {
		if (!instanceCount) return null;
		return resolveChannel({
			value: y,
			channel: 'y',
			dataAccessor: setup?.data,
			instanceCount
		});
	});

	let textData = $derived.by(() => {
		if (!instanceCount) return null;
		return resolveChannel({
			value: text,
			channel: 'text',
			dataAccessor: setup?.data,
			instanceCount
		});
	});

	// --- Color Resolution (pre-resolved once, not per-label) ---

	const colorCSSValues = $derived.by(() => {
		if (!color) return null;
		if (typeof color === 'string' && isColorConstant(color)) return null;
		if (!markColor.scaleState || !instanceCount) return null;

		const raw = resolveChannel({
			value: color,
			channel: 'color',
			dataAccessor: setup?.data,
			instanceCount
		});
		if (!raw) return null;

		const scale = markColor.scaleState;
		const colors = new Array(instanceCount);
		for (let i = 0; i < instanceCount; i++) {
			colors[i] = scale.getColor(raw[i]);
		}
		return colors;
	});

	const constantColor = $derived(
		!color
			? 'currentColor'
			: typeof color === 'string' && isColorConstant(color)
				? color
				: 'currentColor'
	);

	// --- Label Data (stable — only changes when query data changes, NOT on pan/zoom) ---

	let labelItems = $derived.by(() => {
		if (!xRaw || !yRaw || !textData) return [];

		const colors = colorCSSValues;
		const fallbackColor = constantColor;
		const result = [];
		for (let i = 0; i < instanceCount; i++) {
			const labelText = textData[i];
			if (labelText == null || labelText === '') continue;
			if (xRaw[i] == null || yRaw[i] == null) continue;
			result.push({
				idx: i,
				label: format(labelText),
				color: colors ? colors[i] : fallbackColor
			});
		}
		return result;
	});

	// --- Animation-aware positioning ---

	let useFadeMode = $derived(labelItems.length > FADE_THRESHOLD);
	let scalesAnimating = $state(false);

	// Debounce scale changes to detect animation (setTimeout is a genuine side effect)
	$effect(() => {
		void chartContext.xScale;
		void chartContext.yScale;
		if (!useFadeMode) return;
		scalesAnimating = true;
		const timer = setTimeout(() => {
			scalesAnimating = false;
		}, 150);
		return () => clearTimeout(timer);
	});

	// Position cache — holds stale positions during fade-out so labels don't jump
	let positionCache = [];

	// Compute positions — pure derivation, skips scale reads during high-count animation
	let positions = $derived.by(() => {
		const items = labelItems;
		if (!items.length) return (positionCache = []);

		// High count + animating: return cached stale positions (labels are fading out)
		if (useFadeMode && scalesAnimating) return positionCache;

		const xScale = chartContext.xScale;
		const yScale = chartContext.yScale;
		if (!xScale || !yScale) return positionCache;

		const xType = chartContext.scaleTypes?.x;
		const yType = chartContext.scaleTypes?.y;
		const xDomain =
			xType === 'band' || xType === 'point'
				? chartContext.xScaleState.effectiveDomain
				: null;
		const yDomain =
			yType === 'band' || yType === 'point'
				? chartContext.yScaleState.effectiveDomain
				: null;
		const xBandHalf = xType === 'band' ? xScale.bandwidth() / 2 : 0;
		const yBandHalf = yType === 'band' ? yScale.bandwidth() / 2 : 0;

		const newPos = new Array(items.length);
		for (let i = 0; i < items.length; i++) {
			const dataIdx = items[i].idx;
			let px, py;

			if (xDomain) {
				const cat = xDomain[xRaw[dataIdx]];
				px = cat != null ? xScale(cat) + xBandHalf : 0;
			} else {
				px = xScale(xRaw[dataIdx]);
			}

			if (yDomain) {
				const cat = yDomain[yRaw[dataIdx]];
				py = cat != null ? yScale(cat) + yBandHalf : 0;
			} else {
				py = yScale(yRaw[dataIdx]);
			}

			newPos[i] = { x: px + dx, y: py + dy };
		}
		return (positionCache = newPos);
	});

	// --- Vertical alignment ---
	const dominantBaseline = $derived(
		lineAnchor === 'top' ? 'hanging' : lineAnchor === 'bottom' ? 'auto' : 'central'
	);

	// --- Setup Lifecycle ---

	$effect(() => {
		(void config, xScaleId, yScaleId);
		untrack(() => {
			setup?.destroy();
			setup = null;
			if (table && effectiveXScaleType && effectiveYScaleType) {
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
			markType: 'text',
			scaleTypes: {
				x: chartContext.scaleTypes?.x,
				y: chartContext.scaleTypes?.y
			},
			channelFields: {
				x: typeof x === 'string' ? x : 'x',
				y: typeof y === 'string' ? y : 'y',
				...(color && typeof color === 'string' && !isColorConstant(color) && { color })
			},
			bandDomains: {
				...(chartContext.scaleTypes?.x === 'band' && {
					x: chartContext.xScaleState?.effectiveDomain
				}),
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

{#if (setup?.gpuReady || !table) && markColor.ready && labelItems.length > 0}
	<g
		class="text-mark"
		class:text-mark-hidden={useFadeMode && scalesAnimating}
	>
		{#each labelItems as item, i (item.idx)}
			{@const pos = positions[i]}
			<text
				fill={item.color}
				font-size="{fontSize}px"
				font-weight={fontWeight}
				font-family={fontFamily}
				text-anchor={textAnchor}
				dominant-baseline={dominantBaseline}
				style:transform={pos
					? rotate
						? `translate(${pos.x}px, ${pos.y}px) rotate(${rotate}deg)`
						: `translate(${pos.x}px, ${pos.y}px)`
					: null}
			>{item.label}</text>
		{/each}
	</g>
{/if}

<style>
	.text-mark {
		pointer-events: none;
		transition: opacity 80ms ease-out;
	}

	.text-mark-hidden {
		opacity: 0;
	}
</style>
