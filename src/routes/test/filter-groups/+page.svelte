<script>
	import { sum, gt, column, literal } from '@uwdata/mosaic-sql';
	import { initFjader, getFilterGroups } from '$lib';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		WebGPUCanvas,
		BarMarkY
	} from '$lib/components';
	import Toggle from '$lib/interactors/Toggle.svelte';

	const { queryEngine } = initFjader();
	// From the same context, as app code outside initFjader()'s caller would.
	const groups = getFilterGroups();

	let isLoaded = $state(false);
	let loadError = $state(null);
	let mounted = $state(false);

	// Read before any chart has made the 'brush' group: nothing creates it here.
	const brushExists = $derived(groups.has('brush'));
	const brushActive = $derived(groups.isActive('brush'));
	const names = $derived(groups.names);
	const counts = $derived(groups.groups.map((g) => g.activeCount));

	onMount(async () => {
		try {
			await queryEngine.exec(`
				CREATE TABLE fg_sales AS
				SELECT * FROM (VALUES
					('Electronics', 500), ('Clothing', 300), ('Food', 250), ('Books', 200)
				) AS t(category, revenue)
			`);
			isLoaded = true;
		} catch (error) {
			loadError = error.message;
		}
	});

	/** A clause for the whole page: into every group the page's marks use. */
	function pageWide() {
		for (const group of groups.groups) {
			group.upsertManual('page-wide', gt(column('revenue'), literal(250)), null);
		}
	}
	function clearPageWide() {
		for (const group of groups.groups) group.removeManual('page-wide');
	}
</script>

{#if loadError}
	<p class="status error">Error: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading...</p>
{:else}
	<div class="container">
		<h1>The registry, read from outside</h1>
		<p class="subtitle">
			Derived values read before any chart exists: they must update when the chart mounts and when
			you click a bar.
		</p>

		<div class="chart-panel readout">
			<div>groups.has('brush'): <b>{brushExists}</b></div>
			<div>groups.isActive('brush'): <b>{brushActive}</b></div>
			<div>groups.names: <b>[{names.join(', ')}]</b></div>
			<div>active clauses per group: <b>[{counts.join(', ')}]</b></div>
			<div class="buttons">
				<button onclick={() => (mounted = !mounted)}>{mounted ? 'Unmount' : 'Mount'} chart</button>
				<button onclick={pageWide} disabled={!mounted}>Page-wide clause (revenue &gt; 250)</button>
				<button onclick={clearPageWide} disabled={!mounted}>Remove it</button>
			</div>
		</div>

		{#if mounted}
			<div class="chart-panel">
				<h3>Click a bar (Toggle, group "brush")</h3>
				<div class="chart-wrapper">
					<ChartContainer xLabel="Category" yLabel="Revenue">
						{#snippet background()}
							<Frame />
							<AxisLeft />
							<AxisBottom />
						{/snippet}
						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									<BarMarkY
										table="fg_sales"
										x="category"
										y={sum('revenue')}
										fill="category"
										selection="brush"
									/>
								{/snippet}
							</WebGPUCanvas>
						{/snippet}
						{#snippet interactors()}
							<Toggle selection="brush" field="category" />
						{/snippet}
					</ChartContainer>
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.container {
		max-width: 1400px;
		margin: 0 auto;
		padding: 2rem 1.5rem;
	}

	h1 {
		font-size: 1.5rem;
		font-weight: 700;
		margin: 0 0 0.25rem 0;
	}

	.subtitle {
		color: #888;
		margin: 0 0 1.5rem 0;
	}

	.chart-panel {
		border: 1px solid #333;
		border-radius: 8px;
		padding: 1rem;
		background: #111;
	}

	.chart-panel h3 {
		font-size: 0.95rem;
		font-weight: 600;
		margin: 0 0 0.25rem 0;
		color: #eee;
	}

	.readout {
		margin-bottom: 1rem;
		line-height: 1.7;
		color: #ddd;
	}

	.buttons {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4 / 3;
		min-height: 250px;
		max-height: 400px;
		position: relative;
	}

	.status {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
		font-size: 1rem;
		color: #666;
		margin: 0;
	}

	.error {
		color: red;
	}
</style>
