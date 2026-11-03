<script lang="ts">
	interface Props {
		x: number;
		y: number;
		width: number;
		height: number;
		orientation: 'x' | 'y' | '2d';
		onWheel: (event: WheelEvent) => void;
		/** Which brush this is, when a chart has several (a parallel axis's column). */
		owner?: string;
	}

	/*
	 * The overlay only draws the brush and labels its parts with
	 * data-brush-handle. Presses bubble to the chart, which hands them to the
	 * brush's handlePointerDown; it reads the label (brushHandleAt) to move,
	 * resize or draw. Routing lives there alone, so the chart can route a press
	 * again mid-drag, at the element under the pointer then (reroutePress).
	 */
	let { x, y, width, height, orientation, onWheel, owner }: Props = $props();

	// Normalize to ensure positive dimensions (avoid GC by using primitives)
	const nx = $derived(width < 0 ? x + width : x);
	const ny = $derived(height < 0 ? y + height : y);
	const nw = $derived(Math.abs(width));
	const nh = $derived(Math.abs(height));
</script>

<g class="brush-overlay" data-brush-owner={owner} onwheel={onWheel}>
	<!-- Selection box - minimal style like D3 defaults -->
	<rect
		class="brush-selection"
		x={nx}
		y={ny}
		width={nw}
		height={nh}
		fill="rgba(128, 128, 128, 0.1)"
		stroke="rgba(96, 96, 96, 0.8)"
		stroke-width="1"
		data-brush-handle="move"
		style="cursor: move;"
	/>

	<!-- Invisible resize handles - no visual, just hit areas for interaction -->
	{#if orientation === 'x' || orientation === '2d'}
		<!-- Left edge -->
		<rect
			x={nx - 5}
			y={ny}
			width={10}
			height={nh}
			fill="transparent"
			style="cursor: ew-resize;"
			data-brush-handle="left"
		/>
		<!-- Right edge -->
		<rect
			x={nx + nw - 5}
			y={ny}
			width={10}
			height={nh}
			fill="transparent"
			style="cursor: ew-resize;"
			data-brush-handle="right"
		/>
	{/if}

	{#if orientation === 'y' || orientation === '2d'}
		<!-- Top edge -->
		<rect
			x={nx}
			y={ny - 5}
			width={nw}
			height={10}
			fill="transparent"
			style="cursor: ns-resize;"
			data-brush-handle="top"
		/>
		<!-- Bottom edge -->
		<rect
			x={nx}
			y={ny + nh - 5}
			width={nw}
			height={10}
			fill="transparent"
			style="cursor: ns-resize;"
			data-brush-handle="bottom"
		/>
	{/if}

	{#if orientation === '2d'}
		<!-- Corner handles -->
		{#each ['nw', 'ne', 'sw', 'se'] as corner (corner)}
			<circle
				cx={corner.includes('e') ? nx + nw : nx}
				cy={corner.includes('s') ? ny + nh : ny}
				r={8}
				fill="transparent"
				style="cursor: {corner === 'nw' || corner === 'se' ? 'nwse' : 'nesw'}-resize;"
				data-brush-handle={corner}
			/>
		{/each}
	{/if}
</g>

<style>
	.brush-selection:hover {
		fill: rgba(128, 128, 128, 0.15);
	}
</style>
