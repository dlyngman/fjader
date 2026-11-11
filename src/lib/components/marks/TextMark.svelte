<script lang="ts">
	import { NO_GROUP } from '$lib/components/rendering/activity-reads';
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycleV2 } from './lifecycle/MarkLifecycleV2.svelte';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { isColorConstant } from '$lib/scales/color-utils';
	import {
		buildSelectFromChannels,
		resolveChannel,
		computeInstanceCount,
		buildTooltipConfig,
		MarkColor,
		inferMarkScaleType,
		generateMarkId,
		resolveTip
	} from './utils';
	import { buildReactiveConfig } from './utils/reactive-config';
	import type { FieldRef, BaseMarkProps, ContinuousScaleTypeProps, ChartContext } from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { QueryEngine } from '$lib/query-engine/QueryEngine';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';

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
		selectionResponse = undefined,
		nulls = undefined,
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

	const markId = generateMarkId('text');
	const queryEngine = getContext<QueryEngine>('query-engine');
	const chartContext = getContext<ChartContext>('chart');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

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

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, x, y));

	// --- Data Resolution (raw values, not Float32) ---

	/**
	 * The key a raw band channel value travels under — what `tickSlot` and
	 * `tickPosition` take.
	 *
	 * resolveChannel gives the UNPROCESSED channel, so this is a string when the
	 * query left real category values in place — a category-reducing transform
	 * on a scale with no dim — and a number when it carries an identity id.
	 * (An expression-backed axis was in the first group until `c55e719` gave it
	 * a dim; it is in the second now.)
	 *
	 * A number is ALREADY the key, in both spaces: with identity it is the dim
	 * id the slot table is indexed by, and without it the display position,
	 * which is what the slots are laid out in when there is no identity. Only a
	 * string has to be looked up, and the scale does that from a cached map —
	 * this runs per label per FRAME while an axis is in transition, so a scan of
	 * the domain here would be O(labels x categories) every frame.
	 *
	 * The string case used to index the domain array by name, get undefined, and
	 * pin every such label at pixel 0.
	 */
	function bandSlotKey(band: BandScaleState, raw: string | number): number | null {
		return typeof raw === 'string' ? band.channelValueFor(raw) : raw;
	}

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

	/** The raw fill channel, once per data change: colours and dimming both read it. */
	const fillRaw = $derived.by(() => {
		if (!fill) return null;
		if (typeof fill === 'string' && isColorConstant(fill)) return null;
		if (!markColor.scaleState || !instanceCount) return null;
		return resolveChannel({
			value: fill,
			channel: 'fill',
			dataAccessor: setup?.data,
			instanceCount
		});
	});

	const colorCSSValues = $derived.by(() => {
		const raw = fillRaw;
		if (!raw || !markColor.scaleState) return null;

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

	// --- Selection dimming ---
	//
	// A label dims with the bars it labels: by its band axes and its ordinal
	// colour, in its own filter group, the fields activity-reads.ts lists for
	// text. Routing reads the same list, so a categorical selection on one of
	// these fields dims the labels instead of filtering them away.

	/**
	 * Per-label dimming sources, resolved once per data change, not per frame.
	 * Each is a field's identity key and the label's dim ids on it: a scale has an
	 * identity key only while its channel carries ids, so the raw column is the
	 * ids, and reading the fade by id is what reaches an Other bucket.
	 */
	const dimming = $derived.by(() => {
		// A 'filter' mark (NO_GROUP) never dims, as its GPU marks do not.
		if (!setup || !filterGroups || setup.groupIndex === NO_GROUP) return null;
		const groups = [setup.groupIndex];
		const sources: Array<{ key: string; ids: ArrayLike<unknown> }> = [];
		for (const axis of ['x', 'y'] as const) {
			const type = chartContext.scaleTypes?.[axis];
			if (type !== 'band' && type !== 'point') continue;
			const band = chartContext[`${axis}ScaleState`] as BandScaleState | null;
			const raw = axis === 'x' ? xRaw : yRaw;
			// Identity keys only, as routing reads them: a field without identity
			// filters the labels, so they do not dim by it too.
			const key = band?.identityKey;
			if (!key || !raw) continue;
			sources.push({ key, ids: raw as ArrayLike<unknown> });
		}
		const color = markColor.scaleState;
		const raw = fillRaw;
		const colorKey = color?.isOrdinal ? color.identityKey : null;
		if (colorKey && raw) sources.push({ key: colorKey, ids: raw as ArrayLike<unknown> });
		return sources.length ? { groups, sources } : null;
	});

	/** How visible label `idx` is now: the least visible of its categories. */
	function labelOpacity(idx: number): number {
		const d = dimming;
		if (!d) return 1;
		let opacity = 1;
		for (const source of d.sources) {
			const raw = source.ids[idx];
			// An id reads its fade by id. Anything else (a string from a channel
			// that never carried ids, a null) is a value, read as one: never coerced
			// to a number, where a string becomes NaN and null becomes category 0.
			const selected = Number.isInteger(raw)
				? filterGroups.opacityOfId(source.key, d.groups, raw as number)
				: filterGroups.opacityOfValue(source.key, d.groups, raw);
			opacity = Math.min(opacity, selected);
		}
		return opacity;
	}

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
		// The band scale itself, not its domain array. The channel carries an
		// identity id, which indexes the scale's VALUES; the domain is in display
		// order and indexing it with an id puts every label on the wrong row as
		// soon as the axis is sorted (the GPU gets this right via identitySlots, so
		// the symptom is correct bars with shuffled text). bandSlotKey and
		// tickPosition handle both cases — see BandScaleState's
		// IDENTITY <-> DISPLAY section.
		const xBand =
			xType === 'band' || xType === 'point' ? (chartContext.xScaleState as BandScaleState) : null;
		const yBand =
			yType === 'band' || yType === 'point' ? (chartContext.yScaleState as BandScaleState) : null;
		// A band label is placed through the SLOT TABLE, not through the d3
		// scale. The d3 scale carries the settled domain, so a label positioned
		// by it jumps to its final place on the frame a reorder lands while its
		// bar is still travelling — the same gap the axis ticks had, and this was
		// the last consumer left with it. tickPosition returns the centre of the
		// category's CURRENT fractional slot, so the two move together, and it
		// reads the transition's frame counter, so this derivation follows it.
		//
		// It also already includes the half-band the d3 path had to add by hand,
		// and is correct for a point scale, where paddingInner is 1 and that
		// half is zero.
		//
		// NOT in fade mode: above FADE_THRESHOLD labels this derivation returns
		// the cache while the scales are moving, so those labels hold their last
		// place and fade rather than travelling. That is the existing trade for
		// high counts, and it applies to a band transition as much as to a pan.
		const rangeX = chartContext.innerWidth;
		const rangeY = chartContext.innerHeight;

		// A category this axis is not displaying — filtered out by a transform,
		// or belonging to another table on a shared scale — has no place to be
		// drawn, so it is not drawn. Its slot is the -1 sentinel, which the band
		// layout would happily turn into a real coordinate one step outside the
		// range: a label off the left edge, or below the axis, where the shader
		// discards the bar it belongs to. The GPU states this discard explicitly
		// rather than leaving it to the scissor rect, and so does this.
		const slotted = (
			band: BandScaleState,
			raw: string | number,
			range: number,
			axis: 'x' | 'y'
		) => {
			const key = bandSlotKey(band, raw);
			if (key == null) return null;
			// Asked once and handed on: tickPosition would look it up again.
			const slot = band.tickSlot(key);
			return slot < 0 ? null : band.slotPosition(slot, range, axis);
		};

		const newPos = new Array(items.length);
		for (let i = 0; i < items.length; i++) {
			const dataIdx = items[i].idx;
			let px, py;

			if (xBand) {
				px = slotted(xBand, xRaw[dataIdx], rangeX, 'x');
			} else {
				px = xScale(xRaw[dataIdx]);
			}

			if (yBand) {
				py = slotted(yBand, yRaw[dataIdx], rangeY, 'y');
			} else {
				py = yScale(yRaw[dataIdx]);
			}

			newPos[i] = px == null || py == null ? null : { x: px + dx, y: py + dy };
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
			if (table && effectiveXScaleType && effectiveYScaleType && queryEngine) {
				setup = new MarkLifecycleV2(
					config,
					reactiveConfig,
					queryEngine,
					chartContext,
					markId,
					filterGroups.get(selection as string | undefined)
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
		setup?.destroy();
	});
</script>

{#if (setup?.gpuReady || !table) && markColor.ready && labelItems.length > 0}
	<g class="text-mark" class:text-mark-hidden={useFadeMode && scalesAnimating}>
		{#each labelItems as item, i (item.idx)}
			{@const pos = positions[i]}
			<!--
				No position, no label. A category the axis is not displaying has
				nowhere to be, and an untransformed <text> is not invisible — it
				renders at the origin of the group, in the top-left corner of the
				plot, which is how a missing position used to show up.
			-->
			{#if pos}
				<text
					fill={item.color}
					fill-opacity={labelOpacity(item.idx)}
					font-size="{fontSize}px"
					font-weight={fontWeight}
					font-family={fontFamily}
					text-anchor={textAnchor}
					dominant-baseline={dominantBaseline}
					style:transform={rotate
						? `translate(${pos.x}px, ${pos.y}px) rotate(${rotate}deg)`
						: `translate(${pos.x}px, ${pos.y}px)`}>{item.label}</text
				>
			{/if}
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
