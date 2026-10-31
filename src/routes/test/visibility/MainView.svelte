<script>
	import {
		ChartContainer,
		Grid,
		Crosshair,
		WebGPUCanvas,
		LineMark,
		DotsMark,
		BarMarkY
	} from '$lib/components';
	import { IntervalX } from '$lib/interactors';
	import { count } from '@uwdata/mosaic-sql';

	let collapsedA = $state(false);
	let collapsedB = $state(false);
</script>

<div class="container">
	<h1>Viewport Visibility Test</h1>
	<p>
		Open the console to see <code>[visibility]</code> logs when charts are enabled/disabled. Charts outside
		the viewport or in collapsed sections should log DISABLED.
	</p>

	<!-- ============================================================ -->
	<!-- SECTION 1: Visible charts with brush crossfilter              -->
	<!-- ============================================================ -->
	<section>
		<h2>1. Always visible — brush here to test crossfilter</h2>
		<p>
			Brush the line chart. Linked charts below should still respond when visible, and stop querying
			when hidden.
		</p>
		<div class="chart-row">
			<div class="chart-wrapper">
				<ChartContainer xLabel="x" yLabel="y">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<LineMark table="timeseries" x="x" y="y" strokeWidth={1.5} />
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet foreground()}
						<Crosshair />
					{/snippet}
					{#snippet interactors()}
						<IntervalX selection="brush" />
					{/snippet}
				</ChartContainer>
			</div>
			<div class="chart-wrapper">
				<ChartContainer xLabel="x" yLabel="y2">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<LineMark table="timeseries" x="x" y="y2" strokeWidth={1.5} selection="brush" />
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet foreground()}
						<Crosshair />
					{/snippet}
				</ChartContainer>
			</div>
		</div>
	</section>

	<!-- ============================================================ -->
	<!-- SECTION 2: Collapsible containers                             -->
	<!-- ============================================================ -->
	<section>
		<h2>2. Collapsible sections</h2>
		<p>
			Collapse these to see charts get DISABLED. Expand to see them re-enable and catch up with the
			current brush.
		</p>

		<div class="collapsible">
			<button onclick={() => (collapsedA = !collapsedA)}>
				{collapsedA ? 'Show' : 'Hide'} scatter plot
			</button>
			{#if !collapsedA}
				<div class="chart-wrapper">
					<ChartContainer xLabel="bill_length" yLabel="bill_depth">
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<Grid />
									<DotsMark table="penguins" x="bill_length" y="bill_depth" fill="species" r={4} />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
						{#snippet foreground()}
							<Crosshair />
						{/snippet}
					</ChartContainer>
				</div>
			{/if}
		</div>

		<div class="collapsible">
			<button onclick={() => (collapsedB = !collapsedB)}>
				{collapsedB ? 'Show' : 'Hide'} bar chart
			</button>
			{#if !collapsedB}
				<div class="chart-wrapper">
					<ChartContainer xLabel="species" yLabel="count">
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<Grid />
									<BarMarkY table="penguins" x="species" y={count()} fill="island" />
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
					</ChartContainer>
				</div>
			{/if}
		</div>
	</section>

	<!-- ============================================================ -->
	<!-- SECTION 3: Spacer to push charts off-screen                   -->
	<!-- ============================================================ -->
	<section class="spacer">
		<h2>3. Scroll down to find more charts</h2>
		<p>
			The charts below should be DISABLED until you scroll them into view (with 200px lookahead).
		</p>
		<div class="spacer-block">
			<div class="scroll-indicator">Scroll down ~800px</div>
		</div>
	</section>

	<!-- ============================================================ -->
	<!-- SECTION 4: Off-screen charts (scroll to reveal)               -->
	<!-- ============================================================ -->
	<section>
		<h2>4. Off-screen charts — should be disabled until scrolled into view</h2>
		<div class="chart-row">
			<div class="chart-wrapper">
				<ChartContainer xLabel="x" yLabel="y (filtered)">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<LineMark table="timeseries" x="x" y="y" strokeWidth={1.5} selection="brush" />
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet foreground()}
						<Crosshair />
					{/snippet}
				</ChartContainer>
			</div>
			<div class="chart-wrapper">
				<ChartContainer xLabel="x" yLabel="y2 (filtered)">
					{#snippet canvas()}
						<WebGPUCanvas>
							{#snippet canvasComponents()}
								<Grid />
								<LineMark table="timeseries" x="x" y="y2" strokeWidth={1.5} selection="brush" />
							{/snippet}
						</WebGPUCanvas>
					{/snippet}
					{#snippet foreground()}
						<Crosshair />
					{/snippet}
				</ChartContainer>
			</div>
		</div>

		<div class="chart-wrapper">
			<ChartContainer xLabel="bill_length" yLabel="body_mass">
				{#snippet canvas()}
					<WebGPUCanvas>
						{#snippet canvasComponents()}
							<Grid />
							<DotsMark
								table="penguins"
								x="bill_length"
								y="body_mass"
								fill="species"
								r={3}
								opacity={0.7}
							/>
						{/snippet}
					</WebGPUCanvas>
				{/snippet}
				{#snippet foreground()}
					<Crosshair />
				{/snippet}
			</ChartContainer>
		</div>
	</section>

	<!-- ============================================================ -->
	<!-- SECTION 5: Tab visibility test instructions                    -->
	<!-- ============================================================ -->
	<section>
		<h2>5. Tab visibility</h2>
		<p>
			Switch to another browser tab and back. All charts should log DISABLED then ENABLED in the
			console.
		</p>
	</section>
</div>

<style>
	.container {
		width: 100%;
		max-width: 1200px;
		margin: 0 auto;
		padding: 20px;
	}

	h1 {
		margin-bottom: 0.5rem;
	}

	h2 {
		margin-top: 2rem;
		margin-bottom: 0.5rem;
	}

	section {
		margin-bottom: 1rem;
	}

	.chart-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
	}

	.chart-wrapper {
		width: 100%;
		height: 350px;
	}

	.collapsible {
		margin-bottom: 12px;
	}

	.collapsible button {
		padding: 8px 16px;
		cursor: pointer;
		border: 1px solid #ccc;
		background: #f5f5f5;
		border-radius: 4px;
		font-size: 14px;
	}

	.collapsible button:hover {
		background: #e8e8e8;
	}

	.spacer-block {
		height: 800px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 2px dashed #ddd;
		border-radius: 8px;
		margin-top: 1rem;
	}

	.scroll-indicator {
		font-size: 18px;
		color: #999;
	}

	code {
		background: #f0f0f0;
		padding: 2px 6px;
		border-radius: 3px;
		font-size: 13px;
	}
</style>
