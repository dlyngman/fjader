<script>
	import * as msql from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		LineMark,
		Legend
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import Toggle from '$lib/interactors/Toggle.svelte';

	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			await queryEngine.exec(
				msql
					.loadCSV('unemployment', `${window.location.origin}/data/bls-industry-unemployment.csv`)
					.toString()
			);
			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

{#if loadError}
	<p class="status error">Error loading data: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading...</p>
{:else}
	<div class="container">
		<h1>Multi-line: one line per group</h1>
		<p>BLS unemployment by industry, 2000–2010 (14 industries).</p>

		<div class="charts">
			<div class="chart-wrapper">
				<h3>stroke="industry" (group + color), click a line or the legend</h3>
				<ChartContainer legendPosition="top">
					{#snippet legend()}
						<Legend color="industry" />
					{/snippet}
					{#snippet background()}
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<MarginLabel />
					{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<LineMark
									table="unemployment"
									x="date"
									y="unemployed"
									stroke="industry"
									strokeWidth={1.5}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet foreground()}
						<Crosshair />
					{/snippet}
					{#snippet interactors()}
						<Toggle field="industry" />
					{/snippet}
				</ChartContainer>
			</div>

			<div class="chart-wrapper">
				<h3>z="industry" (group only, constant color)</h3>
				<!-- Selections do not dim lines grouped by z alone yet: dimming reads the
				     stroke colour, which is constant here. -->
				<p class="note">No click-to-dim yet: lines dim by stroke colour, not by z.</p>
				<ChartContainer>
					{#snippet background()}
						<Frame />
						<AxisLeft />
						<AxisBottom />
						<MarginLabel />
					{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<LineMark
									table="unemployment"
									x="date"
									y="unemployed"
									z="industry"
									stroke="#4269d0"
									strokeWidth={1}
									opacity={0.7}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet foreground()}
						<Crosshair />
					{/snippet}
				</ChartContainer>
			</div>
		</div>
	</div>
{/if}

<style>
	.container {
		padding: 20px;
	}

	.status {
		padding: 2rem;
	}

	.error {
		color: #c00;
	}

	.charts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(480px, 1fr));
		gap: 24px;
	}

	.chart-wrapper {
		width: 100%;
		height: 460px;
		display: flex;
		flex-direction: column;
	}

	.note {
		margin: 0 0 8px;
		font-size: 12px;
		color: #888;
	}

	h3 {
		margin-bottom: 8px;
		font-size: 14px;
		color: #555;
	}
</style>
