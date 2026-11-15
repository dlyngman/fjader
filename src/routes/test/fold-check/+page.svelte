<script>
	/**
	 * Fold check: a scale snap that folds, run on the GPU.
	 *
	 * In the rebin flow nothing folds yet (the rebinning mark's own rows change,
	 * which snaps), so this page makes a folding snap directly, on marks that
	 * morph and whose rows do not change: bars on a band x (Rects) with a
	 * linear y, dots on a band x (Dots) with a log y and with a symlog y.
	 *
	 * Fold: `y.folding(() => y.domain.set(..., { instant: true }))`, toggling
	 * the domain between its own and twice its top. Expected: the axis changes
	 * in one frame, the marks hold their pixels, then glide to their new
	 * height; no WebGPU errors in the console. The log lists, per press, a
	 * `domain … snap` and a `morph … spring` (the fold).
	 *
	 * Snap (no fold): the same change outside `folding()`, for comparison: the
	 * marks jump with the axis, and the log has no morph.
	 */
	import { initFjader } from '$lib';
	import { onMount } from 'svelte';
	import { sum } from '@uwdata/mosaic-sql';
	import {
		ChartContainer,
		Frame,
		AxisLeft,
		AxisBottom,
		WebGPUCanvas,
		BarMarkY,
		DotsMark
	} from '$lib/components';
	import { Grid } from '$lib/components/guides';
	import ScaleGrab from './ScaleGrab.svelte';

	const { queryEngine, gpuCoordinator } = initFjader();
	let isLoaded = $state(false);
	let log = $state([]);
	const t0 = performance.now();

	/** Per chart: its y scale getter and whether its domain is doubled now. */
	const charts = {
		linear: { scale: null, doubled: false, base: null },
		log: { scale: null, doubled: false, base: null },
		symlog: { scale: null, doubled: false, base: null }
	};

	function press(name, fold) {
		const chart = charts[name];
		const y = chart.scale?.();
		if (!y) return;
		const target = y.domain?.target;
		if (!target) return;
		chart.base ??= [target[0], target[1]];
		const [lo, hi] = chart.base;
		const next = chart.doubled ? [lo, hi] : [lo, hi * 2];
		chart.doubled = !chart.doubled;
		log = [
			...log,
			{
				id: log.length,
				at: Math.round(performance.now() - t0),
				what: `${name}: ${fold ? 'fold' : 'snap'} to [${next[0]}, ${next[1]}]`
			}
		];
		const set = () => y.domain.set(next, { instant: true });
		if (fold) y.folding(set);
		else set();
	}

	onMount(() => {
		const off = gpuCoordinator.observeTransitions((rec) => {
			log = [
				...log,
				{
					id: log.length,
					at: Math.round(performance.now() - t0),
					what: `  ${rec.part} ${rec.label.slice(0, 16)} ${rec.snap ? 'snap' : 'spring'}`
				}
			];
		});
		(async () => {
			await queryEngine.exec(`
				CREATE TABLE fold_data AS
				SELECT * FROM (VALUES
					('a', 2.0), ('b', 8.0), ('c', 30.0), ('d', 120.0), ('e', 400.0), ('f', 900.0)
				) t(cat, v)
			`);
			isLoaded = true;
		})();
		return off;
	});
</script>

{#if !isLoaded}
	<div class="status">Loading…</div>
{:else}
	<div class="container">
		<h1>Fold check</h1>
		<p class="lede">
			Fold: the axis changes in one frame, the marks hold their pixels, then glide. Snap: the marks
			jump with the axis. Watch the console for WebGPU errors.
		</p>
		<div class="grid">
			{#each [['linear', 'Bars, linear y'], ['log', 'Dots, log y'], ['symlog', 'Dots, symlog y']] as [name, title] (name)}
				<section>
					<h3>{title}</h3>
					<div class="controls">
						<button onclick={() => press(name, true)}>Fold</button>
						<button onclick={() => press(name, false)}>Snap (no fold)</button>
					</div>
					<div class="panel">
						<ChartContainer xLabel="cat" yLabel="v">
							{#snippet background()}
								<Frame />
								<AxisLeft />
								<AxisBottom />
							{/snippet}
							{#snippet canvas()}
								<WebGPUCanvas>
									{#snippet canvasComponents()}
										<Grid />
										<ScaleGrab onScale={(get) => (charts[name].scale = get)} />
										{#if name === 'linear'}
											<BarMarkY table="fold_data" x="cat" y={sum('v')} />
										{:else}
											<DotsMark
												table="fold_data"
												x="cat"
												y={sum('v')}
												r={6}
												preferredYScaleType={name}
											/>
										{/if}
									{/snippet}
								</WebGPUCanvas>
							{/snippet}
						</ChartContainer>
					</div>
				</section>
			{/each}
		</div>
		<ol class="log">
			{#each log as e (e.id)}
				<li>{e.at} ms — {e.what}</li>
			{/each}
		</ol>
	</div>
{/if}

<style>
	.container {
		padding: 20px;
	}
	.status {
		padding: 2rem;
	}
	.lede {
		max-width: 70ch;
		color: #555;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 16px;
	}
	.panel {
		height: 260px;
	}
	.controls {
		display: flex;
		gap: 8px;
		margin-bottom: 8px;
	}
	.log {
		font:
			12px ui-monospace,
			monospace;
		max-height: 320px;
		overflow: auto;
	}
</style>
