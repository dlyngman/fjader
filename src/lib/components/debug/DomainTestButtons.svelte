<!-- src/lib/components/debug/DomainTestButtons.svelte -->
<script>
	import { getContext } from 'svelte';

	let { offsetPercent = 10 } = $props();

	const chartContext = getContext('chart');

	function offsetDomain(axis, percent) {
		const scaleState = axis === 'x' ? chartContext.xScaleState : chartContext.yScaleState;
		if (!scaleState) return;

		const [min, max] = scaleState.domain.current;
		const range = max - min;
		const offset = range * (percent / 100);

		// Set new target (triggers spring animation)
		scaleState.domain.set([min + offset, max + offset]);
	}

	function offsetBoth(percent) {
		offsetDomain('x', percent);
		offsetDomain('y', percent);
	}

	function resetZoom() {
		chartContext.xScaleState?.resetZoom();
		chartContext.yScaleState?.resetZoom();
	}
</script>

<div class="domain-test-buttons">
	<div class="button-row">
		<button onclick={() => offsetDomain('x', -offsetPercent)}>← X</button>
		<button onclick={() => offsetDomain('x', offsetPercent)}>X →</button>
	</div>

	<div class="button-row">
		<button onclick={() => offsetDomain('y', offsetPercent)}>↑ Y</button>
		<button onclick={() => offsetDomain('y', -offsetPercent)}>Y ↓</button>
	</div>

	<div class="button-row">
		<button onclick={() => offsetBoth(-offsetPercent)}>↖ Both</button>
		<button onclick={() => offsetBoth(offsetPercent)}>Both ↘</button>
	</div>

	<div class="button-row">
		<button onclick={resetZoom}>Reset</button>
	</div>

	<div class="info">
		<small>Offset: {offsetPercent}%</small>
		<input type="range" min="1" max="50" bind:value={offsetPercent} />
	</div>
</div>

<style>
	.domain-test-buttons {
		position: absolute;
		top: 10px;
		right: 10px;
		background: rgba(0, 0, 0, 0.8);
		padding: 10px;
		border-radius: 6px;
		z-index: 100;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.button-row {
		display: flex;
		gap: 4px;
	}

	button {
		padding: 6px 12px;
		font-size: 12px;
		cursor: pointer;
		background: #333;
		color: white;
		border: 1px solid #555;
		border-radius: 4px;
	}

	button:hover {
		background: #444;
	}

	button:active {
		background: #555;
	}

	.info {
		display: flex;
		flex-direction: column;
		gap: 4px;
		color: #aaa;
		margin-top: 4px;
	}

	input[type='range'] {
		width: 100%;
	}
</style>
