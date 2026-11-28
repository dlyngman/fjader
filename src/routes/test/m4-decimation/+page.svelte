<script>
	/**
	 * Decimated lines: 100K points in three series, drawn decimating, raw, and
	 * by the default.
	 *
	 * Run session measures what a frame costs while the first chart (decimating)
	 * is hovered, panned and zoomed, with the dashboard's frame probe
	 * (../dashboard-30/frame-probe.ts): per frame the interval, the main-thread
	 * work, the GPU time per submit and the WebGPU objects made. Saves
	 * m4-session.json to Downloads when it ends, in the shape
	 * scripts/measure/dash30.py reads. One run per page load; don't move the
	 * mouse while it runs; same window for runs you compare.
	 *
	 * The session, in phases:
	 *   idle      1.5 s, nothing happening: the display's cadence
	 *   hover     3 s, the pointer crossing the plot: the chart may redraw, x
	 *             does not move
	 *   pan       3 s, a drag in the x axis margin, there and back
	 *   zoom      wheel in and out in the same margin
	 *   idle-end  1 s
	 */
	import { initFjader } from '$lib';
	import { onDestroy, onMount, tick } from 'svelte';
	import MainView from './MainView.svelte';
	import { FrameProbe } from '../dashboard-30/frame-probe';

	const { queryEngine, gpuCoordinator } = initFjader();
	let isLoaded = $state(false);
	let loadError = $state(null);

	/** @type {FrameProbe | null} */
	let probe = null;
	let probeReady = $state(false);
	let running = $state(false);
	let done = $state(false);
	const events = [];

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
	const chart = () => document.querySelector('.chart-wrapper');
	const foreground = () => chart().querySelector('svg.svg-foreground');
	const plotRect = () => chart().querySelector('rect.interaction-target').getBoundingClientRect();
	const moveType =
		typeof window !== 'undefined' && 'onpointerrawupdate' in window
			? 'pointerrawupdate'
			: 'pointermove';

	function pointer(target, type, x, y, buttons = 0) {
		target.dispatchEvent(
			new PointerEvent(type, {
				bubbles: type !== 'pointerenter' && type !== 'pointerleave',
				cancelable: true,
				composed: true,
				pointerId: 1,
				pointerType: 'mouse',
				isPrimary: true,
				button: 0,
				buttons,
				clientX: x,
				clientY: y
			})
		);
	}

	function phase(name) {
		probe.setPhase(name);
		performance.mark(`fjader:phase:${name}`);
		events.push({ kind: 'phase', label: name, t: performance.now() });
	}

	/** Moves along `path(t)` → [x, y] for `ms`, one per frame, with `buttons` held. */
	async function sweep(path, ms, buttons) {
		const svg = foreground();
		const start = performance.now();
		for (;;) {
			await frame();
			const t = Math.min(1, (performance.now() - start) / ms);
			const [x, y] = path(t);
			pointer(svg, moveType, x, y, buttons);
			if (t >= 1) break;
		}
	}

	async function runSession() {
		running = true;
		// A synthetic pointer id has no active pointer: capture throws.
		const capture = Element.prototype.setPointerCapture;
		const release = Element.prototype.releasePointerCapture;
		Element.prototype.setPointerCapture = function (id) {
			try {
				capture.call(this, id);
			} catch {
				// NotFoundError for the synthetic pointer.
			}
		};
		Element.prototype.releasePointerCapture = function (id) {
			try {
				release.call(this, id);
			} catch {
				// As above.
			}
		};
		// The real pointer out of it: a hover of its own would redraw the charts.
		const pointerEvents = document.body.style.pointerEvents;
		document.body.style.pointerEvents = 'none';
		try {
			chart().scrollIntoView({ block: 'center' });
			await sleep(500);
			const r = plotRect();
			const at = (f) => r.left + r.width * f;
			const there = (t) => (t < 0.5 ? t * 2 : 2 - t * 2);
			const svg = foreground();
			const margin = r.bottom + 10;
			const middle = r.top + r.height / 2;

			probe.start();
			performance.mark('fjader:session:m4');
			phase('idle');
			await sleep(1500);

			pointer(svg.closest('.chart-cell') ?? svg, 'pointerenter', at(0.2), middle);
			pointer(svg, 'pointerenter', at(0.2), middle);
			phase('hover');
			await sweep((t) => [at(0.2 + 0.6 * there(t)), middle], 3000, 0);
			await sleep(300);

			phase('pan');
			pointer(svg, moveType, at(0.3), margin, 0);
			// The handlers act on a pointer that has dwelt.
			await sleep(400);
			pointer(svg, 'pointerdown', at(0.3), margin, 1);
			await sweep((t) => [at(0.3 + 0.4 * there(t)), margin], 3000, 1);
			pointer(svg, 'pointerup', at(0.3), margin, 0);
			await sleep(500);

			phase('zoom');
			for (const deltaY of [-100, 100]) {
				for (let i = 0; i < 10; i++) {
					svg.dispatchEvent(
						new WheelEvent('wheel', {
							bubbles: true,
							cancelable: true,
							clientX: at(0.5),
							clientY: margin,
							deltaY
						})
					);
					await sleep(60);
				}
				await sleep(700);
			}
			pointer(svg, 'pointerleave', r.right + 1, r.top - 1);
			pointer(svg.closest('.chart-cell') ?? svg, 'pointerleave', r.right + 1, r.top - 1);

			phase('idle-end');
			await sleep(1000);
			performance.mark('fjader:end:m4');
		} finally {
			probe.stop();
			Element.prototype.setPointerCapture = capture;
			Element.prototype.releasePointerCapture = release;
			document.body.style.pointerEvents = pointerEvents;
			running = false;
			done = true;
		}
		const blob = new Blob(
			[
				JSON.stringify({
					variant: 'm4',
					params: {},
					viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
					userAgent: navigator.userAgent,
					events,
					summary: probe.summarize('idle'),
					probe: probe.toJSON()
				})
			],
			{ type: 'application/json' }
		);
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'm4-session.json';
		a.click();
		URL.revokeObjectURL(a.href);
	}

	onDestroy(() => probe?.destroy());

	onMount(async () => {
		try {
			// Generate a dense time series: 100K points across 3 series
			await queryEngine.exec(`
				CREATE TABLE dense_timeseries AS
				WITH RECURSIVE
					points AS (
						SELECT 0 as idx
						UNION ALL
						SELECT idx + 1 FROM points WHERE idx < 33332
					),
					series AS (
						SELECT 'Series A' as name, 0 as series_id, 0.0 as phase
						UNION ALL
						SELECT 'Series B', 1, 2.094
						UNION ALL
						SELECT 'Series C', 2, 4.189
					)
				SELECT
					s.name as series,
					p.idx * 0.001 as x,
					s.series_id * 2.0 + sin(p.idx * 0.01 + s.phase) + 0.5 * sin(p.idx * 0.05) + 0.1 * random() as y
				FROM points p
				CROSS JOIN series s
			`);

			isLoaded = true;
			await gpuCoordinator.ready;
			await tick();
			probe = new FrameProbe({ mutationRoot: null, device: gpuCoordinator.device });
			probeReady = true;
		} catch (error) {
			console.error('Initialization error:', error);
			loadError = error.message;
		}
	});
</script>

<div class="app-container">
	{#if loadError}
		<div class="status">Error: {loadError}</div>
	{:else if !isLoaded}
		<div class="status">Generating 100K points...</div>
	{:else}
		<p class="session">
			<button disabled={!probeReady || running || done} onclick={runSession}>
				{running
					? 'running…'
					: done
						? 'done: saved m4-session.json (reload to rerun)'
						: 'Run session (12 s)'}
			</button>
			{#if running}<strong>don't move the mouse</strong>{/if}
		</p>
		<MainView />
	{/if}
</div>

<style>
	.app-container {
		width: 100%;
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}
	.session {
		padding: 12px 20px 0;
	}
	.status {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 200px;
		padding: 2rem;
	}
</style>
