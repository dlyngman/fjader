<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycleV2 } from './lifecycle/MarkLifecycleV2.svelte';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import {
		buildSelectFromChannels,
		resolveChannel,
		resolveChannelData,
		computeInstanceCount,
		buildTooltipConfig,
		MarkColor,
		inferMarkScaleType,
		generateMarkId,
		resolveTip
	} from './utils';
	import { buildReactiveConfig } from './utils/reactive-config';
	import Texts from '../rendering/Texts.svelte';
	import { TextSlots } from '$lib/gpu/text/TextSlots';
	import type { TextAtlas, TextStyle } from '$lib/gpu/text/TextAtlas.svelte';
	import type {
		FieldRef,
		BaseMarkProps,
		ContinuousScaleTypeProps,
		ChartContext,
		WebGPUCanvasContext
	} from '$lib/types';
	import type { QueryEngine } from '$lib/query-engine/QueryEngine';
	import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';

	/**
	 * Text, drawn on the GPU. Each row's string is rasterized once into the
	 * chart's text atlas (gpu/text/TextAtlas.svelte.ts) and drawn as a quad at
	 * its position (rendering/Texts.svelte), so labels travel with the data
	 * through every morph and reorder, in the same frame as the marks they
	 * label, with no per-frame work on the main thread.
	 *
	 * A canvas mark: place it in `canvasComponents`, next to the marks it
	 * labels. Needs HTML-in-Canvas (Chrome 157+).
	 */

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

	let {
		table,
		selection = undefined,
		selectionResponse = undefined,
		nulls = undefined,
		holdsEntrance = undefined,
		contributeDomain = undefined,
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
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = [],
		sort = null,
		domain = null,
		tooltip = false,
		tooltipProximity,
		tip = undefined
	}: Props = $props();

	const webGPUContext = getContext<WebGPUCanvasContext | undefined>('webgpu-canvas');
	const textAtlas = getContext<TextAtlas | undefined>('text-atlas');
	if (!webGPUContext || !textAtlas) {
		throw new Error(
			"TextMark draws on the GPU: place it in a WebGPUCanvas (the chart's `canvasComponents` snippet), next to the marks it labels, not in `foreground`."
		);
	}

	const markId = generateMarkId('text');
	// Held from mount, as other marks do in ChartConfig.registerMark: TextMark
	// has no config entry, and its lifecycle is built later.
	if (untrack(() => table) && untrack(() => holdsEntrance) !== false) {
		getContext<ChartContext>('chart').config?.entrance.hold(markId);
	}
	const queryEngine = getContext<QueryEngine>('query-engine');
	const chartContext = getContext<ChartContext>('chart');
	const gpuCoordinator = getContext<GPUCoordinator | undefined>('gpu-coordinator') ?? null;
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	if (chartContext.fx) {
		console.warn('[fjader] TextMark does not draw in faceted charts yet.');
	}

	let setup = $state<MarkLifecycleV2 | null>(null);

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
	/** No fill: the page's text colour at the canvas, as SVG text's currentColor was. */
	const constantColor = $derived(
		fill == null ? webGPUContext.getTextColor() : markColor.constantColor
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
		transforms,
		select: { ...channelSelect, ...resolvedTip.extraSelect }
	});

	const reactiveConfig = buildReactiveConfig({
		get sort() {
			return sort;
		},
		get selectionResponse() {
			return selectionResponse;
		},
		get nulls() {
			return nulls;
		},
		get holdsEntrance() {
			return holdsEntrance;
		},
		get contributeDomain() {
			return contributeDomain;
		},
		get limit() {
			return limit;
		},
		get domain() {
			return domain;
		},
		get tip() {
			return tip;
		},
		get tooltip() {
			return tooltip;
		}
	});

	// Rebuild only when a scale is replaced, not on its first resolution.
	let scaleGeneration = $derived(chartContext.scaleGeneration);

	let instanceCount = $derived(computeInstanceCount(setup?.data, x, y));

	// --- Positions, as the GPU reads them (band channels as identity ids) ---

	const xData = $derived.by(() =>
		resolveChannelData({
			value: x,
			channel: 'x',
			dataAccessor: setup?.data,
			instanceCount,
			scaleState: chartContext.xScaleState,
			scaleType: setup?.actualXScaleType || chartContext.scaleTypes?.x,
			markId
		})
	);
	const yData = $derived.by(() =>
		resolveChannelData({
			value: y,
			channel: 'y',
			dataAccessor: setup?.data,
			instanceCount,
			scaleState: chartContext.yScaleState,
			scaleType: setup?.actualYScaleType || chartContext.scaleTypes?.y,
			markId
		})
	);

	// --- Strings → atlas slots, per data change ---

	/**
	 * Each row's formatted string, or null for a row that draws nothing: no
	 * text, or no position. Formatting happens here, once per data change.
	 */
	const labels = $derived.by((): (string | null)[] | null => {
		if (!instanceCount) return null;
		const raw = (channel: 'x' | 'y' | 'text', value: FieldRef) =>
			resolveChannel({ value, channel, dataAccessor: setup?.data, instanceCount });
		const texts = raw('text', text);
		const xs = raw('x', x);
		const ys = raw('y', y);
		if (!texts || !xs || !ys) return null;
		const out = new Array<string | null>(instanceCount);
		for (let i = 0; i < instanceCount; i++) {
			const t = texts[i];
			out[i] = t == null || t === '' || xs[i] == null || ys[i] == null ? null : String(format(t));
		}
		return out;
	});

	const style: TextStyle = $derived({ fontSize, fontWeight, fontFamily });

	/**
	 * The rows' atlas slots: new strings are staged, and the rows switch to
	 * them once they are painted (gpu/text/TextSlots.ts), so no label blinks
	 * out while its new string waits for the atlas.
	 */
	const textSlots = new TextSlots(textAtlas);
	let slotData = $state<Float32Array | null>(null);
	let staged = $state(0);
	$effect(() => {
		const rows = labels;
		const s = style;
		// A row's key: its category's id on the band axis it is aligned on, if any.
		const band = setup?.alignedBand;
		const keys = band === 'x' ? xData : band === 'y' ? yData : null;
		untrack(() => {
			const interim = textSlots.stage(rows, s, keys);
			if (interim) slotData = interim;
			staged++;
		});
	});
	$effect(() => {
		void staged;
		void textAtlas.paintVersion;
		untrack(() => {
			const committed = textSlots.commit();
			if (committed) slotData = committed;
		});
	});

	// --- Setup Lifecycle ---

	$effect(() => {
		(void config, scaleGeneration);
		untrack(() => {
			if (setup) gpuCoordinator?.markForRetain(markId);
			setup?.destroy();
			setup = null;
			if (table && effectiveXScaleType && effectiveYScaleType && queryEngine) {
				setup = new MarkLifecycleV2(
					config,
					reactiveConfig,
					queryEngine,
					chartContext,
					markId,
					filterGroups.get(selection as string | undefined),
					// The coordinator's frame loop drives a bin() channel's adaptive
					// rebinning: without it, labels on a histogram's bins kept the
					// bins of the full extent while the bars rebinned under them.
					{ gpuCoordinator }
				);
			}
		});
	});

	// Tooltip registration — guard conditions are tracked; registration body
	// runs in untrack() to avoid reactive deps on scaleTypes/colorScaleState
	// that cause spurious unregister/re-register cycles.
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !tooltip || !setup?.tooltipEnabled) return;
		untrack(() => {
			tm.registerMark(
				markId,
				buildTooltipConfig({
					tempTable: setup!.tooltipTableName,
					markType: 'text',
					chartContext,
					channelFields: setup!.channelFieldMap,
					colorColumn: 'fill',
					bandAxes: { x: true, y: true },
					markColor,
					proximityAxis: tooltipProximity,
					displayFields: resolvedTip.displayFields
				})
			);
		});
		return () => tm.unregisterMark(markId);
	});

	onDestroy(() => {
		textSlots.destroy();
		setup?.destroy();
		// No config entry to unregister, which is where other marks release it.
		chartContext.config?.entrance.release(markId);
		gpuCoordinator?.releaseRetained(markId);
	});
</script>

{#if !chartContext.fx && (setup?.gpuReady || !table) && markColor.ready && xData && yData && slotData}
	<Texts
		{markId}
		{xData}
		{yData}
		{slotData}
		colorValueData={markColor.data}
		colorMode={markColor.colorMode}
		colorScaleIndex={markColor.colorScaleIndex}
		groupIndex={setup?.groupIndex ?? 0}
		{constantColor}
		{textAnchor}
		{lineAnchor}
		{dx}
		{dy}
		{rotate}
		dataVersion={setup?.dataVersion || 0}
		landsFor={setup?.landsFor ?? 0}
		bandAxis={setup?.alignedBand ?? null}
	/>
{/if}
