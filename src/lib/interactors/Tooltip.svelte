<!--
  Tooltip.svelte - Display component for data tooltips.

  Reads from TooltipManager (via context) and renders a floating tooltip
  at the cursor position. Uses CSS anchor positioning for automatic
  edge-aware placement.

  Always renders one point at a time (stable layout). When multiple
  points match, colored dots appear at the bottom and the user can
  cycle through series with [ / ] keys.
-->
<script lang="ts">
	import { getContext } from 'svelte';
	import type { ChartContext, ContinuousScaleState } from '$lib/types';

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
	let px = $derived(tm?.pointerScreenX ?? 0);
	let py = $derived(tm?.pointerScreenY ?? 0);

	// High-water mark for tooltip width — grows but never shrinks.
	let tooltipEl: HTMLDivElement;
	let minWidth = $state(0);
	let tooltipW = $state(0);
	let tooltipH = $state(0);

	$effect(() => {
		// Dependencies: re-measure when focused point or index changes
		void point;
		void focusedIndex;
		if (!visible || !tooltipEl) return;
		const prev = tooltipEl.style.minWidth;
		tooltipEl.style.minWidth = '0px';
		const natural = tooltipEl.offsetWidth;
		tooltipEl.style.minWidth = prev;
		if (natural > minWidth) minWidth = natural;
		tooltipW = tooltipEl.offsetWidth;
		tooltipH = tooltipEl.offsetHeight;
	});

	// Flip when tooltip would overflow chart bounds, with hysteresis to prevent jitter
	const GAP = 12;
	const HYSTERESIS = 40;
	let flippedX = $state(true);
	let flippedY = $state(false);
	$effect(() => {
		const spaceLeft = px - tooltipW - GAP;
		flippedX = spaceLeft >= 0 && (!flippedX ? spaceLeft >= HYSTERESIS : true);
		const spaceY = chart.height - py - tooltipH;
		flippedY = spaceY < 0 || (flippedY && spaceY < HYSTERESIS);
	});

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
		return Object.keys(point);
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

	function formatValue(key: string, value: unknown) {
		if (formatters[key]) return formatters[key](value);
		if (typeof value === 'number') {
			const channel = getChannel(key);
			const fmt = channel === 'x' ? xFormat : channel === 'y' ? yFormat : null;
			if (fmt) return fmt(value);
			return Number.isInteger(value) ? value.toString() : value.toFixed(2);
		}
		return String(value);
	}

	const channelIcons: Record<string, string> = { x: '\u2192', y: '\u2191' };
</script>

<!-- Tooltip positioned via JS with flip detection -->
<div
	class="tooltip"
	class:visible
	bind:this={tooltipEl}
	style:left="{px}px"
	style:top="{py}px"
	style:translate="{flippedX ? 'calc(-100% - 12px)' : '12px'} {flippedY ? 'calc(-100% + 4px)' : '-4px'}"
	style:transform-origin="{originX} {originY}"
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
		position: absolute;
		background: var(--diveplot-tooltip-bg, rgba(0, 0, 0, 0.88));
		color: var(--diveplot-tooltip-text, #ffffff);
		padding: 6px 10px;
		border-radius: 4px;
		font-family: var(--diveplot-font, system-ui, sans-serif);
		font-size: 12px;
		line-height: 1.4;
		pointer-events: none;
		z-index: 1000;
		white-space: nowrap;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
		opacity: 0;
		scale: 0.78;
		transition:
			opacity 100ms ease-out,
			scale 200ms cubic-bezier(0.34, 1.3, 0.64, 1);
		will-change: opacity, scale;
	}

	.tooltip.visible {
		opacity: 1;
		scale: 1;
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
