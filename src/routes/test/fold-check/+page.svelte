<script>
	/**
	 * Unit-change check: a change of a scale's unit, as a rebin makes it, run
	 * on device for every kind of consumer of the scale.
	 *
	 * Fold: `y.folding(() => y.domain.set(..., { instant: true }))`, toggling
	 * the domain between its own and twice its top. The scale tweens its
	 * render domain so every value moves linearly in pixels. Expected: every
	 * mark glides together, with the axis, from where it was to where it
	 * belongs, and nothing has code of its own for it:
	 * - bars on a band x (Rects), dots on a band x (Dots), with a linear, a log
	 *   and a symlog y;
	 * - overlays on one linear y: an area, a line, raw dots, a rule (GPU), and
	 *   SVG text labels; hover the line mid-glide and the tooltip follows too.
	 * No WebGPU errors in the console. The log lists, per press, a
	 * `domain … spring` (the tween).
	 *
	 * Snap (no fold): the same change outside `folding()`, for comparison:
	 * everything jumps with the axis.
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
		DotsMark,
		AreaMarkY,
		LineMark,
		RuleMarkY,
		TextMark
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
		symlog: { scale: null, doubled: false, base: null },
		overlays: { scale: null, doubled: false, base: null }
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
			// The overlays: a smooth curve over a numeric x, and a rule's level.
			await queryEngine.exec(`
				CREATE TABLE overlay_data AS
				SELECT i::DOUBLE AS i, round(40 + 30 * sin(i / 3.0) + i * 2, 1) AS v
				FROM range(0, 21) t(i)
			`);
			await queryEngine.exec(`CREATE TABLE overlay_rule AS SELECT 50.0 AS v`);
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
			Fold: a change of unit. Every mark, the labels and the axis glide together, each value in a
			straight line. Hover the line mid-glide: the tooltip follows. Snap: everything jumps. Watch
			the console for WebGPU errors.
		</p>
		<div class="grid">
			{#each [['linear', 'Bars, linear y'], ['log', 'Dots, log y'], ['symlog', 'Dots, symlog y'], ['overlays', 'Area, line, dots, rule, labels: one linear y']] as [name, title] (name)}
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
										{:else if name === 'overlays'}
											<AreaMarkY table="overlay_data" x="i" y="v" fillOpacity={0.2} />
											<LineMark table="overlay_data" x="i" y="v" strokeWidth={2} />
											<DotsMark table="overlay_data" x="i" y="v" r={3} />
											<RuleMarkY table="overlay_rule" y="v" stroke="#c00" strokeWidth={2} />
											<TextMark table="overlay_data" x="i" y="v" text="v" dy={-10} fontSize={9} />
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
