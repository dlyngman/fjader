<!--
  Tooltip.svelte - Display component for data tooltips.

  Reads from TooltipManager (via context) and renders a floating tooltip
  at the cursor position. Shows mapped channels by default, customizable
  via the `fields` prop.
-->
<script>
	import { getContext } from 'svelte';

	const chart = getContext('chart');

	let {
		fields = null,
		formatters = {},
		offset = { x: 12, y: -12 }
	} = $props();

	let tm = $derived(chart?.tooltipManager);
	let visible = $derived(tm?.visible ?? false);
	let data = $derived(tm?.currentPoint ?? null);
	let x = $derived((tm?.pointerScreenX ?? 0) + offset.x);
	let y = $derived((tm?.pointerScreenY ?? 0) + offset.y);

	let entries = $derived.by(() => {
		if (!data) return [];

		if (fields) {
			return fields
				.filter((key) => key in data)
				.map((key) => [key, data[key]]);
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
</script>

{#if visible && entries.length > 0}
	<div class="tooltip" style="left: {x}px; top: {y}px;">
		{#each entries as [key, value]}
			<div class="row">
				<span class="key">{key}</span>
				<span class="value">{formatValue(key, value)}</span>
			</div>
		{/each}
	</div>
{/if}

<style>
	.tooltip {
		position: absolute;
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
	}

	.row {
		display: flex;
		gap: 8px;
		justify-content: space-between;
	}

	.key {
		opacity: 0.6;
	}

	.value {
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}
</style>
