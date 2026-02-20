<script lang="ts">
	interface Props {
		x: number;
		y: number;
		width: number;
		height: number;
		orientation: 'x' | 'y' | '2d';
		onMoveStart: (event: PointerEvent) => void;
		onResizeStart: (edge: string, event: PointerEvent) => void;
		onWheel: (event: WheelEvent) => void;
	}

	let { x, y, width, height, orientation, onMoveStart, onResizeStart, onWheel }: Props = $props();

	// Normalize to ensure positive dimensions (avoid GC by using primitives)
	const nx = $derived(width < 0 ? x + width : x);
	const ny = $derived(height < 0 ? y + height : y);
	const nw = $derived(Math.abs(width));
	const nh = $derived(Math.abs(height));
</script>

<g class="brush-overlay" onwheel={onWheel}>
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
		onpointerdown={onMoveStart}
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
			onpointerdown={(e) => onResizeStart('left', e)}
		/>
		<!-- Right edge -->
		<rect
			x={nx + nw - 5}
			y={ny}
			width={10}
			height={nh}
			fill="transparent"
			style="cursor: ew-resize;"
			onpointerdown={(e) => onResizeStart('right', e)}
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
			onpointerdown={(e) => onResizeStart('top', e)}
		/>
		<!-- Bottom edge -->
		<rect
			x={nx}
			y={ny + nh - 5}
			width={nw}
			height={10}
			fill="transparent"
			style="cursor: ns-resize;"
			onpointerdown={(e) => onResizeStart('bottom', e)}
		/>
	{/if}

	{#if orientation === '2d'}
		<!-- Corner handles -->
		{#each ['nw', 'ne', 'sw', 'se'] as corner}
			<circle
				cx={corner.includes('e') ? nx + nw : nx}
				cy={corner.includes('s') ? ny + nh : ny}
				r={8}
				fill="transparent"
				style="cursor: {corner === 'nw' || corner === 'se' ? 'nwse' : 'nesw'}-resize;"
				onpointerdown={(e) => onResizeStart(corner, e)}
			/>
		{/each}
	{/if}
</g>

<style>
	.brush-selection:hover {
		fill: rgba(128, 128, 128, 0.15);
	}
</style>
