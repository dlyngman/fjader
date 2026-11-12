<script>
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		WebGPUCanvas,
		DotsMark
	} from '$lib/components';

	const { queryEngine } = initFjader();

	let isLoaded = $state(false);
	let loadError = $state(null);

	// The page's colour scheme, as an app's own toggle would set it: an attribute on
	// <html> that sets color-scheme. 'system' leaves the OS preference in charge.
	let scheme = $state('system');
	function setScheme(value) {
		scheme = value;
		if (value === 'system') delete document.documentElement.dataset.theme;
		else document.documentElement.dataset.theme = value;
	}
	onMount(() => () => delete document.documentElement.dataset.theme);

	onMount(async () => {
		try {
			// Long labels and several columns, so the tooltip is wider than the small charts.
			await queryEngine.exec(`
				CREATE TABLE tt_points AS
				SELECT
					i AS x,
					(i * 37) % 100 AS y,
					['North-western distribution centre', 'Southern regional warehouse',
					 'Central fulfilment hub'][1 + i % 3] AS site,
					round(i * 12.345, 2) AS revenue,
					i * 7 AS units
				FROM range(0, 100) t(i)
			`);
			isLoaded = true;
		} catch (error) {
			loadError = error.message;
		}
	});
</script>

{#snippet chart(tooltipScheme = undefined)}
	<div class="chart">
		<ChartContainer {tooltipScheme}>
			{#snippet background()}
				<Frame />
				<AxisLeft />
				<AxisBottom />
			{/snippet}
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<DotsMark table="tt_points" x="x" y="y" fill="site" />
					{/snippet}
				</WebGPUCanvas>
			{/snippet}
		</ChartContainer>
	</div>
{/snippet}

{#if loadError}
	<p class="status error">Error: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading...</p>
{:else}
	<div class="container">
		<h1>Tooltip clipping and colour scheme</h1>
		<p class="subtitle">
			Hover the dots near each chart's edges. The tooltip must show whole in every case, stay inside
			the browser window, and keep the theme colours. The chart pinned to the window's bottom-right
			corner checks the flip and clamp.
		</p>

		<div class="schemes" role="radiogroup" aria-label="Page colour scheme">
			Page scheme:
			{#each ['system', 'light', 'dark'] as value (value)}
				<label>
					<input
						type="radio"
						name="scheme"
						checked={scheme === value}
						onchange={() => setScheme(value)}
					/>
					{value}
				</label>
			{/each}
		</div>

		<h2>Tooltip scheme</h2>
		<div class="grid">
			<section>
				<h3>Default: contrast</h3>
				<div class="clip box">{@render chart()}</div>
			</section>

			<section>
				<h3>tooltipScheme="follow" on the chart</h3>
				<div class="clip box">{@render chart('follow')}</div>
			</section>

			<section data-fjader-tooltip="follow">
				<h3>data-fjader-tooltip="follow" on the panel, contrast chart inside</h3>
				<div class="clip box">{@render chart('contrast')}</div>
			</section>

			<section data-fjader-tooltip="follow">
				<h3>Follow panel, app colours win (--fjader-tooltip-bg)</h3>
				<div class="clip box themed">{@render chart()}</div>
			</section>

			<section class="dark-panel">
				<h3>Panel with color-scheme: dark, contrast</h3>
				<div class="clip box">{@render chart()}</div>
			</section>

			<section class="dark-panel">
				<h3>Panel with color-scheme: dark, follow</h3>
				<div class="clip box">{@render chart('follow')}</div>
			</section>
		</div>

		<h2>Clipping</h2>

		<div class="grid">
			<section>
				<h3>overflow: hidden, small</h3>
				<div class="clip small">{@render chart()}</div>
			</section>

			<section>
				<h3>Scroll area (scroll it, then hover)</h3>
				<div class="scroll">
					<div class="spacer">Scroll down</div>
					<div class="scroll-chart">{@render chart()}</div>
					<div class="spacer">End</div>
				</div>
			</section>

			<section>
				<h3>Transformed parent, overflow: hidden</h3>
				<div class="clip transformed">{@render chart()}</div>
			</section>
		</div>

		<!-- Pinned to the window's bottom-right corner: flipped and clamped into the viewport. -->
		<div class="clip corner">{@render chart()}</div>
	</div>
{/if}

<style>
	.container {
		max-width: 1400px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
	}

	h1 {
		font-size: 1.5rem;
		font-weight: 700;
		margin: 0 0 0.25rem 0;
	}

	:global(html[data-theme='light']) {
		color-scheme: light;
		--fjader-bg: var(--gray-0);
	}

	:global(html[data-theme='dark']) {
		color-scheme: dark;
		--fjader-bg: var(--gray-10);
	}

	h2 {
		font-size: 1.1rem;
		font-weight: 600;
		margin: 1.5rem 0 0.5rem 0;
	}

	.schemes {
		display: flex;
		gap: 1rem;
		align-items: center;
		color: light-dark(#444, #bbb);
	}

	.dark-panel {
		color-scheme: dark;
		background: #111827;
		padding: 0 0.75rem 0.75rem;
		border-radius: 6px;
	}

	.box {
		height: 180px;
	}

	h3 {
		font-size: 0.9rem;
		font-weight: 600;
		margin: 1rem 0 0.5rem 0;
		color: light-dark(#333, #ccc);
	}

	.subtitle {
		color: #888;
		margin: 0 0 1rem 0;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 1.5rem;
	}

	.chart {
		width: 100%;
		height: 100%;
		position: relative;
	}

	.clip {
		overflow: hidden;
		border: 1px dashed #555;
		border-radius: 6px;
	}

	.small {
		width: 220px;
		height: 160px;
	}

	.scroll {
		height: 200px;
		overflow: auto;
		border: 1px dashed #555;
		border-radius: 6px;
	}

	.scroll-chart {
		height: 180px;
	}

	.spacer {
		height: 150px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #666;
	}

	.transformed {
		height: 180px;
		transform: translateZ(0) scale(0.95);
	}

	.themed {
		height: 180px;
		--fjader-tooltip-bg: #1d4ed8;
		--fjader-tooltip-text: #fef3c7;
	}

	.corner {
		position: fixed;
		right: 0;
		bottom: 0;
		width: 200px;
		height: 150px;
		background: var(--fjader-bg);
	}

	.status {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
		font-size: 1rem;
		color: #666;
		margin: 0;
	}

	.error {
		color: red;
	}
</style>
