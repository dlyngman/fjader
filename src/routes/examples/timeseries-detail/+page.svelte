<script lang="ts">
	/**
	 * The time series explorer of python/streamlit_timeseries.py, rendered from
	 * its spec through Fjader.render() as the Python widget does, on the same
	 * synthetic hourly energy data (2 years × 3 groups) generated in DuckDB.
	 * - Overview + detail: panning the detail moves the overview's brush.
	 * - Comparison: a derived interval shifts the brush a year back into a second
	 *   selection, and relays the day-of-week toggle's clause to it.
	 */
	import { onMount } from 'svelte';
	import { render, type FjaderHandle, type FjaderSpec } from '$lib/spec';
	import { getOrCreateQueryEngine } from '$lib/spec/LazyQueryEngine';

	const ENERGY_SQL = `
CREATE OR REPLACE TABLE energy AS
WITH h AS (
	SELECT ts, row_number() OVER (ORDER BY ts) - 1 AS idx
	FROM generate_series(TIMESTAMP '2023-01-01', TIMESTAMP '2024-12-31 23:00:00', INTERVAL 1 HOUR) t(ts)
),
n AS (SELECT count(*) AS n FROM h),
g AS (SELECT * FROM (VALUES ('Residential', 1.0), ('Commercial', 1.4), ('Industrial', 0.7)) v("group", mult)),
b AS (
	SELECT h.ts, g."group",
		200.0
		* (0.05 + 0.95 * pow(greatest(0, cos((hour(h.ts) - 13) * pi() / 12)), 2))
		* [1.0, 1.1, 1.15, 1.2, 1.05, 0.5, 0.4][isodow(h.ts)]
		* (1.0 + 0.3 * sin((dayofyear(h.ts) - 80) * 2 * pi() / 365))
		* (1.0 + 0.4 * h.idx / n.n)
		* g.mult AS base
	FROM h, n, g
)
SELECT ts, "group",
	hour(ts)::INTEGER AS hour,
	['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][isodow(ts)] AS day_of_week,
	(isodow(ts) - 1)::INTEGER AS dow_num,
	greatest(1.0, base * (0.85 + 0.3 * random()) * CASE WHEN random() < 0.02 THEN 1.5 + random() ELSE 1 END) AS value
FROM b`;

	const rawLine = {
		mark: 'line',
		table: 'energy',
		selection: 'daysel',
		tooltipProximity: 'x',
		fitDomain: 'y',
		x: 'ts',
		y: 'value',
		stroke: 'group',
		lod: { decimate: true },
		preferredXScaleType: 'time'
	};
	const windowLine = {
		...rawLine,
		y: { window: 'avg', field: 'value', orderBy: 'ts', partitionBy: 'group', frame: [-168, 0] },
		strokeWidth: 2
	};
	const overview = (comparison: boolean) => ({
		marks: [rawLine],
		height: 90,
		xLabel: 'Date',
		interactors: [
			{ interactor: 'intervalX', selection: 'daysel' },
			...(comparison
				? [{ interactor: 'derivedInterval', source: 'daysel', selection: 'cmpsel', offset: '-1yw' }]
				: [])
		],
		yDisableZoom: true
	});
	const hourly = (selection: string) => ({
		marks: [
			{
				mark: 'areaY',
				table: 'energy',
				selection,
				tip: false,
				x: 'hour',
				y1: { aggregate: 'min', field: 'value' },
				y2: { aggregate: 'max', field: 'value' },
				fill: 'group',
				fillOpacity: 0.2,
				curve: 'monotone'
			},
			{
				mark: 'line',
				table: 'energy',
				selection,
				tooltipProximity: 'x',
				tip: [
					'x',
					'stroke',
					'y',
					{ value: { aggregate: 'min', field: 'value' }, label: 'Min' },
					{ value: { aggregate: 'max', field: 'value' }, label: 'Max' }
				],
				x: 'hour',
				y: { aggregate: 'avg', field: 'value' },
				stroke: 'group',
				strokeWidth: 2,
				curve: 'monotone'
			}
		],
		height: 340,
		xLabel: 'Hour of Day',
		yLabel: 'kWh',
		legend: true
	});
	const daySelector = {
		marks: [
			{
				mark: 'barY',
				table: 'energy',
				selection: 'daysel',
				transforms: [{ transform: 'stackY' }],
				sort: { x: 'dow_num', order: 'asc' },
				fitDomain: 'y',
				x: 'day_of_week',
				y: { aggregate: 'sum', field: 'value' },
				fill: 'group'
			}
		],
		height: 340,
		xLabel: 'Day of Week',
		yLabel: 'Total kWh',
		legend: true,
		interactors: [{ interactor: 'toggle', field: 'day_of_week' }]
	};
	const detail = (marks: object[]) => ({
		marks,
		height: 380,
		xLabel: 'Date',
		yLabel: 'Energy (kWh)',
		legend: true,
		useXSelection: true,
		useYSelection: false
	});

	const VARIANTS: Record<string, { label: string; spec: object }> = {
		full: {
			label: 'Overview + detail',
			spec: { vconcat: [detail([rawLine, windowLine]), overview(false)] }
		},
		comparison: {
			label: 'Comparison: derived interval + day toggle',
			spec: {
				vconcat: [
					detail([rawLine, windowLine]),
					overview(true),
					{ hconcat: [hourly('daysel'), hourly('cmpsel'), daySelector] }
				]
			}
		}
	};

	let target: HTMLDivElement;
	let handle: FjaderHandle | null = null;
	let variant = $state('full');
	let status = $state('Generating data…');

	async function show(key: string) {
		variant = key;
		handle?.destroy();
		handle = null;
		target.replaceChildren();
		status = 'Rendering…';
		handle = await render(target, VARIANTS[key].spec as FjaderSpec);
		status = '';
	}

	onMount(() => {
		(async () => {
			const engine = await getOrCreateQueryEngine();
			await engine.exec(ENERGY_SQL);
			await show('full');
		})().catch((error) => {
			console.error(error);
			status = `Failed: ${error.message}`;
		});
		return () => handle?.destroy();
	});
</script>

<div class="page">
	<h1>Time series: overview + detail</h1>
	<p>
		Brush the overview, then pan the detail. In the comparison, toggle days in the bar chart too.
		The Python example's spec, rendered with <code>Fjader.render()</code>.
	</p>
	<div class="variants">
		{#each Object.entries(VARIANTS) as [key, v] (key)}
			<button class:active={variant === key} onclick={() => show(key)}>{v.label}</button>
		{/each}
	</div>
	{#if status}<p class="status">{status}</p>{/if}
	<div class="chart" bind:this={target}></div>
</div>

<style>
	.page {
		padding: 1rem 1.5rem;
	}
	.variants {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 1rem;
	}
	button {
		padding: 0.35rem 0.75rem;
		border: 1px solid #999;
		border-radius: 4px;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	button.active {
		background: #333;
		color: #fff;
	}
	.chart {
		width: 100%;
	}
</style>
