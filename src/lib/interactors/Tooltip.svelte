<!--
  Tooltip.svelte - Display component for data tooltips.

  Reads from TooltipManager (via context) and renders a floating tooltip
  at the cursor position. Uses CSS anchor positioning for automatic
  edge-aware placement.
-->
<script>
	import { getContext } from 'svelte';

	const chart = getContext('chart');

	let { fields = null, formatters = {} } = $props();

	let tm = $derived(chart?.tooltipManager);
	let visible = $derived(tm?.visible ?? false);
	let data = $derived(tm?.currentPoint ?? null);
	let colorField = $derived(tm?.currentColorField ?? null);
	let color = $derived(tm?.currentColor ?? null);
	let channelFields = $derived(tm?.currentChannelFields ?? null);
	let px = $derived(tm?.pointerScreenX ?? 0);
	let py = $derived(tm?.pointerScreenY ?? 0);

	// Reverse lookup: field name → channel ('x', 'y')
	// Process color first so x/y overwrite (swatch already indicates color)
	let fieldToChannel = $derived.by(() => {
		if (!channelFields) return {};
		const map = {};
		if (channelFields.color) map[channelFields.color] = 'color';
		if (channelFields.x) map[channelFields.x] = 'x';
		if (channelFields.y) map[channelFields.y] = 'y';
		return map;
	});

	// Resolve channel for a tooltip entry key — checks reverse map first,
	// then falls back to pattern match for raw aliases (x1, x2, y1, y2)
	function getChannel(key) {
		return fieldToChannel[key] ?? (/^x\d?$/.test(key) ? 'x' : /^y\d?$/.test(key) ? 'y' : null);
	}

	let entries = $derived.by(() => {
		if (!data) return [];

		if (fields) {
			return fields.filter((key) => key in data).map((key) => [key, data[key]]);
		}

		return Object.entries(data);
	});

	function formatValue(key, value) {
		if (formatters[key]) return formatters[key](value);
		if (typeof value === 'number') {
			return Number.isInteger(value) ? value.toString() : value.toFixed(2);
		}
		return String(value);
	}

	const channelIcons = { x: '\u2192', y: '\u2191' };
</script>

<!-- Invisible anchor point tracking the cursor -->
<div class="tooltip-anchor" style="transform: translate({px}px, {py}px);"></div>

<!-- Tooltip positioned via CSS anchor positioning -->
<div class="tooltip" class:visible>
	{#each entries as [key, value] (key)}
		<div class="row">
			<span class="key">
				<span class="channel-icon">{channelIcons[getChannel(key)] ?? ''}</span>
				{key}
			</span>
			<span class="value">
				{#if key === colorField && color}
					<span class="swatch" style="background-color: {color};"></span>
				{/if}
				{formatValue(key, value)}
			</span>
		</div>
	{/each}
</div>

<style>
	.tooltip-anchor {
		position: absolute;
		top: 0;
		left: 0;
		width: 0;
		height: 0;
		anchor-name: --tooltip-anchor;
		pointer-events: none;
	}

	.tooltip {
		position: absolute;
		position-anchor: --tooltip-anchor;
		left: anchor(right);
		bottom: anchor(top);
		margin-left: 12px;
		margin-bottom: -4px;
		position-try-fallbacks:
			flip-inline,
			flip-block,
			flip-inline flip-block;
		background: rgba(0, 0, 0, 0.88);
		color: white;
		padding: 6px 10px;
		border-radius: 4px;
		font-size: 12px;
		line-height: 1.4;
		pointer-events: none;
		z-index: 1000;
		white-space: nowrap;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
		opacity: 0;
		transition: opacity 80ms ease-out;
		will-change: opacity;
	}

	.tooltip.visible {
		opacity: 1;
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
</style>
