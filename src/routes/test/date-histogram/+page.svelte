<script>
	// Histograms morphing across filter changes, numeric and by date.
	//
	// Every bin() is automatic: it picks its unit and step from the visible
	// range, so zooming re-buckets it (months to weeks to days for the date),
	// and shift-scroll makes the bins finer or coarser.
	//
	// What to check:
	// - Brush max temperature: the date histogram morphs to the brushed days
	//   instead of snapping; buckets with none shrink to zero.
	// - Brush the date histogram: max temperature and precipitation morph.
	// - Zoom, or shift-scroll, until a chart re-buckets: it snaps, then morphs
	//   again on the next brush.
	// - The console shows no "[dense]" note and no parser error.

	import { count, loadParquet } from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		WebGPUCanvas,
		RectYMark,
		IntervalX
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import { bin } from '$lib/sql/bin';

	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			await queryEngine.exec(
				loadParquet('weather', `${window.location.origin}/data/seattle-weather.parquet`).toString()
			);
			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});

	const charts = [
		{ title: 'Date', x: bin('date'), label: 'date' },
		{ title: 'Max temperature', x: bin('temp_max'), label: 'temp_max' },
		{ title: 'Precipitation', x: bin('precipitation'), label: 'precipitation' }
	];
</script>

{#if loadError}
	<p class="status error">Error: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading…</p>
{:else}
	<div class="container">
		<h1>Histograms morph across filter changes</h1>
		<p class="lede">
			Seattle weather, 2012–2015. Brush a histogram: the others morph to the brushed days, by date
			and by value. Zoom or shift-scroll to re-bucket.
		</p>

		<div class="grid">
			{#each charts as chart (chart.label)}
				<div class="panel">
					<h3>{chart.title}</h3>
					<ChartContainer xLabel={chart.label} yLabel="days, {chart.label}">
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
									<RectYMark
										table="weather"
										x={chart.x}
										y={count()}
										inset={0.5}
										fill="steelblue"
										selection="brush"
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
						{#snippet interactors()}
							<IntervalX selection="brush" />
						{/snippet}
					</ChartContainer>
				</div>
			{/each}
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

	.lede {
		max-width: 70ch;
		color: #555;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(460px, 1fr));
		gap: 24px;
	}

	.panel {
		height: 340px;
		display: flex;
		flex-direction: column;
	}

	h3 {
		margin-bottom: 8px;
		font-size: 14px;
		color: #555;
	}
</style>
