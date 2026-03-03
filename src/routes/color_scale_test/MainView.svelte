<script>
	import { sum } from '@uwdata/mosaic-sql';
	import {
		ChartContainer,
		WebGPUCanvas,
		DotsMark,
		BarMarkY,
		Crosshair,
		Grid,
		Legend
	} from '$lib/components';

	// Color configuration state
	let colorField = $state('distance');
	let colorScheme = $state('tableau10');
	let markType = $state('dots');

	// Available options
	const categoricalFields = [
		// { value: 'origin', label: 'Origin (Categorical)' },
		{ value: 'carrier', label: 'Carrier (Categorical)' },
		{ value: null, label: 'None' }
	];

	const continuousFields = [
		{ value: 'distance', label: 'Distance (Continuous)' },
		{ value: 'delay', label: 'Delay (Continuous)' },
		{ value: 'time', label: 'Time (Continuous)' }
	];

	const allFields = [...categoricalFields, ...continuousFields];

	const categoricalSchemes = [
		'tableau10',
		'category10',
		'accent',
		'dark2',
		'paired',
		'pastel1',
		'pastel2',
		'set1',
		'set2',
		'set3'
	];

	const continuousSchemes = [
		'viridis',
		'plasma',
		'inferno',
		'magma',
		'cividis',
		'turbo',
		'blues',
		'greens',
		'reds',
		'purples'
	];

	// Determine if current field is categorical
	const isCategorical = $derived(categoricalFields.some((f) => f.value === colorField));

	const availableSchemes = $derived(isCategorical ? categoricalSchemes : continuousSchemes);

	// Auto-switch scheme when field type changes
	$effect(() => {
		if (isCategorical && !categoricalSchemes.includes(colorScheme)) {
			colorScheme = 'tableau10';
		} else if (!isCategorical && !continuousSchemes.includes(colorScheme)) {
			colorScheme = 'viridis';
		}
	});
</script>

<div class="page-container">
	<div class="controls-panel">
		<h2>Color Scale Test</h2>

		<div class="control-group">
			<label>
				<strong>Mark Type:</strong>
				<select bind:value={markType}>
					<option value="dots">Scatter Plot (DotsMark)</option>
					<option value="bar">Bar Chart (BarMarkY - origin)</option>
				</select>
			</label>
		</div>

		<div class="control-group">
			<label>
				<strong>Color Field:</strong>
				<select bind:value={colorField}>
					{#each allFields as field (field.value)}
						<option value={field.value}>{field.label}</option>
					{/each}
				</select>
			</label>
		</div>

		<div class="control-group">
			<label>
				<strong>Color Scheme:</strong>
				<select bind:value={colorScheme}>
					{#each availableSchemes as scheme (scheme)}
						<option value={scheme}>{scheme}</option>
					{/each}
				</select>
			</label>
		</div>

		<div class="info-panel">
			<h3>Current Configuration:</h3>
			<ul>
				<li><strong>Field:</strong> {colorField || 'none'}</li>
				<li><strong>Type:</strong> {isCategorical ? 'Categorical' : 'Continuous'}</li>
				<li><strong>Scheme:</strong> {colorScheme}</li>
			</ul>

			<h3>Testing:</h3>
			<p>
				{#if markType === 'bar' && colorField === 'origin'}
					✅ <strong>Deduplication Test Active!</strong><br />
					Both X-axis (band scale) and color use "origin".<br />
					Check console SQL - should see only ONE __dplot_origin_idx column.
				{:else}
					ℹ️ Set Mark Type to "Bar Chart" and Color Field to "Origin" to test column deduplication.
				{/if}
			</p>
		</div>
	</div>

	<div class="chart-container">
		<ChartContainer>
			{#snippet legend()}
				<Legend color={colorField} />
			{/snippet}

			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						{#if markType === 'dots'}
							<Grid />
							<DotsMark
								table="flights"
								x="delay"
								y="time"
								fill={colorField}
								scheme={colorScheme}
								opacity={0.5}
								r={2}
								limit={50000}
							/>
						{:else}
							<!-- Bar chart with origin on X axis and colored by configurable field -->
							<BarMarkY
								table="flights"
								x="origin"
								y={sum('delay')}
								fill={colorField}
								scheme={colorScheme}
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
	.page-container {
		display: flex;
		gap: 20px;
		padding: 20px;
		height: 100vh;
	}

	.controls-panel {
		flex: 0 0 350px;
		padding: 20px;
		background: #f5f5f5;
		border-radius: 8px;
		overflow-y: auto;
	}

	.controls-panel h2 {
		margin-top: 0;
		color: #333;
	}

	.control-group {
		margin-bottom: 20px;
	}

	.control-group label {
		display: block;
		margin-bottom: 8px;
	}

	.control-group strong {
		display: block;
		margin-bottom: 4px;
		color: #555;
	}

	.control-group select {
		width: 100%;
		padding: 8px;
		font-size: 14px;
		border: 1px solid #ccc;
		border-radius: 4px;
		background: white;
	}

	.info-panel {
		margin-top: 30px;
		padding: 15px;
		background: white;
		border-radius: 4px;
		border-left: 4px solid #4caf50;
	}

	.info-panel h3 {
		margin-top: 0;
		font-size: 16px;
		color: #333;
	}

	.info-panel ul {
		margin: 10px 0;
		padding-left: 20px;
	}

	.info-panel li {
		margin-bottom: 5px;
		font-size: 14px;
	}

	.info-panel p {
		margin: 10px 0 0 0;
		font-size: 14px;
		line-height: 1.6;
	}

	.chart-container {
		flex: 1;
		min-width: 0;
		position: relative;
	}
</style>
