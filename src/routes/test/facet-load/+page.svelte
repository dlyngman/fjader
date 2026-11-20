<script>
	/**
	 * Facet load: what a facet grid's text costs as it grows. Every cell paints
	 * the chart's whole text atlas (TextAtlas: one per chart, a surface per
	 * canvas), so label work can grow with cells × labels. Compare runs at a few
	 * cell counts, with labels and without.
	 *
	 *   ?cells=N    facet cells (default 4; try 4 and 20)
	 *   ?labels=0   no <Labels> (axes only: their tick strings are shared)
	 *
	 * Run session, wait for the summary, then Save log (facetload-<variant>.json
	 * in Downloads; scripts/measure/dash30.py reads it). One run per page load:
	 * reload between runs. Hands off the mouse, same window size between runs,
	 * DevTools closed unless recording a trace.
	 *
	 * The session, in phases (each frame is tagged; User Timing marks
	 * fjader:phase:<name> for traces):
	 *   idle      2 s: the floor
	 *   relabel   the measure switched between count and sum six times, 1.2 s
	 *             apart: every bar re-queries and every label's string changes
	 *   idle-end  1 s
	 */
	import { count, sum } from '@uwdata/mosaic-sql';
	import { initFjader } from '$lib';
	import { onMount, onDestroy, tick } from 'svelte';
	import { page } from '$app/state';
	import { ChartContainer, AxisLeft, AxisBottom, BarMarkY, Frame, Labels } from '$lib/components';
	import { FrameProbe } from '../dashboard-30/frame-probe';

	const params = page.url.searchParams;
	const CELLS = Math.max(1, Math.min(40, Number(params.get('cells')) || 4));
	const LABELS = params.get('labels') !== '0';
	const VARIANT = `cells${CELLS}-labels${LABELS ? 1 : 0}`;
	const COLUMNS = CELLS <= 4 ? 2 : 4;

	const { queryEngine, gpuCoordinator } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);
	let measureSum = $state(false);
	let gridEl = $state();

	let probe = null;
	let probeReady = $state(false);
	let running = $state(false);
	let done = $state(false);
	let summary = $state(null);
	const events = [];
	let mountedAt = 0;

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const frame = () => new Promise((r) => requestAnimationFrame(r));

	function mark(kind, label) {
		events.push({ kind, label, t: performance.now() });
		performance.mark(`fjader:${kind}:${label}`);
	}

	function phase(name) {
		probe?.setPhase(name);
		mark('phase', name);
	}

	async function runSession() {
		running = true;
		try {
			probe.start();
			mark('session', VARIANT);

			phase('idle');
			await sleep(2000);

			phase('relabel');
			for (let i = 0; i < 6; i++) {
				measureSum = !measureSum;
				await sleep(1200);
			}

			phase('idle-end');
			await sleep(1000);
			mark('end', VARIANT);
		} finally {
			probe.stop();
			summary = probe.summarize('idle');
			running = false;
			done = true;
		}
	}

	function save() {
		const json = JSON.stringify(
			{
				variant: VARIANT,
				params: Object.fromEntries(params),
				viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
				userAgent: navigator.userAgent,
				mountedAt,
				events,
				summary,
				probe: probe?.toJSON() ?? null
			},
			null,
			1
		);
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
		a.download = `facetload-${VARIANT}.json`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	onMount(async () => {
		try {
			// CELLS groups × 8 categories, deterministic, uneven counts and sums so
			// every label differs between the two measures.
			await queryEngine.exec(`
				CREATE TABLE facet_load AS
				SELECT 'g' || lpad(CAST(i % ${CELLS} AS VARCHAR), 2, '0') AS grp,
					'c' || CAST((i * 7) % 8 AS VARCHAR) AS cat,
					(i * 7919) % 97 AS v
				FROM range(${CELLS * 400}) t(i)
				WHERE (i * 31) % 11 <> 0
			`);
			mountedAt = performance.now();
			isLoaded = true;
			await gpuCoordinator.ready;
			await tick();
			await frame();
			probe = new FrameProbe({ mutationRoot: null, device: gpuCoordinator.device });
			probeReady = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});

	onDestroy(() => probe?.destroy());
</script>

{#if loadError}
	<p class="status error">Error: {loadError}</p>
{:else if !isLoaded}
	<p class="status">Loading...</p>
{:else}
	<div class="container">
		<h1>Facet load ({VARIANT})</h1>
		<div class="controls">
			<button disabled={running || done || !probeReady} onclick={runSession}>Run session</button>
			<button disabled={!done} onclick={save}>Save log</button>
			{#if !probeReady}<span>waiting for the GPU…</span>{/if}
			{#if running}<span>running…</span>{/if}
		</div>

		{#if summary}
			<table class="summary">
				<thead>
					<tr>
						<th>phase</th><th>frames</th><th>work p50</th><th>work p95</th><th>dropped %</th><th
							>GPU p50</th
						><th>atlas uploads</th>
					</tr>
				</thead>
				<tbody>
					{#each summary.phases as p (p.phase)}
						<tr>
							<td>{p.phase}</td>
							<td>{p.frames}</td>
							<td>{p.workP50.toFixed(1)}</td>
							<td>{p.workP95.toFixed(1)}</td>
							<td>{p.droppedPct.toFixed(1)}</td>
							<td>{p.gpuP50 == null ? '–' : p.gpuP50.toFixed(1)}</td>
							<td>{p.elementDraws}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}

		<div
			class="grid-wrapper"
			bind:this={gridEl}
			style:height="{Math.ceil(CELLS / COLUMNS) * 220}px"
		>
			<ChartContainer
				xLabel="cat"
				yLabel={measureSum ? 'sum of v' : 'count'}
				fx="grp"
				columns={COLUMNS}
			>
				<Frame />
				<AxisLeft />
				<AxisBottom />
				<BarMarkY table="facet_load" x="cat" y={measureSum ? sum('v') : count()} fill="cat">
					{#if LABELS}<Labels anchor="inside-end" />{/if}
				</BarMarkY>
			</ChartContainer>
		</div>
	</div>
{/if}

<style>
	.container {
		padding: 20px;
	}

	.controls {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-bottom: 12px;
	}

	.summary {
		font-size: 12px;
		margin-bottom: 12px;
	}

	.summary td,
	.summary th {
		padding: 0 8px;
		text-align: right;
	}

	.status {
		padding: 20px;
	}

	.error {
		color: #c00;
	}
</style>
