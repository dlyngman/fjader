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
	let legendPosition = $state('top');
	let colorScaleType = $state('');

	// Transform-specific parameters
	let symlogConstant = $state(1);
	let powExponent = $state(0.5);

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

	const divergingSchemes = ['rdbu', 'brbg', 'piyg', 'puor', 'rdylbu', 'spectral'];

	const transformTypes = [
		{ value: '', label: 'Auto (linear)' },
		{ value: 'log', label: 'Log' },
		{ value: 'symlog', label: 'Symlog' },
		{ value: 'sqrt', label: 'Sqrt' },
		{ value: 'pow', label: 'Pow' }
	];

	// Determine if current field is categorical
	const isCategorical = $derived(categoricalFields.some((f) => f.value === colorField));

	const availableSchemes = $derived(
		isCategorical
			? categoricalSchemes
			: colorScaleType
				? [...continuousSchemes, ...divergingSchemes]
				: continuousSchemes
	);

	// Auto-switch scheme when field type changes
	$effect(() => {
		if (isCategorical && !categoricalSchemes.includes(colorScheme)) {
			colorScheme = 'tableau10';
		} else if (!isCategorical && !continuousSchemes.includes(colorScheme) && !divergingSchemes.includes(colorScheme)) {
			colorScheme = 'viridis';
		}
	});

	// Build the fill prop — string for auto, object wrapper for explicit type
	const fillProp = $derived.by(() => {
		if (!colorField) return null;
		if (!colorScaleType) return colorField;
		// Object wrapper with explicit type
		const obj = { field: colorField, type: colorScaleType };
		if (colorScaleType === 'symlog') obj.constant = symlogConstant;
		if (colorScaleType === 'pow') obj.exponent = powExponent;
		return obj;
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
				<strong>Color Scale Type:</strong>
				<select bind:value={colorScaleType} disabled={isCategorical}>
					{#each transformTypes as t (t.value)}
						<option value={t.value}>{t.label}</option>
					{/each}
				</select>
			</label>
			{#if isCategorical}
				<small>Transform types only apply to continuous fields</small>
			{/if}
		</div>

		{#if colorScaleType === 'symlog'}
			<div class="control-group">
				<label>
					<strong>Symlog Constant (C):</strong>
					<input type="range" min="0.01" max="100" step="0.01" bind:value={symlogConstant} />
					<span>{symlogConstant}</span>
				</label>
			</div>
		{/if}

		{#if colorScaleType === 'pow'}
			<div class="control-group">
				<label>
					<strong>Pow Exponent:</strong>
					<input type="range" min="0.1" max="3" step="0.1" bind:value={powExponent} />
					<span>{powExponent}</span>
				</label>
			</div>
		{/if}

		<div class="control-group">
			<label>
				<strong>Legend Position:</strong>
				<select bind:value={legendPosition}>
					<option value="top">Top (horizontal)</option>
					<option value="right">Right (vertical)</option>
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
				<li><strong>Transform:</strong> {colorScaleType || 'linear (auto)'}</li>
				<li><strong>Scheme:</strong> {colorScheme}</li>
				{#if colorScaleType === 'symlog'}
					<li><strong>Constant:</strong> {symlogConstant}</li>
				{/if}
				{#if colorScaleType === 'pow'}
					<li><strong>Exponent:</strong> {powExponent}</li>
				{/if}
			</ul>

			<h3>Testing:</h3>
			<p>
				{#if colorScaleType}
					Try different transforms on the <strong>distance</strong> field (positive, skewed)
					or the <strong>delay</strong> field (negative values, good for symlog).
				{:else if markType === 'bar' && colorField === 'origin'}
					Deduplication Test Active! Both X-axis (band scale) and color use "origin".
				{:else}
					Select a transform type (log, symlog, sqrt, pow) to test non-linear
					color normalization on the GPU.
				{/if}
			</p>
		</div>
	</div>

	<div class="chart-container">
		<ChartContainer {legendPosition}>
			{#snippet legend()}
				<Legend color={colorField} selection="legend" />
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
								fill={fillProp}
								scheme={colorScheme}
								opacity={0.5}
								r={2}
								limit={50000}
								selection="legend"
							/>
						{:else}
							<!-- Bar chart with origin on X axis and colored by configurable field -->
							<BarMarkY
								table="flights"
								x="origin"
								y={sum('delay')}
								fill={fillProp}
								scheme={colorScheme}
								selection="legend"
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

	.control-group select,
	.control-group input[type='range'] {
		width: 100%;
		padding: 8px;
		font-size: 14px;
		border: 1px solid #ccc;
		border-radius: 4px;
		background: white;
	}

	.control-group input[type='range'] {
		padding: 4px 0;
	}

	.control-group small {
		display: block;
		margin-top: 4px;
		color: #999;
		font-size: 12px;
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
