<script>
	import { getContext } from 'svelte';

	let {
		x,
		y,
		width,
		height, // Screen coordinates
		orientation, // 'x' | 'y' | '2d'
		onMoveStart, // (event) => void
		onResizeStart, // (edge: string, event) => void
		dimUnselected = true
	} = $props();

	const chart = getContext('chart');

	// Normalize to ensure positive dimensions (avoid GC by using primitives)
	const nx = $derived(width < 0 ? x + width : x);
	const ny = $derived(height < 0 ? y + height : y);
	const nw = $derived(Math.abs(width));
	const nh = $derived(Math.abs(height));
</script>

<g class="brush-overlay">
	<!-- Dimmed unselected regions -->
	{#if dimUnselected}
		{#if orientation === 'x' || orientation === '2d'}
			<rect
				x={0}
				y={0}
				width={Math.max(0, nx)}
				height={chart.innerHeight}
				fill="rgba(0,0,0,0.05)"
				pointer-events="none"
			/>
			<rect
				x={Math.max(0, nx + nw)}
				y={0}
				width={Math.max(0, chart.innerWidth - nx - nw)}
				height={chart.innerHeight}
				fill="rgba(0,0,0,0.05)"
				pointer-events="none"
			/>
		{/if}
		{#if orientation === 'y' || orientation === '2d'}
			<rect
				x={0}
				y={0}
				width={chart.innerWidth}
				height={Math.max(0, ny)}
				fill="rgba(0,0,0,0.05)"
				pointer-events="none"
			/>
			<rect
				x={0}
				y={Math.max(0, ny + nh)}
				width={chart.innerWidth}
				height={Math.max(0, chart.innerHeight - ny - nh)}
				fill="rgba(0,0,0,0.05)"
				pointer-events="none"
			/>
		{/if}
	{/if}

	<!-- Selected region -->
	<rect
		class="brush-selection"
		x={nx}
		y={ny}
		width={nw}
		height={nh}
		fill="var(--brush-fill, rgba(100, 150, 255, 0.15))"
		stroke="var(--brush-stroke, rgba(100, 150, 255, 0.7))"
		stroke-width="1.5"
		onpointerdown={onMoveStart}
		style="cursor: move;"
	/>

	<!-- Resize handles (visible + invisible hit areas) -->
	{#if orientation === 'x' || orientation === '2d'}
		<!-- Left edge handle - visible part -->
		<rect
			class="handle-visual handle-left-visual"
			x={nx - 3}
			y={ny}
			width={6}
			height={nh}
			fill="rgba(100, 150, 255, 0.3)"
			stroke="rgba(100, 150, 255, 0.7)"
			stroke-width="1.5"
			pointer-events="none"
		/>
		<!-- Left edge handle - hit area (larger, invisible) -->
		<rect
			class="handle-hit handle-left-hit"
			x={nx - 10}
			y={ny}
			width={20}
			height={nh}
			fill="transparent"
			style="cursor: ew-resize;"
			onpointerdown={(e) => onResizeStart('left', e)}
		/>

		<!-- Right edge handle - visible part -->
		<rect
			class="handle-visual handle-right-visual"
			x={nx + nw - 3}
			y={ny}
			width={6}
			height={nh}
			fill="rgba(100, 150, 255, 0.3)"
			stroke="rgba(100, 150, 255, 0.7)"
			stroke-width="1.5"
			pointer-events="none"
		/>
		<!-- Right edge handle - hit area (larger, invisible) -->
		<rect
			class="handle-hit handle-right-hit"
			x={nx + nw - 10}
			y={ny}
			width={20}
			height={nh}
			fill="transparent"
			style="cursor: ew-resize;"
			onpointerdown={(e) => onResizeStart('right', e)}
		/>
	{/if}

	{#if orientation === 'y' || orientation === '2d'}
		<!-- Top edge handle - visible part -->
		<rect
			class="handle-visual handle-top-visual"
			x={nx}
			y={ny - 3}
			width={nw}
			height={6}
			fill="rgba(100, 150, 255, 0.3)"
			stroke="rgba(100, 150, 255, 0.7)"
			stroke-width="1.5"
			pointer-events="none"
		/>
		<!-- Top edge handle - hit area (larger, invisible) -->
		<rect
			class="handle-hit handle-top-hit"
			x={nx}
			y={ny - 10}
			width={nw}
			height={20}
			fill="transparent"
			style="cursor: ns-resize;"
			onpointerdown={(e) => onResizeStart('top', e)}
		/>

		<!-- Bottom edge handle - visible part -->
		<rect
			class="handle-visual handle-bottom-visual"
			x={nx}
			y={ny + nh - 3}
			width={nw}
			height={6}
			fill="rgba(100, 150, 255, 0.3)"
			stroke="rgba(100, 150, 255, 0.7)"
			stroke-width="1.5"
			pointer-events="none"
		/>
		<!-- Bottom edge handle - hit area (larger, invisible) -->
		<rect
			class="handle-hit handle-bottom-hit"
			x={nx}
			y={ny + nh - 10}
			width={nw}
			height={20}
			fill="transparent"
			style="cursor: ns-resize;"
			onpointerdown={(e) => onResizeStart('bottom', e)}
		/>
	{/if}

	{#if orientation === '2d'}
		<!-- Corner handles for 2D -->
		{#each ['nw', 'ne', 'sw', 'se'] as corner}
			<!-- Visible corner handle -->
			<circle
				class="handle-visual handle-corner-visual handle-{corner}-visual"
				cx={corner.includes('e') ? nx + nw : nx}
				cy={corner.includes('s') ? ny + nh : ny}
				r={4}
				fill="rgba(100, 150, 255, 0.5)"
				stroke="rgba(100, 150, 255, 0.9)"
				stroke-width="2"
				pointer-events="none"
			/>
			<!-- Invisible corner hit area (larger) -->
			<circle
				class="handle-hit handle-corner-hit handle-{corner}-hit"
				cx={corner.includes('e') ? nx + nw : nx}
				cy={corner.includes('s') ? ny + nh : ny}
				r={12}
				fill="transparent"
				style="cursor: {corner === 'nw' || corner === 'se' ? 'nwse' : 'nesw'}-resize;"
				onpointerdown={(e) => onResizeStart(corner, e)}
			/>
		{/each}
	{/if}
</g>

<style>
	.brush-selection {
		transition: fill 0.15s ease;
	}

	.brush-selection:hover {
		fill: var(--brush-fill-hover, rgba(100, 150, 255, 0.2));
	}

	/* Visual feedback on handle hover */
	.handle-hit:hover {
		/* Uncomment to visualize hit areas during development */
		/* fill: rgba(255, 0, 0, 0.1) !important; */
	}
</style>
