<script>
	import { sum, min, max, count, avg, y } from '@uwdata/mosaic-sql';
	import { setContext } from 'svelte';
	import {
		ChartContainer,
		ColumnSelector,
		Grid,
		// Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		DotsMark,
		BarMarkX,
		BarMarkY
	} from '$lib/components';
	import { stack, normalize } from '$lib/transforms';
	import Rects from '$lib/components/rendering/Rects.svelte';

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

	// Use $state instead of $derived for colorProp
	let colorProp = $state(undefined);

	// Update colorProp with $effect
	$effect(() => {
		let newColorProp;
		switch (selectedColorMode) {
			case 'default':
				newColorProp = undefined;
				break;
			case 'hex':
				newColorProp = '#800080';
				break;
			case 'named':
				newColorProp = 'steelblue';
				break;
			case 'rgb':
				newColorProp = 'rgb(255, 100, 50)';
				break;
			case 'field-tableau10':
				newColorProp = 'species';
				break;
			case 'field-category10':
				newColorProp = { field: 'species', scheme: 'category10' };
				break;
			case 'field-dark2':
				newColorProp = { field: 'species', scheme: 'dark2' };
				break;
			case 'field-set1':
				newColorProp = { field: 'species', scheme: 'set1' };
				break;
			case 'field-pastel1':
				newColorProp = { field: 'species', scheme: 'pastel1' };
				break;
			case 'field-island':
				newColorProp = 'island';
				break;
			default:
				newColorProp = undefined;
		}

		colorProp = newColorProp;
	});

	// Derive scheme prop (for string field mode)
	let schemeProp = $state(undefined);
	$effect(() => {
		schemeProp = selectedColorMode === 'field-tableau10' ? 'tableau10' : undefined;
	});

	// Description of current mode
	let modeDescription = $state('');
	$effect(() => {
		switch (selectedColorMode) {
			case 'default':
				modeDescription = 'No fill prop - uses default blue [0.2, 0.4, 0.8, 1.0]';
				break;
			case 'hex':
				modeDescription = 'fill="#800080" - constant purple via hex';
				break;
			case 'named':
				modeDescription = 'fill="steelblue" - constant via CSS named color';
				break;
			case 'rgb':
				modeDescription = 'fill="rgb(255, 100, 50)" - constant via rgb()';
				break;
			case 'field-tableau10':
				modeDescription = 'fill="species" scheme="tableau10" - GPU color scale lookup';
				break;
			case 'field-category10':
				modeDescription = 'fill={{ field: "species", scheme: "category10" }} - object form';
				break;
			case 'field-dark2':
				modeDescription = 'fill={{ field: "species", scheme: "dark2" }}';
				break;
			case 'field-set1':
				modeDescription = 'fill={{ field: "species", scheme: "set1" }}';
				break;
			case 'field-pastel1':
				modeDescription = 'fill={{ field: "species", scheme: "pastel1" }}';
				break;
			case 'field-island':
				modeDescription = 'fill="island" - different categorical field';
				break;
			default:
				modeDescription = '';
		}
	});

	// Derive transforms based on stack mode
	let transforms = $state([]);
	$effect(() => {
		switch (selectedStackMode) {
			case 'stack':
				transforms = [stack({ direction: 'horizontal' })];
				break;
			case 'stack-normalize':
				transforms = [stack({ direction: 'horizontal' }), normalize()];
				break;
			default:
				transforms = [];
		}
	});

	// Stack mode description
	let stackDescription = $state('');
	$effect(() => {
		const needsIslandColor = selectedStackMode !== 'none' && !selectedColorMode.includes('island');
		const colorWarning = needsIslandColor ? ' ⚠️ Select "island" color for visible segments!' : '';

		switch (selectedStackMode) {
			case 'none':
				stackDescription = 'x1={min("bill_length")} x2={max("bill_length")} - simple range bars';
				break;
			case 'stack':
				stackDescription = `x={count()} transforms={[stack()]} - stacked by color field${colorWarning}`;
				break;
			case 'stack-normalize':
				stackDescription = `x={count()} transforms={[stack(), normalize()]} - 100% stacked${colorWarning}`;
				break;
			default:
				stackDescription = '';
		}
	});

	// X value depends on stack mode
	let xValue = $state(null);
	let x1Value = $state(null);
	let x2Value = $state(null);
	$effect(() => {
		if (selectedStackMode === 'none') {
			xValue = null;
			x1Value = min('bill_length');
			x2Value = max('bill_length');
		} else {
			xValue = count();
			x1Value = undefined;
			x2Value = undefined;
		}
	});
</script>

<div class="demo-container">
	<div class="controls">
		<h2>GPU Color Scale Demo</h2>

		<div class="control-row">
			<label for="color-mode">Color Mode:</label>
			<select id="color-mode" bind:value={selectedColorMode}>
				{#each colorModes as mode (mode.value)}
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
				{#each stackModes as mode (mode.value)}
					<option value={mode.value}>{mode.label}</option>
				{/each}
			</select>
		</div>
		<div class="description">
			<code>{stackDescription}</code>
		</div>
	</div>

	<div class="chart-wrapper">
		<ChartContainer
			xLabel={selectedStackMode === 'none' ? 'bill_length' : 'count'}
			yLabel="species"
		>
			{#snippet background()}
				<!-- <Frame /> -->
				<MarginLabel />
			{/snippet}

			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<!-- GPU Grid Lines (both axes, Y is band scale) -->
						<Grid />

						{#if selectedStackMode === 'none'}
							<BarMarkX
								table="penguins"
								x1={min('bill_length')}
								x2={max('bill_length')}
								y="species"
								fill={colorProp}
								scheme={schemeProp}
								opacity={1}
							/>
						{:else}
							<BarMarkX
								table="penguins"
								x={count()}
								y="species"
								fill={colorProp}
								scheme={schemeProp}
								opacity={1}
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
	<div class="chart-wrapper">
		<ChartContainer
			xLabel={selectedStackMode === 'none' ? 'bill_length' : 'count'}
			yLabel="species"
		>
			{#snippet background()}
				<!-- <Frame /> -->
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
								fill={colorProp}
								scheme={schemeProp}
								opacity={1}
							/>
						{:else}
							<BarMarkX
								table="penguins"
								x={count()}
								y="species"
								fill={colorProp}
								scheme={schemeProp}
								opacity={1}
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
	<!-- <div class="chart-wrapper">
		<ChartContainer xLabel={selectedStackMode === 'none' ? 'bill_length' : 'count'} yLabel="species">
			{#snippet background()}
				<Frame />
				<MarginLabel />
			{/snippet}

			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						{#if selectedStackMode === 'none'}
							<BarMarkY
								table="penguins"
								y1={min('bill_length')}
								y2={max('bill_length')}
								x="species"
								fill={colorProp}
								scheme={schemeProp}
								opacity={1}
							/>
						{:else}
							<BarMarkY
								table="penguins"
								y={count()}
								x="species"
								fill={colorProp}
								scheme={schemeProp}
								opacity={1}
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
	</div> -->
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
