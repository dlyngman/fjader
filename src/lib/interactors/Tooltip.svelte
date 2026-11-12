<!--
  Tooltip.svelte - Display component for data tooltips.

  Reads from TooltipManager (via context) and renders a floating tooltip
  at the cursor. It is a manual popover, so it paints in the top layer and no
  overflow, scroll area, stacking context or transformed ancestor clips it. It
  stays in the chart's DOM, so inherited theme variables and scoped styles still
  apply. Placed in viewport pixels with the `translate` property (no layout per
  move), flipped and clamped against the viewport, and measured by a
  ResizeObserver rather than by reading its size.

  Always renders one point at a time (stable layout). When multiple
  points match, colored dots appear at the bottom and the user can
  cycle through series with [ / ] keys.
-->
<script lang="ts">
	import { getContext } from 'svelte';
	import { format as d3format } from 'd3-format';
	import { categoryLabel } from '$lib/query-engine/categorical-identity';
	import type { ChartContext, ContinuousScaleState } from '$lib/types';
	import { otherTooltipRows } from './other-tooltip';

	const commaFormat = d3format(',.4~g');

	interface Props {
		fields?: string[] | null;
		formatters?: Record<string, (value: unknown) => string>;
	}

	const chart = getContext<ChartContext>('chart');

	let { fields = null, formatters = {} }: Props = $props();

	let tm = $derived(chart?.tooltipManager);
	let visible = $derived(tm?.visible ?? false);
	let point = $derived(tm?.focusedPoint ?? null);
	let match = $derived(tm?.focusedMatch ?? null);
	let matched = $derived(tm?.matchedPoints ?? []);
	let focusedIndex = $derived(tm?.focusedIndex ?? 0);
	let isMulti = $derived(matched.length > 1);
	let colorField = $derived(tm?.currentColorField ?? null);
	let channelFields = $derived(tm?.currentChannelFields ?? null);
	let displayFields = $derived(tm?.currentDisplayFields ?? null);
	let px = $derived(tm?.pointerClientX ?? 0);
	let py = $derived(tm?.pointerClientY ?? 0);

	// The tooltip's size, from a ResizeObserver: read after the browser's own
	// layout, so measuring forces none. Its width is a high-water mark (grows,
	// never shrinks) so it does not jitter between points: content wider than
	// min-width makes the observed width exceed it, and min-width follows.
	let minWidth = $state(0);
	let tooltipW = $state(0);
	let tooltipH = $state(0);

	function measure(el: HTMLElement) {
		const observer = new ResizeObserver((entries) => {
			const box = entries[entries.length - 1].borderBoxSize[0];
			// A closed popover is display: none and reports 0: keep the last size.
			if (box.inlineSize === 0) return;
			tooltipW = box.inlineSize;
			tooltipH = box.blockSize;
			if (box.inlineSize > minWidth) minWidth = box.inlineSize;
		});
		observer.observe(el);
		return () => observer.disconnect();
	}

	// The viewport, without the scrollbars. Read when the tooltip opens and on
	// resize, never per move.
	let viewW = $state(0);
	let viewH = $state(0);
	function readViewport() {
		const root = document.documentElement;
		viewW = root.clientWidth;
		viewH = root.clientHeight;
	}

	// Open in the top layer while shown; closed again once it has faded out, so a
	// page of charts keeps at most the hovered one's tooltip there.
	function popover(el: HTMLElement) {
		if (visible && !el.matches(':popover-open')) {
			readViewport();
			el.showPopover();
		}
	}
	function handleTransitionEnd(event: TransitionEvent) {
		const el = event.currentTarget as HTMLElement;
		if (event.propertyName === 'opacity' && !visible && el.matches(':popover-open')) {
			el.hidePopover();
		}
	}

	// Left of the cursor when it fits, else right; below it, else above. With
	// hysteresis so it does not jitter at the edge. Then clamped into the viewport,
	// for a tooltip that fits on neither side.
	const GAP = 12;
	const HYSTERESIS = 40;
	const MARGIN = 8;
	let leftOfCursor = true;
	let aboveCursor = false;
	const flippedX = $derived.by(() => {
		const spaceLeft = px - tooltipW - GAP;
		leftOfCursor = spaceLeft >= 0 && (leftOfCursor || spaceLeft >= HYSTERESIS);
		return leftOfCursor;
	});
	const flippedY = $derived.by(() => {
		const spaceBelow = viewH - py - tooltipH;
		aboveCursor = spaceBelow < 0 || (aboveCursor && spaceBelow < HYSTERESIS);
		return aboveCursor;
	});
	const clamp = (v: number, max: number) => Math.max(MARGIN, Math.min(v, max - MARGIN));
	const left = $derived(clamp(flippedX ? px - tooltipW - GAP : px + GAP, viewW - tooltipW));
	const top = $derived(clamp(flippedY ? py - tooltipH + 4 : py - 4, viewH - tooltipH));

	// Transform origin: corner nearest the anchor point
	let originX = $derived(flippedX ? '100%' : '0%');
	let originY = $derived(flippedY ? '100%' : '0%');

	// Reverse lookup: field name → axis channel ('x' or 'y') for channel icons
	let fieldToChannel = $derived.by(() => {
		if (!channelFields) return {};
		const map: Record<string, string> = {};
		for (const [channel, field] of Object.entries(channelFields)) {
			const axis = channel.startsWith('x') ? 'x' : channel.startsWith('y') ? 'y' : null;
			if (axis) map[field] = axis;
		}
		return map;
	});

	function getChannel(key: string) {
		return fieldToChannel[key] ?? (/^x\d?$/.test(key) ? 'x' : /^y\d?$/.test(key) ? 'y' : null);
	}

	// Keys to display — per-mark displayFields (from tip) takes priority over component-level fields
	let keys = $derived.by(() => {
		if (!point) return [];
		if (displayFields) return displayFields.filter((k) => k in point);
		if (fields) return fields.filter((k) => k in point);
		// Keys starting with `_` are kept for clicks (a band's raw id), never shown.
		return Object.keys(point).filter((k) => !k.startsWith('_'));
	});

	// Scale-aware formatters for numeric values (same as MarginLabel)
	const xFormat = $derived(
		chart.xScaleState && chart.xScaleState.scaleType !== 'band'
			? (v: number) => (chart.xScaleState as ContinuousScaleState).formatValue(v)
			: null
	);
	const yFormat = $derived(
		chart.yScaleState && chart.yScaleState.scaleType !== 'band'
			? (v: number) => (chart.yScaleState as ContinuousScaleState).formatValue(v)
			: null
	);

	// An Other bar's rows, after the point's own: written with the value axis's format.
	let otherRows = $derived.by(() => {
		const stats = tm?.focusedOtherStats;
		if (!stats || !point) return [];
		const format = ('__bandIdX' in point ? yFormat : xFormat) ?? commaFormat;
		return otherTooltipRows(stats, format);
	});

	function formatValue(key: string, value: unknown) {
		if (formatters[key]) return formatters[key](value);
		if (typeof value === 'number') {
			const channel = getChannel(key);
			const fmt = channel === 'x' ? xFormat : channel === 'y' ? yFormat : null;
			if (fmt) return fmt(value);
			return commaFormat(value);
		}
		return String(categoryLabel(value));
	}

	const channelIcons: Record<string, string> = { x: '\u2192', y: '\u2191' };

	// Computed style values — kept here so Prettier can't break them by line-wrapping.
	// `translate`, not `transform` or left/top: it moves the box without layout, and
	// it applies after `scale`, so the pop-in scales about the box's own corner.
	const translate = $derived(`${left}px ${top}px`);
	const transformOrigin = $derived(`${originX} ${originY}`);
</script>

<svelte:window onresize={readViewport} />

<!-- In the top layer, placed in viewport pixels with flip detection -->
<div
	class="tooltip"
	class:visible
	popover="manual"
	{@attach measure}
	{@attach popover}
	ontransitionend={handleTransitionEnd}
	style:translate
	style:transform-origin={transformOrigin}
	style:min-width="{minWidth}px"
>
	{#each keys as key (key)}
		<div class="row">
			<span class="key">
				<span class="channel-icon">{channelIcons[getChannel(key)] ?? ''}</span>
				{key}
			</span>
			<span class="value">
				{#if key === colorField && match?.color}
					<span class="swatch" style="background-color: {match.color};"></span>
				{/if}
				{formatValue(key, point?.[key])}
			</span>
		</div>
	{/each}
	{#each otherRows as row (row.key)}
		<div class="row">
			<span class="key">{row.key}</span>
			<span class="value">{row.value}</span>
		</div>
	{/each}
	<div class="dots" class:show={isMulti}>
		{#each matched as m, i (i)}
			<span
				class="dot"
				class:focused={i === focusedIndex}
				style="background-color: {m.color ?? 'currentColor'};"
			></span>
		{/each}
	</div>
</div>

<style>
	.tooltip {
		/* A popover in the top layer: fixed to the viewport at its origin, placed by
		   translate. Resets the UA popover box (inset, margin, border, overflow). */
		position: fixed;
		inset: 0 auto auto 0;
		margin: 0;
		border: 0;
		overflow: visible;
		background: var(--fjader-tooltip-bg, rgba(0, 0, 0, 0.88));
		color: var(--fjader-tooltip-text, #ffffff);
		padding: 6px 10px;
		border-radius: 4px;
		font-family: var(--fjader-font, system-ui, sans-serif);
		font-size: 12px;
		line-height: 1.4;
		pointer-events: none;
		white-space: nowrap;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
		opacity: 0;
		scale: 0.78;
		transition:
			opacity 100ms ease-out,
			scale 200ms cubic-bezier(0.34, 1.3, 0.64, 1);
		will-change: opacity, scale, translate;
	}

	.tooltip.visible {
		opacity: 1;
		scale: 1;
	}

	/* Opening the popover takes it out of display: none, which runs no transition:
	   start the pop-in from the hidden look. */
	@starting-style {
		.tooltip.visible {
			opacity: 0;
			scale: 0.78;
		}
	}

	.row {
		display: flex;
		gap: 8px;
		justify-content: space-between;
	}

	.key {
		display: flex;
		align-items: center;
		gap: 3px;
		opacity: 0.6;
	}

	.channel-icon {
		display: inline-block;
		width: 10px;
		text-align: center;
		font-size: 9px;
		opacity: 0.6;
	}

	.swatch {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 2px;
		flex-shrink: 0;
	}

	.value {
		display: flex;
		align-items: center;
		gap: 4px;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}

	.dots {
		display: flex;
		gap: 3px;
		justify-content: center;
		padding-top: 0;
		max-height: 0;
		overflow: hidden;
		transition:
			max-height 150ms ease-out,
			padding-top 150ms ease-out;
	}

	.dots.show {
		max-height: 14px;
		padding-top: 4px;
	}

	.dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		opacity: 0;
		transition: opacity 80ms;
	}

	.dots.show .dot {
		opacity: 0.3;
	}

	.dots.show .dot.focused {
		opacity: 1;
	}
</style>
