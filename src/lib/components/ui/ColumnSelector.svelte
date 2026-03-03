<script lang="ts">
	import { getContext } from 'svelte';
	import GridSizeSelector from './GridSizeSelector.svelte';

	let c = getContext<{
		gridRows: number;
		gridColumns: number;
		chartConfig: { id: string; table: string; x: string; y: string }[];
	}>('chartConfig');

	// let gridRows = $state(2);
	// let gridColumns = $state(2);

	// replace with actual columns
	let options = ['bill_depth', 'flipper_length', 'bill_length', 'body_mass'];
	// let options = ['bill_depth', 'flipper_length', 'bill_length', 'bill_depth']

	let layoutMemory = $state({
		// column: [],
		row: options.slice(0, c.gridRows),
		column: options.slice(c.gridRows, c.gridRows + c.gridColumns)
	});

	let layout = $derived.by(() => {
		return {
			row: layoutMemory.row.slice(0, c.gridRows),
			column: layoutMemory.column.slice(0, c.gridColumns)
		};
	});

	$effect(() => {
		c.chartConfig = generateChartConfigs(layout, 'penguins');
	});

	// let config = $derived(generateChartConfigs(layout, "penguins"))

	function generateChartConfigs(layout: { row: string[]; column: string[] }, tableName: string) {
		const result = [];
		let idCounter = 1;

		// For each y-axis value (from the "row" array)
		layout.row.forEach((yValue) => {
			// For each x-axis value (from the "column" array)
			layout.column.forEach((xValue) => {
				result.push({
					id: idCounter.toString(),
					table: tableName,
					x: xValue,
					y: yValue
				});

				idCounter++;
			});
		});

		return result;
	}

	// $inspect(config)
</script>

<div class="container">
	<GridSizeSelector
		maxSize={6}
		bind:selectedRows={c.gridRows}
		bind:selectedColumns={c.gridColumns}
	/>
</div>

<div class="container">
	{#each Array(c.gridRows).keys() as row, i (row)}
		<div>
			<span>Row {row + 1}</span>
			<select bind:value={layoutMemory.row[i]}>
				{#each options as option (option)}
					<option value={option}>{option}</option>
				{/each}
			</select>
		</div>
	{/each}
	{#each Array(c.gridColumns).keys() as col, i (col)}
		<div>
			<span>Column {col + 1}</span>
			<select bind:value={layoutMemory.column[i]}>
				{#each options as option (option)}
					<option value={option}>{option}</option>
				{/each}
			</select>
		</div>
	{/each}
</div>

<style>
	.container {
		max-width: 800px;
		margin: 0 auto;
		padding: 20px;
		font-family: sans-serif;
	}
</style>
