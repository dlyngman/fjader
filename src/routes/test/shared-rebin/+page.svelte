<script>
	/**
	 * Two charts sharing x and y (the same labels: one scale each in the
	 * registry), each a stacked time histogram of the same events, the second
	 * group a only. Zooming either rebins both, on one shared y.
	 *
	 * What a rebin should do, in both charts at once: one y tween, the bars
	 * morphing on it, no dip. Before the gate went, a chart sharing y with
	 * another visible chart kept the spring, and its bars dipped while it ran.
	 *
	 * Scroll one chart out of view, zoom the other past a rebin, and scroll
	 * back: the returning chart's catch-up lands at once, axis and bars
	 * together (no half-height bars under a moving axis).
	 */
	import { count } from '@uwdata/mosaic-sql';
	import { onMount } from 'svelte';
	import { initFjader, stackY } from '$lib';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		WebGPUCanvas,
		RectYMark
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import { bin } from '$lib/sql/bin';

	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(() => {
		(async () => {
			try {
				// As /test/time-stack-fit: hourly-ish events over 2023–2024 and a
				// one-week burst in mid 2024. events_a: group a only.
				await queryEngine.exec(`
					CREATE TABLE events AS
					SELECT
						TIMESTAMP '2023-01-01' + to_seconds(CAST(floor(random() * 63072000) AS BIGINT)) AS ts,
						['a', 'b', 'c'][1 + CAST(floor(random() * 3) AS INTEGER)] AS grp
					FROM range(200000)
					UNION ALL
					SELECT
						TIMESTAMP '2024-06-10' + to_seconds(CAST(floor(random() * 604800) AS BIGINT)) AS ts,
						['a', 'b', 'c'][1 + CAST(floor(random() * 3) AS INTEGER)] AS grp
					FROM range(20000)
				`);
				await queryEngine.exec(`CREATE TABLE events_a AS SELECT * FROM events WHERE grp = 'a'`);
				isLoaded = true;
			} catch (error) {
				console.error('Initialization error:', error);
				loadError = error.message;
			}
		})();
	});
</script>

{#if loadError}
	<div class="status">Error: {loadError}</div>
{:else if !isLoaded}
	<div class="status">Generating data...</div>
{:else}
	<div class="container">
		<h1>Two charts sharing x and y, rebinning together</h1>
		<p class="lede">
			Zoom either chart's time axis (in the x margin) past a rebin: both charts tween y together and
			their bars morph, no dip. Then scroll one out of view, zoom the other, and scroll back: the
			returning chart lands at once.
		</p>
		{#each [{ table: 'events', title: 'All groups' }, { table: 'events_a', title: 'Group a' }] as chart (chart.table)}
			<h3>{chart.title}</h3>
			<div class="panel">
				<ChartContainer xLabel="ts" yLabel="events">
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
									table={chart.table}
									x={bin('ts')}
									y={count()}
									fill="grp"
									inset={0.5}
									transforms={[stackY()]}
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>
		{/each}
		<div class="spacer">Scroll space: bring one chart out of view, then back.</div>
	</div>
{/if}

<style>
	.container {
		max-width: 1000px;
		margin: 0 auto;
		padding: 16px;
	}
	.panel {
		height: 320px;
	}
	.lede {
		color: #555;
	}
	.status {
		padding: 16px;
	}
	.spacer {
		height: 120vh;
		color: #999;
		padding-top: 16px;
	}
</style>
