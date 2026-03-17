<script lang="ts">
	interface Props {
		x: number;
		y: number;
		width: number;
		height: number;
		label?: string;
	}

	let { x, y, width, height, label }: Props = $props();

	// Normalize to ensure positive dimensions
	const nx = $derived(width < 0 ? x + width : x);
	const ny = $derived(height < 0 ? y + height : y);
	const nw = $derived(Math.abs(width));
	const nh = $derived(Math.abs(height));
</script>

<g class="ghost-brush" style="pointer-events: none;">
	<rect
		x={nx}
		y={ny}
		width={nw}
		height={nh}
		fill="rgba(100, 149, 237, 0.08)"
		stroke="rgba(100, 149, 237, 0.5)"
		stroke-width="1"
		stroke-dasharray="4 2"
	/>
	{#if label}
		<text
			x={nx + 4}
			y={ny + 12}
			font-size="10"
			fill="rgba(100, 149, 237, 0.7)"
			font-family="system-ui, sans-serif"
		>
			{label}
		</text>
	{/if}
</g>
