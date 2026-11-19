<script>
	/**
	 * Labels attached to bars (`<Labels>` as a mark's child), on the cases they
	 * must get right:
	 *
	 * 1. Vertical bars, topN, sorted: labels at the anchor chosen above; a sort
	 *    flip reorders bars and labels together. Carrier labels below the plot
	 *    toggle a selection that dims the bars of charts 2 and 3, and their
	 *    labels with them.
	 * 2. Horizontal bars, with a second label layer naming each bar's category
	 *    (`text="y"`: the band channel, read as names through its field).
	 * 3. Stacked bars: each segment's own value, centred.
	 * 4. Bars below zero: `end` outside the bar's end, which is below its base.
	 * 5. All 12 origins, labelled.
	 * 6. A distance histogram to brush: every chart filters and morphs, and the
	 *    labels travel with their bars.
	 * 7. Carriers, top 5 and Other: the Other bar is labelled with its total.
	 *    Clicking (in chart 1) a carrier that Other holds splits the Other bar
	 *    into its selected part and the rest; its label follows the bar.
	 *
	 * The controls switch every chart's anchor and fill. `inside-end` on short
	 * bars shows the flip: a label that does not fit goes outside.
	 */
	import { count, avg } from '@uwdata/mosaic-sql';
	import { initFjader, topN } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		WebGPUCanvas,
		BarMarkY,
		BarMarkX,
		RectYMark,
		IntervalX,
		Labels
	} from '$lib/components';
	import Toggle from '$lib/interactors/Toggle.svelte';
	import { bin } from '$lib/sql/bin';

	const { queryEngine } = initFjader();
	let ready = $state(false);
	let anchor = $state('end');
	let fill = $state('contrast');
	let order = $state('desc');

	const CARRIERS = ['AA', 'DL', 'UA', 'WN', 'B6', 'AS', 'NK', 'F9', 'G4', 'HA'];
	const AIRPORTS = [
		'ATL',
		'DFW',
		'DEN',
		'ORD',
		'LAX',
		'JFK',
		'LAS',
		'MCO',
		'MIA',
		'CLT',
		'SEA',
		'PHX'
	];

	onMount(async () => {
		const url = `${location.origin}/data/flights-200k.parquet`;
		const list = (xs) => `['${xs.join("', '")}']`;
		const h = (salt) => `((hash(rid, ${salt}) % 1000000) / 1e6)`;
		await queryEngine.exec(`
			CREATE TABLE lab AS
			SELECT delay, distance, "time",
				${list(CARRIERS)}[1 + floor(10 * pow(${h(1)}, 2))::INT] AS carrier,
				${list(AIRPORTS)}[1 + floor(12 * pow(${h(2)}, 1.5))::INT] AS origin,
				CASE WHEN distance < 500 THEN 'short' WHEN distance < 1000 THEN 'medium'
					ELSE 'long' END AS band,
				-- A measure that goes below zero: delay minus a carrier offset.
				delay - 12 AS net_delay
			FROM (SELECT f.*, row_number() OVER () AS rid FROM read_parquet('${url}') f)
		`);
		ready = true;
	});
</script>

<svelte:head><title>Labels</title></svelte:head>

<div class="page">
	<header>
		<strong>Labels</strong>
		<label
			>anchor
			<select bind:value={anchor}>
				<option>end</option>
				<option>inside-end</option>
				<option>center</option>
				<option>inside-start</option>
				<option>start</option>
			</select>
		</label>
		<label
			>fill
			<select bind:value={fill}>
				<option>contrast</option>
				<option>inherit</option>
				<option>#b45309</option>
			</select>
		</label>
		<button onclick={() => (order = order === 'desc' ? 'asc' : 'desc')}>sort {order}</button>
		<span class="hint">click carrier labels under chart 1 to select; brush chart 6</span>
	</header>

	{#if ready}
		<div class="grid">
			<section>
				<h3>1. Carriers (sorted, click labels)</h3>
				<ChartContainer xLabel="carrier #1" yLabel="count #1">
					{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<BarMarkY
									table="lab"
									x="carrier"
									y={count()}
									fill="steelblue"
									sort={{ x: 'y', order }}
									selection="brush"
								>
									<Labels {anchor} {fill} />
								</BarMarkY>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet interactors()}<Toggle selection="brush" field="carrier" />{/snippet}
				</ChartContainer>
			</section>

			<section>
				<h3>2. Top origins, horizontal, text from a column</h3>
				<ChartContainer xLabel="count #2" yLabel="origin #2">
					{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<BarMarkX
									table="lab"
									x={count()}
									y="origin"
									fill="seagreen"
									transforms={[topN(8)]}
									sort={{ y: 'x', order }}
									selection="brush"
								>
									<Labels {anchor} {fill} />
									<Labels text="y" anchor="inside-start" fill="contrast" fontWeight="600" />
								</BarMarkX>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</section>

			<section>
				<h3>3. Stacked by carrier: each segment's value</h3>
				<ChartContainer xLabel="band #3" yLabel="count #3">
					{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<BarMarkY table="lab" x="band" y={count()} fill="carrier" selection="brush">
									<Labels anchor="center" fill="contrast" fontSize={9} />
								</BarMarkY>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</section>

			<section>
				<h3>4. Mean net delay by carrier (below zero)</h3>
				<ChartContainer xLabel="carrier #4" yLabel="mean net delay #4">
					{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<BarMarkY
									table="lab"
									x="carrier"
									y={avg('net_delay')}
									fill="#7c3aed"
									selection="brush"
								>
									<Labels {anchor} {fill} format={(v) => Number(v).toFixed(1)} />
								</BarMarkY>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</section>

			<section>
				<h3>5. Flights by origin (all 12)</h3>
				<ChartContainer xLabel="origin #5" yLabel="count #5">
					{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<BarMarkY table="lab" x="origin" y={count()} fill="#0e7490" selection="brush">
									<Labels {anchor} {fill} fontSize={9} />
								</BarMarkY>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</section>

			<section>
				<h3>6. Distance (brush)</h3>
				<ChartContainer xLabel="distance #6" yLabel="count #6">
					{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<RectYMark
									fitDomain={false}
									table="lab"
									x={bin('distance')}
									y={count()}
									inset={0.5}
									fill="steelblue"
									selection="brush"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet interactors()}<IntervalX selection="brush" />{/snippet}
				</ChartContainer>
			</section>

			<section>
				<h3>7. Carriers, top 5 + Other (click carriers in chart 1)</h3>
				<ChartContainer xLabel="carrier #7" yLabel="count #7">
					{#snippet background()}<Frame /><AxisLeft /><AxisBottom />{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<BarMarkY
									table="lab"
									x="carrier"
									y={count()}
									fill="#b45309"
									transforms={[topN(5, { includeOthers: true })]}
									sort={{ x: 'y', order }}
									selection="brush"
								>
									<Labels {anchor} {fill} />
								</BarMarkY>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</section>
		</div>
	{/if}
</div>

<style>
	.page {
		padding: 12px 16px;
		font-family: system-ui, sans-serif;
	}
	header {
		display: flex;
		gap: 16px;
		align-items: center;
		font-size: 13px;
		margin-bottom: 8px;
	}
	.hint {
		color: #666;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
	}
	section {
		height: 340px;
		display: flex;
		flex-direction: column;
	}
	h3 {
		font-size: 12px;
		margin: 0 0 4px;
	}
	section > :global(*:last-child) {
		flex: 1;
		min-height: 0;
	}
</style>
