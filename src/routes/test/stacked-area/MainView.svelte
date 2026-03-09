<script>
	import { getContext } from 'svelte';
	import {
		ChartContainer,
		Grid,
		WebGPUCanvas,
		BarMarkY,
		BarMarkX,
		AreaMarkY
	} from '$lib/components';
	import { stackY, stackX, normalize } from '$lib';
	import { sum } from '@uwdata/mosaic-sql';

	const coordinator = getContext('mosaic-coordinator');

	let stackMode = $state('stack');
</script>

<div class="main-view-container">
	<h2>Stacked Area/Bar Experiment</h2>
	<p>Testing Arrow-native stacking (Track A). Transforms operate on DataAccessor directly — no arrowToObjects() conversion.</p>

	<div class="controls">
		<label>
			Mode:
			<select bind:value={stackMode}>
				<option value="stack">Stack</option>
				<option value="expand">Expand (100%)</option>
				<option value="center">Center</option>
				<option value="none">None (unstacked)</option>
			</select>
		</label>
	</div>

	<div class="charts-grid">
		<!-- Stacked Bar (Vertical) -->
		<div class="chart-wrapper">
			<h3>Stacked Bar Y — {stackMode}</h3>
			<ChartContainer xLabel="Month" yLabel="Bar Y Value">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							{#if stackMode !== 'none'}
								<BarMarkY
									table="stacked_categories"
									x="month"
									y={sum('value')}
									fill="category"
									transforms={[
										stackMode === 'expand'
											? stackY({ offset: 'expand' })
											: stackMode === 'center'
												? stackY({ offset: 'center' })
												: stackY()
									]}
									tooltip
								/>
							{:else}
								<BarMarkY
									table="stacked_categories"
									x="month"
									y={sum('value')}
									fill="category"
									tooltip
								/>
							{/if}
						{/snippet}
					</WebGPUCanvas>
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Stacked Bar (Horizontal) -->
		<div class="chart-wrapper">
			<h3>Stacked Bar X — {stackMode}</h3>
			<ChartContainer xLabel="Bar X Value" yLabel="Month">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							{#if stackMode !== 'none'}
								<BarMarkX
									table="stacked_categories"
									x={sum('value')}
									y="month"
									fill="category"
									transforms={[
										stackMode === 'expand'
											? stackX({ offset: 'expand' })
											: stackMode === 'center'
												? stackX({ offset: 'center' })
												: stackX()
									]}
									tooltip
								/>
							{:else}
								<BarMarkX
									table="stacked_categories"
									x={sum('value')}
									y="month"
									fill="category"
									tooltip
								/>
							{/if}
						{/snippet}
					</WebGPUCanvas>
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Stacked Area -->
		<div class="chart-wrapper wide">
			<h3>Stacked Area Y — {stackMode}</h3>
			<ChartContainer xLabel="X" yLabel="Area Y Value">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							{#if stackMode !== 'none'}
								<AreaMarkY
									table="stacked_timeseries"
									x="x"
									y="y"
									fill="series"
									transforms={[
										stackMode === 'expand'
											? stackY({ offset: 'expand' })
											: stackMode === 'center'
												? stackY({ offset: 'center' })
												: stackY()
									]}
									tooltip
									fillOpacity=0.8
									strokeWidth=2
									curve="monotone"
									dotRadius=4
									
								/>
							{:else}
								<AreaMarkY
									table="stacked_timeseries"
									x="x"
									y="y"
									fill="series"
									tooltip
									
								/>
							{/if}
						{/snippet}
					</WebGPUCanvas>
				{/snippet}
			</ChartContainer>
		</div>

		<!-- Stack + Normalize -->
		<div class="chart-wrapper wide">
			<h3>Stack + Normalize (100%)</h3>
			<ChartContainer xLabel="X (norm)" yLabel="Normalized %">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<AreaMarkY
								table="stacked_timeseries"
								x="x"
								y="y"
								fill="series"
								transforms={[stackY(), normalize()]}
								tooltip
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}
			</ChartContainer>
		</div>
	</div>
</div>

<style>
	.main-view-container {
		padding: 1rem 2rem;
	}
	h2 {
		margin: 0 0 0.25rem;
	}
	p {
		margin: 0 0 1rem;
		color: #888;
		font-size: 0.9rem;
	}
	.controls {
		margin-bottom: 1rem;
		display: flex;
		gap: 1rem;
		align-items: center;
	}
	.controls select {
		background: #1a1a1a;
		color: #e0e0e0;
		border: 1px solid #333;
		padding: 0.3rem 0.5rem;
		border-radius: 4px;
	}
	.charts-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
	}
	.chart-wrapper {
		background: #111;
		border: 1px solid #222;
		border-radius: 8px;
		padding: 1rem;
		min-height: 300px;
		aspect-ratio: 4/3;
		max-height: 500px;
		position: relative;
	}
	.chart-wrapper.wide {
		grid-column: 1 / -1;
		aspect-ratio: 3/1;
	}
	h3 {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
		color: #aaa;
	}
</style>
