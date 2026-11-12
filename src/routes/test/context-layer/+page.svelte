<script>
	// selectionResponse="ignore": a context layer no selection filters or dims.
	//
	// What to check:
	// - Brush the delay histogram. In "Carrier" and "Distance", the front layer
	//   shrinks to the brushed flights over the faint whole, which stays put,
	//   and the y axes do not rescale (the whole sets their extent).
	// - Click a carrier bar or a legend entry: the front bars dim to the
	//   selection, the faint whole does not dim, and "Distance" filters its front
	//   layer while its whole stays.
	// - "Top 4, ranked over the whole": the back layer ranks, the front follows
	//   the axis (contributeDomain={false}). Brush delays: the same four
	//   carriers stay, in the same order, and their front bars shrink.
	// - "Top 4, re-ranked within the selection": the front ranks, the whole
	//   follows the axis. Brush delays: the four carriers can change, and the
	//   grey totals are those of whichever four are shown.
	// - "Top 4 + Other" is a single ignore layer: clicking its Other bar selects
	//   the other carriers everywhere else, a second click deselects them, and
	//   the bars themselves never change.

	import { count } from '@uwdata/mosaic-sql';
	import { initFjader, topN } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		WebGPUCanvas,
		BarMarkY,
		RectYMark,
		IntervalX,
		Legend
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import Toggle from '$lib/interactors/Toggle.svelte';
	import { bin } from '$lib/sql/bin';

	const CARRIERS = ['AA', 'DL', 'UA', 'WN', 'B6', 'AS', 'NK', 'F9', 'G4', 'HA'];

	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			const url = `${window.location.origin}/data/flights-200k.parquet`;
			const carriers = `['${CARRIERS.join("', '")}']`;
			// A skewed synthetic carrier, so the top 4 and Other are clear.
			await queryEngine.exec(`
				CREATE TABLE context_flights AS
				SELECT delay, distance,
				       ${carriers}[1 + floor(10 * pow((hash(rid) % 1000000) / 1e6, 2))::INT] AS carrier
				FROM (SELECT *, row_number() OVER () AS rid FROM read_parquet('${url}'))
			`);
			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

{#if loadError}
	<p class="status error">Error: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading…</p>
{:else}
	<div class="container">
		<h1>Context layer: selectionResponse="ignore"</h1>
		<p class="lede">
			The faint layers ignore every selection: brush the delays or click a carrier, and only the
			front layers respond. The axes keep the extent of the whole.
		</p>

		<div class="grid">
			<div class="panel">
				<h3>Delay (brush)</h3>
				<ChartContainer xLabel="delay" yLabel="flights by delay">
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
									table="context_flights"
									x={bin('delay', { steps: 50 })}
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

			<div class="panel">
				<h3>Carrier: whole (ignore) behind part</h3>
				<ChartContainer xLabel="carrier" yLabel="flights by carrier" legendPosition="top">
					{#snippet legend()}
						<Legend color="carrier" selection="brush" />
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
								<BarMarkY
									table="context_flights"
									x="carrier"
									y={count()}
									fill="#999"
									fillOpacity={0.25}
									selection="brush"
									selectionResponse="ignore"
								/>
								<BarMarkY
									table="context_flights"
									x="carrier"
									y={count()}
									fill="carrier"
									selection="brush"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet interactors()}
						<Toggle selection="brush" field="carrier" />
					{/snippet}
				</ChartContainer>
			</div>

			<div class="panel">
				<h3>Distance: whole (ignore) behind part</h3>
				<ChartContainer xLabel="distance" yLabel="flights by distance">
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
									table="context_flights"
									x={bin('distance', { steps: 40 })}
									y={count()}
									inset={0.5}
									fill="#999"
									fillOpacity={0.25}
									selection="brush"
									selectionResponse="ignore"
								/>
								<RectYMark
									table="context_flights"
									x={bin('distance', { steps: 40 })}
									y={count()}
									inset={0.5}
									fill="steelblue"
									selection="brush"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>

			<div class="panel">
				<h3>Top 4, ranked over the whole (front follows the axis)</h3>
				<ChartContainer xLabel="carrier, top 4 whole" yLabel="flights, top 4 whole">
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
								<BarMarkY
									table="context_flights"
									x="carrier"
									y={count()}
									fill="#999"
									fillOpacity={0.25}
									transforms={[topN(4)]}
									selection="brush"
									selectionResponse="ignore"
								/>
								<BarMarkY
									table="context_flights"
									x="carrier"
									y={count()}
									fill="carrier"
									contributeDomain={false}
									selection="brush"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>

			<div class="panel">
				<h3>Top 4, re-ranked within the selection (whole follows the axis)</h3>
				<ChartContainer xLabel="carrier, top 4 part" yLabel="flights, top 4 part">
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
								<BarMarkY
									table="context_flights"
									x="carrier"
									y={count()}
									fill="#999"
									fillOpacity={0.25}
									contributeDomain={false}
									selection="brush"
									selectionResponse="ignore"
								/>
								<BarMarkY
									table="context_flights"
									x="carrier"
									y={count()}
									fill="carrier"
									transforms={[topN(4)]}
									selection="brush"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>

			<div class="panel">
				<h3>Top 4 + Other (ignore only): click Other twice</h3>
				<ChartContainer xLabel="carrier, top 4" yLabel="flights, top 4">
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
								<BarMarkY
									table="context_flights"
									x="carrier"
									y={count()}
									fill="#888"
									transforms={[topN(4, { includeOthers: true })]}
									selection="brush"
									selectionResponse="ignore"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet interactors()}
						<Toggle selection="brush" field="carrier" />
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
		height: 380px;
		display: flex;
		flex-direction: column;
	}

	h3 {
		margin-bottom: 8px;
		font-size: 14px;
		color: #555;
	}
</style>
