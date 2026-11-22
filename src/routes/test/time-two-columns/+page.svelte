<script>
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Grid,
		DotsMark,
		RectYMark,
		AxisLeft,
		AxisBottom,
		Crosshair,
		MarginLabel
	} from '$lib/components';

	// Each task starts and ends on known dates: every bar's ends, and every dot,
	// can be read off the table below the charts.
	const TASKS = [
		['design', '2024-03-01', '2024-03-08'],
		['build', '2024-03-06', '2024-03-27'],
		['review', '2024-03-20', '2024-03-24'],
		['test', '2024-03-25', '2024-04-10'],
		['docs', '2024-04-01', '2024-04-03'],
		['release', '2024-04-12', '2024-04-15']
	];

	const { queryEngine } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	onMount(async () => {
		try {
			const rows = TASKS.map(
				([task, started, ended]) => `('${task}', TIMESTAMP '${started}', TIMESTAMP '${ended}')`
			).join(', ');
			await queryEngine.exec(
				`CREATE TABLE tasks AS SELECT *, CAST(date_diff('day', started, ended) AS INTEGER) AS days` +
					` FROM (VALUES ${rows}) AS t(task, started, ended)`
			);
			isLoaded = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});

	const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
</script>

<div class="page">
	<h2>Two time columns on one axis</h2>
	<p>
		Each channel on a time axis draws its own column, offset from the axis's shared origin. Before
		the fix every column-name channel read the column the axis was keyed by.
	</p>

	{#if loadError}
		<p class="error">Error: {loadError}</p>
	{:else if !isLoaded}
		<p>Loading…</p>
	{:else}
		<h3>1. A range: x1 = started, x2 = ended</h3>
		<p>
			One column per task from its start to its end, as tall as its length in days, on an axis of
			its own (xScale false) that reaches the last end, 2024-04-15. Broken: no columns (each has
			zero width), or an axis that stops at the last start, 2024-04-12.
		</p>
		<div class="chart">
			<ChartContainer xScale={false}>
				<AxisLeft />
				<AxisBottom />
				<Grid axis="x" />
				<RectYMark
					table="tasks"
					x1="started"
					x2="ended"
					y1={0}
					y2="days"
					fill="task"
					opacity={0.7}
				/>
				<Crosshair />
				<MarginLabel />
			</ChartContainer>
		</div>

		<h3>2. Two marks on two columns: dots at started (grey) and ended (orange)</h3>
		<p>
			Each row has two dots, the bar's length apart. Broken: the orange dots sit on the grey ones.
		</p>
		<div class="chart">
			<ChartContainer>
				<AxisLeft />
				<AxisBottom />
				<Grid axis="x" />
				<DotsMark table="tasks" x="started" y="task" fill="grey" r={6} />
				<DotsMark table="tasks" x="ended" y="task" fill="darkorange" r={6} />
				<Crosshair />
				<MarginLabel />
			</ChartContainer>
		</div>

		<table>
			<thead><tr><th>task</th><th>started</th><th>ended</th><th>days</th></tr></thead>
			<tbody>
				{#each TASKS as [task, started, ended] (task)}
					<tr><td>{task}</td><td>{started}</td><td>{ended}</td><td>{days(started, ended)}</td></tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	.page {
		max-width: 1000px;
		margin: 0 auto;
		padding: 20px;
	}

	.chart {
		height: 280px;
		margin-bottom: 24px;
	}

	.error {
		color: #c33;
	}

	table {
		border-collapse: collapse;
		font-size: 13px;
	}

	th,
	td {
		padding: 2px 12px;
		text-align: left;
	}
</style>
