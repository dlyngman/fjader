<script>
	import { Selection } from '@uwdata/mosaic-core';
	import { sum, min, max, count, avg } from '@uwdata/mosaic-sql';
	import { setContext, getContext } from 'svelte';
	import {
		ChartContainer,
		ColumnSelector,
		Grid,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		DotsMark,
		BarMark,
		BarMarkX
	} from '$lib/components';
	import { stack, normalize } from '$lib/transforms';
	import Rects from '$lib/components/rendering/Rects.svelte';

	const coordinator = getContext('mosaic-coordinator');
	const selection = Selection.crossfilter();

	// Color mode options
	const colorModes = [
		{ label: 'Default (no color prop)', value: 'default' },
		{ label: 'Constant: Hex (#800080)', value: 'hex' },
		{ label: 'Constant: Named (steelblue)', value: 'named' },
		{ label: 'Constant: RGB (rgb(255, 100, 50))', value: 'rgb' },
		{ label: 'Field: species (tableau10)', value: 'field-tableau10' },
		{ label: 'Field: species (category10)', value: 'field-category10' },
		{ label: 'Field: species (dark2)', value: 'field-dark2' },
		{ label: 'Field: species (set1)', value: 'field-set1' },
		{ label: 'Field: species (pastel1)', value: 'field-pastel1' },
		{ label: 'Field: island (tableau10)', value: 'field-island' }
	];

	// Stacking options
	const stackModes = [
		{ label: 'No stacking (min/max range)', value: 'none' },
		{ label: 'Stacked (use island color for segments)', value: 'stack' },
		{ label: 'Stacked + Normalized (%)', value: 'stack-normalize' }
	];

	let selectedColorMode = $state('field-tableau10');
	let selectedStackMode = $state('none');

	// Derive color prop based on selection
	const colorProp = $derived.by(() => {
		switch (selectedColorMode) {
			case 'default':
				return undefined;
			case 'hex':
				return '#800080';
			case 'named':
				return 'steelblue';
			case 'rgb':
				return 'rgb(255, 100, 50)';
			case 'field-tableau10':
				return 'species';
			case 'field-category10':
				return { field: 'species', scheme: 'category10' };
			case 'field-dark2':
				return { field: 'species', scheme: 'dark2' };
			case 'field-set1':
				return { field: 'species', scheme: 'set1' };
			case 'field-pastel1':
				return { field: 'species', scheme: 'pastel1' };
			case 'field-island':
				return 'island';
			default:
				return undefined;
		}
	});

	// Derive scheme prop (for string field mode)
	const schemeProp = $derived.by(() => {
		if (selectedColorMode === 'field-tableau10') return 'tableau10';
		return undefined;
	});

	// Description of current mode
	const modeDescription = $derived.by(() => {
		switch (selectedColorMode) {
			case 'default':
				return 'No color prop - uses default blue [0.2, 0.4, 0.8, 1.0]';
			case 'hex':
				return 'color="#800080" - constant purple via hex';
			case 'named':
				return 'color="steelblue" - constant via CSS named color';
			case 'rgb':
				return 'color="rgb(255, 100, 50)" - constant via rgb()';
			case 'field-tableau10':
				return 'color="species" scheme="tableau10" - GPU color scale lookup';
			case 'field-category10':
				return 'color={{ field: "species", scheme: "category10" }} - object form';
			case 'field-dark2':
				return 'color={{ field: "species", scheme: "dark2" }}';
			case 'field-set1':
				return 'color={{ field: "species", scheme: "set1" }}';
			case 'field-pastel1':
				return 'color={{ field: "species", scheme: "pastel1" }}';
			case 'field-island':
				return 'color="island" - different categorical field';
			default:
				return '';
		}
	});

	// Derive transforms based on stack mode
	const transforms = $derived.by(() => {
		switch (selectedStackMode) {
			case 'stack':
				return [stack({ direction: 'horizontal' })];
			case 'stack-normalize':
				return [stack({ direction: 'horizontal' }), normalize()];
			default:
				return [];
		}
	});

	// Stack mode description
	const stackDescription = $derived.by(() => {
		const needsIslandColor = selectedStackMode !== 'none' && !selectedColorMode.includes('island');
		const colorWarning = needsIslandColor ? ' ⚠️ Select "island" color for visible segments!' : '';

		switch (selectedStackMode) {
			case 'none':
				return 'x1={min("bill_length")} x2={max("bill_length")} - simple range bars';
			case 'stack':
				return `x={count()} transforms={[stack()]} - stacked by color field${colorWarning}`;
			case 'stack-normalize':
				return `x={count()} transforms={[stack(), normalize()]} - 100% stacked${colorWarning}`;
			default:
				return '';
		}
	});

	// X value depends on stack mode
	const xValue = $derived(selectedStackMode === 'none' ? null : count());
	const x1Value = $derived(selectedStackMode === 'none' ? min('bill_length') : undefined);
	const x2Value = $derived(selectedStackMode === 'none' ? max('bill_length') : undefined);
</script>

<div class="demo-container">
	<div class="controls">
		<h2>GPU Color Scale Demo</h2>

		<div class="control-row">
			<label for="color-mode">Color Mode:</label>
			<select id="color-mode" bind:value={selectedColorMode}>
				{#each colorModes as mode}
					<option value={mode.value}>{mode.label}</option>
				{/each}
			</select>
		</div>
		<div class="description">
			<code>{modeDescription}</code>
		</div>

		<div class="control-row" style="margin-top: 16px;">
			<label for="stack-mode">Stack Mode:</label>
			<select id="stack-mode" bind:value={selectedStackMode}>
				{#each stackModes as mode}
					<option value={mode.value}>{mode.label}</option>
				{/each}
			</select>
		</div>
		<div class="description">
			<code>{stackDescription}</code>
		</div>
	</div>

	<div class="chart-wrapper">
		<ChartContainer xLabel={selectedStackMode === 'none' ? 'bill_length' : 'count'} yLabel="species">
			{#snippet background()}
				<Frame />
				<MarginLabel />
			{/snippet}

			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						{#if selectedStackMode === 'none'}
							<BarMarkX
								table="penguins"
								x1={min('bill_length')}
								x2={max('bill_length')}
								y="species"
								color={colorProp}
								scheme={schemeProp}
								alpha={1}
							/>
						{:else}
							<BarMarkX
								table="penguins"
								x={count()}
								y="species"
								color={colorProp}
								scheme={schemeProp}
								alpha={1}
								{transforms}
							/>
						{/if}
					{/snippet}
				</WebGPUCanvas>
			{/snippet}

			{#snippet foreground()}
				<Crosshair />
			{/snippet}
		</ChartContainer>
	</div>
</div>

<style>
	.demo-container {
		width: 100%;
		max-width: 900px;
		margin: 0 auto;
		padding: 20px;
	}

	.controls {
		background: #f5f5f5;
		border-radius: 8px;
		padding: 16px 20px;
		margin-bottom: 20px;
	}

	.controls h2 {
		margin: 0 0 12px 0;
		font-size: 18px;
		font-weight: 600;
	}

	.control-row {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 12px;
	}

	.control-row label {
		font-weight: 500;
		min-width: 100px;
	}

	.control-row select {
		flex: 1;
		padding: 8px 12px;
		border: 1px solid #ccc;
		border-radius: 4px;
		font-size: 14px;
		background: white;
	}

	.description {
		background: #e8e8e8;
		padding: 8px 12px;
		border-radius: 4px;
		font-size: 13px;
	}

	.description code {
		font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
		color: #333;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4/3;
		min-height: 300px;
		max-height: 500px;
		position: relative;
		border: 1px solid #ddd;
		border-radius: 8px;
		overflow: hidden;
	}
</style>
