<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycle } from './lifecycle/MarkLifecycle.svelte';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { isColorConstant } from '$lib/scales/color-utils';
	import {
		buildSelectFromChannels,
		resolveChannel,
		computeInstanceCount,
		buildTooltipConfig,
		MarkColor,
		normalizeSortConfig,
		inferMarkScaleType,
		generateMarkId,
		resolveTip,
		resolveSelection
	} from './utils';
	import type {
		FieldRef,
		BaseMarkProps,
		ContinuousScaleTypeProps,
		Coordinator,
		ChartContext
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import type { D3BandScale } from '$lib/types';

	interface Props extends BaseMarkProps, ContinuousScaleTypeProps {
		x: FieldRef;
		y: FieldRef;
		text: FieldRef;
		fill?: FieldRef | null;
		fontSize?: number;
		fontWeight?: string;
		fontFamily?: string | null;
		dx?: number;
		dy?: number;
		textAnchor?: 'start' | 'middle' | 'end';
		lineAnchor?: 'top' | 'middle' | 'bottom';
		rotate?: number;
		format?: (value: unknown) => string;
	}

	const FADE_THRESHOLD = 100;

	let {
		table,
		selection = undefined,
		x,
		y,
		text,
		fill = null,
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
		tooltip = false,
		tooltipProximity,
		tip = undefined
	}: Props = $props();

	const markId = generateMarkId('text');
	const coordinator = getContext<Coordinator>('mosaic-coordinator');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	MarkLifecycle.ensureServices(coordinator);

	let setup = $state(null);

	// --- Scale Type Inference ---
	const effectiveXScaleType = $derived.by(() => inferMarkScaleType(x, table, preferredXScaleType));
	const effectiveYScaleType = $derived.by(() => inferMarkScaleType(y, table, preferredYScaleType));

	// --- Color ---

	const markColor = new MarkColor(
		() => fill,
		() => scheme,
		'fill',
		() => table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// --- Config ---

	const channelSelect = $derived(
		buildSelectFromChannels({
			x,
			y,
			text,
			...(markColor.selectField && { fill: markColor.selectField })
		})
	);
	const resolvedTip = $derived(resolveTip(tip, channelSelect));

	const config = $derived({
		markType: 'text',
		supportedScaleTypes: {
			x: ['linear', 'band', 'point', 'time', 'log', 'symlog'],
			y: ['linear', 'band', 'point', 'time', 'log', 'symlog']
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
		selection: resolveSelection(selection),
		transforms,
		select: { ...channelSelect, ...resolvedTip.extraSelect },
		clientOptions: { limit, filterNulls: filterNulls ? [x, y] : null },
		sort: normalizeSortConfig(sort),
		tooltip: tip === false ? false : tooltip
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, x, y));

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
		if (!fill) return null;
		if (typeof fill === 'string' && isColorConstant(fill)) return null;
		if (!markColor.scaleState || !instanceCount) return null;

		const raw = resolveChannel({
			value: fill,
			channel: 'fill',
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
		!fill
			? 'currentColor'
			: typeof fill === 'string' && isColorConstant(fill)
				? fill
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
				? (chartContext.xScaleState as BandScaleState).effectiveDomain
				: null;
		const yDomain =
			yType === 'band' || yType === 'point'
				? (chartContext.yScaleState as BandScaleState).effectiveDomain
				: null;
		const xBandHalf = xType === 'band' ? (xScale as D3BandScale).bandwidth() / 2 : 0;
		const yBandHalf = yType === 'band' ? (yScale as D3BandScale).bandwidth() / 2 : 0;

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
				setup = new MarkLifecycle(config, coordinator, chartContext, markId);
			}
		});
	});

	// Tooltip registration
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !tooltip || !setup?.tooltipEnabled) return;
		tm.registerMark(
			markId,
			buildTooltipConfig({
				tempTable: setup.tooltipTableName,
				markType: 'text',
				chartContext,
				channelFields: setup.channelFieldMap,
				colorColumn: 'fill',
				bandAxes: { x: true, y: true },
				markColor,
				proximityAxis: tooltipProximity,
				displayFields: resolvedTip.displayFields
			})
		);
		return () => tm.unregisterMark(markId);
	});

	onDestroy(() => {
		setup?.destroy();
	});
</script>

{#if (setup?.gpuReady || !table) && markColor.ready && labelItems.length > 0}
	<g class="text-mark" class:text-mark-hidden={useFadeMode && scalesAnimating}>
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
					: null}>{item.label}</text
			>
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
