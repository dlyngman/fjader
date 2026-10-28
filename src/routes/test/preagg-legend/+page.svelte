<script>
	// Preagg for toggle and legend sources, in the browser, on enough rows for
	// the size guard to let the builds through.
	//
	// What to check:
	// - Hover the carrier legend, wait a moment, click a carrier: the two
	//   histograms' queries read preagg tables ("preagg read") instead of the
	//   base table, and are a few ms instead of tens.
	// - Hover the carrier bars and click a bar or a band label: the same for the
	//   other charts; the bars chart itself dims rather than filters.
	// - Brush the delay histogram right after a toggle click without leaving the
	//   chart: once the pointer is released and things are quiet, the brush
	//   table is rebuilt ("build"), and later drags read it.
	// - Drag the brush: no "build" appears in the log mid-drag.
	// - Parallel axes: hover an axis (its brush strip) and wait: builds for the
	//   other charts' marks, one batch per axis. Move to another axis: a new
	//   batch. Drag on the hovered axis: the histograms and the carrier bars
	//   read preagg tables. The parallel chart's own polyline queries are row
	//   level and always read the base table (a 5,000-row sample).
	// - Continuous legend (time): hover it, pause, then brush it: the histograms
	//   and the carrier bars read preagg tables binned over the legend's domain.
	//
	// The log wraps the engine's query and exec on this page only.

	import { count } from '@uwdata/mosaic-sql';
	import { initDivePlot } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		ParallelAxes,
		ParallelBrushes,
		ParallelCoordinatesMark,
		MarginLabel,
		WebGPUCanvas,
		BarMarkY,
		RectYMark,
		IntervalX,
		Legend,
		DotsMark
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import Toggle from '$lib/interactors/Toggle.svelte';
	import { bin } from '$lib/sql/bin';

	const ROWS = 1_000_000;
	const CARRIERS = ['AA', 'DL', 'UA', 'WN', 'B6', 'AS', 'NK', 'F9', 'G4', 'HA'];

	const { queryEngine } = initDivePlot();
	let isLoaded = $state(false);
	let loadError = $state(null);
	let log = $state([]);

	function record(kind, sql, ms) {
		log = [{ kind, ms, sql: sql.slice(0, 140) }, ...log].slice(0, 60);
	}

	// Mark queries carry the mark's id as callerId; tooltip lookups ('tooltip')
	// and domain fits ('<mark>:fitDomain') are left out. Builds are the preagg CREATEs.
	const isMarkQuery = (callerId) => !!callerId && callerId !== 'tooltip' && !callerId.includes(':');
	// A cache hit returns the same result object as the mark's previous query: a
	// mark the brush excludes re-queries every frame with unchanged SQL, and that
	// is logged as "cached", not as a base read. Each read names its mark.
	const lastResult = new Map();
	const query = queryEngine.query.bind(queryEngine);
	queryEngine.query = async (sql, opts) => {
		const t = performance.now();
		let result;
		try {
			result = await query(sql, opts);
			return result;
		} finally {
			const callerId = opts?.callerId;
			if (isMarkQuery(callerId)) {
				const text = String(sql);
				const cached = result !== undefined && lastResult.get(callerId) === result;
				if (result !== undefined) lastResult.set(callerId, result);
				const kind = cached
					? 'cached'
					: text.includes('__dplot_preagg_')
						? 'preagg read'
						: 'base read';
				record(kind, `[${callerId}] ${text}`, performance.now() - t);
			}
		}
	};
	const exec = queryEngine.exec.bind(queryEngine);
	queryEngine.exec = async (sql) => {
		const t = performance.now();
		try {
			return await exec(sql);
		} finally {
			const text = String(sql);
			if (text.startsWith('CREATE TABLE IF NOT EXISTS "__dplot_preagg_')) {
				record('build', text, performance.now() - t);
			}
		}
	};

	// Activations: a chart hover or a settle is one batch; each source in it is
	// logged with its dims, so a missing rebuild can be told apart from a missing
	// activation.
	const batch = queryEngine.batch.bind(queryEngine);
	queryEngine.batch = (activations) => {
		record(
			'activate',
			`batch (chart hover or settle) at ${(performance.now() / 1000).toFixed(2)} s`,
			0
		);
		return batch(activations);
	};
	const activate = queryEngine.activate.bind(queryEngine);
	queryEngine.activate = (group, source) => {
		const dims = source.dims
			.map((d) =>
				d.kind === 'bin'
					? `bin [${d.domain.map((v) => +v.toFixed(1)).join(', ')}] over ${d.pixelExtent}px`
					: `value ${d.field}`
			)
			.join('; ');
		record('activate', `${source.sourceId}: ${dims}`, 0);
		return activate(group, source);
	};

	onMount(async () => {
		try {
			const url = `${window.location.origin}/data/flights-200k.parquet`;
			const carriers = `['${CARRIERS.join("', '")}']`;
			await exec(`
				CREATE TABLE preagg_flights AS
				SELECT (delay + (rep % 11) - 5)::SMALLINT AS delay,
				       (distance + (rep % 13) * 3)::SMALLINT AS distance,
				       "time",
				       ${carriers}[1 + floor(10 * pow((hash(rid, rep) % 1000000) / 1e6, 2))::INT] AS carrier
				FROM (SELECT *, row_number() OVER () AS rid FROM read_parquet('${url}')) base,
				     range(${Math.ceil(ROWS / 200_000)}) r(rep)
				LIMIT ${ROWS}
			`);
			// The parallel chart draws one polyline per row: a sample keeps it light.
			// Its brushes filter delay, distance and time, the same columns as above.
			await exec(
				`CREATE TABLE preagg_flights_sample AS SELECT * FROM preagg_flights USING SAMPLE 5000 ROWS`
			);
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
	<p class="status">Loading {ROWS.toLocaleString()} rows…</p>
{:else}
	<div class="container">
		<h1>Preagg for legends and toggles</h1>
		<p class="lede">
			{ROWS.toLocaleString()} rows. Hover a source, pause, then click: the other charts should read preagg
			tables. Brush the delay histogram after a toggle click: once released and quiet, its table is rebuilt;
			no build should appear mid-drag. Hover a parallel axis, pause, then brush it: the other charts
			read preagg tables built for that axis.
		</p>

		<div class="grid">
			<div class="panel">
				<h3>Delay (brush)</h3>
				<ChartContainer xLabel="delay" yLabel="count">
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
									table="preagg_flights"
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
				<h3>Carrier (Toggle and legend)</h3>
				<ChartContainer xLabel="carrier" yLabel="count" legendPosition="top">
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
									table="preagg_flights"
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
				<h3>Parallel axes (brush; 5,000-row sample)</h3>
				<ChartContainer clipPadding={30}>
					{#snippet background()}
						<Frame />
						<ParallelAxes />
					{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<ParallelCoordinatesMark
									table="preagg_flights_sample"
									columns={['delay', 'distance', 'time']}
									stroke="carrier"
									opacity={0.2}
									selection="brush"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet interactors()}
						<ParallelBrushes selection="brush" />
					{/snippet}
				</ChartContainer>
			</div>

			<div class="panel">
				<h3>Time (continuous legend; 5,000-row sample)</h3>
				<ChartContainer xLabel="distance" yLabel="delay" legendPosition="top">
					{#snippet legend()}
						<Legend color="time" selection="brush" />
					{/snippet}
					{#snippet background()}
						<Frame />
						<AxisLeft />
						<AxisBottom />
					{/snippet}
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<DotsMark
									table="preagg_flights_sample"
									x="distance"
									y="delay"
									fill="time"
									selection="brush"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>

			<div class="panel">
				<h3>Distance (filtered)</h3>
				<ChartContainer xLabel="distance" yLabel="count">
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
									table="preagg_flights"
									x={bin('distance', { steps: 50 })}
									y={count()}
									inset={0.5}
									fill="seagreen"
									selection="brush"
								/>
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
				</ChartContainer>
			</div>
		</div>

		<h3>Query log (newest first)</h3>
		<table>
			<thead><tr><th>kind</th><th>ms</th><th>sql</th></tr></thead>
			<tbody>
				{#each log as entry, i (i)}
					<tr class={entry.kind.replace(' ', '-')}>
						<td>{entry.kind}</td>
						<td>{entry.ms.toFixed(1)}</td>
						<td class="sql">{entry.sql}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	.container {
		max-width: 1300px;
		margin: 0 auto;
		padding: 24px 16px;
	}
	.lede {
		color: #555;
		max-width: 80ch;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
		gap: 16px;
	}
	.panel {
		height: 320px;
	}
	table {
		border-collapse: collapse;
		font-variant-numeric: tabular-nums;
		width: 100%;
		margin-top: 8px;
	}
	td,
	th {
		border-bottom: 1px solid #eee;
		padding: 3px 8px;
		text-align: left;
	}
	.sql {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		color: #555;
	}
	.preagg-read td:first-child {
		color: #1b7f3b;
		font-weight: 600;
	}
	.base-read td:first-child {
		color: #b06000;
	}
	.cached td:first-child,
	.activate td:first-child {
		color: #777;
	}
	.build td:first-child {
		color: #3949ab;
		font-weight: 600;
	}
	.status.error {
		color: #b00020;
	}
</style>
