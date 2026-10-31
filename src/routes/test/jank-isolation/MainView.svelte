<script>
	import { min, avg } from '@uwdata/mosaic-sql';
	import { onMount } from 'svelte';
	import {
		ChartContainer,
		Grid,
		Frame,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		WebGPUCanvas,
		DotsMark
	} from '$lib/components';

	// Toggle SVG layers to isolate jank source — judge VISUALLY, not by metrics.
	//
	// The background layer (axes, frame, labels) sits BELOW the canvas at z-index 1;
	// the foreground layer (crosshair, hover indicator, interaction rect) sits ABOVE
	// it at z-index 3. Both repaint while the domain moves.
	//
	// `bgMode` walks a ladder that removes one kind of per-frame work at a time, so
	// whichever rung goes smooth names the cost:
	//
	//   visible  — Svelte writes tick attrs, layout runs, layer paints
	//   hidden   — visibility:hidden. Attrs still written, layout still runs, NO paint
	//   none     — display:none. Attrs still written, no layout, no paint
	//   removed  — {#if} false. Nothing at all
	//
	// visible -> hidden isolates paint/composite. hidden -> none isolates layout.
	// none -> removed isolates the Svelte reactive work itself.
	let bgMode = $state('visible');

	// The foreground carries the wheel/pointer handlers on its root <svg>, so it only
	// gets two rungs — display:none or {#if} would make the chart uninteractive and
	// there would be nothing to pan. In `hidden` the interaction rect is explicitly
	// re-shown (a visible child of a hidden parent still hit-tests) so panning keeps
	// working with nothing painted.
	let fgMode = $state('visible');

	// Candidate fix rather than a bisect: give each SVG its own compositing layer so
	// its repaint stops invalidating the shared one.
	let promote = $state(false);

	let showGrid = $state(true);
	let showCrosshair = $state(true);

	const modes = ['visible', 'hidden', 'none', 'removed'];

	// --- Reference strips -------------------------------------------------------
	//
	// "Is this smooth?" is an absolute judgment and the eye is bad at it, which is why
	// every rung of the ladder above feels the same. These give the same question a
	// reference to answer it against, in the same viewport, at the same instant:
	//
	//   CSS strip — @keyframes on a transform. No JS, no rAF; the compositor animates
	//                it off the main thread. This is the machine's smoothness FLOOR.
	//   JS strip  — same motion, same transform, written from a rAF callback. Adds
	//                main-thread scheduling and nothing else. No GPU work.
	//
	// Both are repeating 80px stripe patterns, which make a dropped frame read as a
	// visible jump rather than a vague feeling. Pan the chart and watch all three.
	//
	//   all three smooth ............ not reproducing right now
	//   chart janks, both strips OK .. the WebGPU present path, not your frame work
	//   chart + JS strip jank ........ main-thread scheduling
	//   all three jank ............... browser/display pacing; nothing in Fjader
	//
	// The last case is the one worth ruling out first: it means no change to this
	// codebase can fix it, and everything measured so far is consistent with it.
	let jsStrip = $state();
	const STRIPE_PX = 80;
	const STRIPE_PX_PER_SEC = 320;

	// --- Frame delivery readout -------------------------------------------------
	//
	// NOT the thing a clean DevTools rAF trace already told us. That shows callback
	// OCCUPANCY (how long the callback ran). This shows callback SPACING (whether the
	// browser called us on a steady cadence at all) — a different axis, and the one
	// that speaks to delivery. Uniform spacing plus visible judder isolates the
	// problem to presentation, after the callback returns.
	//
	// Long Animation Frames (Chrome 123+) covers the rest of the frame lifecycle:
	// style, layout, paint and pre-paint work that lands outside any rAF block.
	let p50 = $state(0);
	let p95 = $state(0);
	let longGaps = $state(0);
	let frames = $state(0);
	let loafCount = $state(0);
	let loafWorst = $state(0);

	let deltas = [];
	let lastTs = 0;
	let rafId = 0;
	let observer;

	function reset() {
		deltas = [];
		lastTs = 0;
		frames = 0;
		longGaps = 0;
		p50 = 0;
		p95 = 0;
		loafCount = 0;
		loafWorst = 0;
	}

	function tick(ts) {
		rafId = requestAnimationFrame(tick);

		if (jsStrip) {
			const offset = ((ts / 1000) * STRIPE_PX_PER_SEC) % STRIPE_PX;
			jsStrip.style.transform = `translateX(${-offset}px)`;
		}

		if (lastTs) {
			const d = ts - lastTs;
			deltas.push(d);
			if (deltas.length > 600) deltas.shift();
			frames++;

			// Recompute on a slow cadence — this readout must not become the jank.
			if (frames % 30 === 0) {
				const sorted = [...deltas].sort((a, b) => a - b);
				p50 = sorted[Math.floor(sorted.length * 0.5)];
				p95 = sorted[Math.floor(sorted.length * 0.95)];
				longGaps = deltas.filter((x) => x > p50 * 1.5).length;
			}
		}
		lastTs = ts;
	}

	onMount(() => {
		rafId = requestAnimationFrame(tick);

		try {
			observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					loafCount++;
					if (entry.duration > loafWorst) loafWorst = entry.duration;
				}
			});
			observer.observe({ type: 'long-animation-frame', buffered: true });
		} catch {
			// Not Chrome 123+, or the entry type is unavailable. The strips still work.
		}

		return () => {
			cancelAnimationFrame(rafId);
			observer?.disconnect();
		};
	});
</script>

<div style="padding: 1rem; font-family: system-ui;">
	<h2>Jank Isolation — Real rendering pipeline, toggleable SVG</h2>
	<p style="color: #666; font-size: 13px;">
		Pan by dragging, zoom with the wheel. Judge smoothness VISUALLY — or open DevTools &rarr;
		Rendering &rarr; <strong>Frame Rendering Stats</strong> for the compositor's own dropped-frame count,
		which is not the same thing as the rAF cadence.
	</p>
	<p style="color: #666; font-size: 13px;">
		Walk <strong>Background</strong> down the ladder while panning. The rung where it goes smooth
		names the cost: <em>visible&rarr;hidden</em> = paint/composite,
		<em>hidden&rarr;none</em> = layout, <em>none&rarr;removed</em> = Svelte reactive work.
	</p>

	<div class="controls">
		<span class="group">
			<strong>Background</strong> (axes, frame — below canvas)
			{#each modes as mode}
				<label><input type="radio" bind:group={bgMode} value={mode} /> {mode}</label>
			{/each}
		</span>
	</div>
	<div class="controls">
		<span class="group">
			<strong>Foreground</strong> (crosshair, interaction — above canvas)
			<label><input type="radio" bind:group={fgMode} value="visible" /> visible</label>
			<label><input type="radio" bind:group={fgMode} value="hidden" /> hidden</label>
		</span>
	</div>
	<div class="controls">
		<label
			><input type="checkbox" bind:checked={promote} /> Promote both SVGs to their own layer</label
		>
		<label><input type="checkbox" bind:checked={showGrid} /> Grid (GPU)</label>
		<label><input type="checkbox" bind:checked={showCrosshair} /> Crosshair</label>
	</div>

	<div class="controls readout">
		<span>frames <strong>{frames}</strong></span>
		<span>spacing p50 <strong>{p50.toFixed(2)}ms</strong></span>
		<span>p95 <strong>{p95.toFixed(2)}ms</strong></span>
		<span>gaps &gt;1.5&times;p50 <strong>{longGaps}</strong></span>
		<span>LoAF <strong>{loafCount}</strong> (worst {loafWorst.toFixed(0)}ms)</span>
		<button onclick={reset}>reset</button>
	</div>
	<p style="color: #666; font-size: 12px; margin: 4px 0 0;">
		Spacing is <em>not</em> callback duration — it is whether the browser called us on a steady cadence.
		Even p50/p95 with visible judder points past the callback, at presentation.
	</p>
</div>

<div class="strip-label">CSS strip — compositor only, no JS. The smoothness floor.</div>
<div class="strip"><div class="stripe css-driven"></div></div>

<div
	class="chart-wrapper"
	class:bg-hidden={bgMode === 'hidden'}
	class:bg-none={bgMode === 'none'}
	class:fg-hidden={fgMode === 'hidden'}
	class:promote
>
	<ChartContainer xLabel="delay" yLabel="time">
		{#snippet background()}
			{#if bgMode !== 'removed'}
				<Frame />
				<AxisLeft />
				<AxisBottom />
				<MarginLabel />
			{/if}
		{/snippet}

		{#snippet canvas()}
			<WebGPUCanvas>
				{#snippet canvasComponents()}
					{#if showGrid}<Grid />{/if}
					<DotsMark table="flights" x={min('delay')} y="time" fill={avg('delay')} opacity="0.8" />
				{/snippet}
			</WebGPUCanvas>
		{/snippet}

		{#snippet foreground()}
			{#if showCrosshair}<Crosshair />{/if}
		{/snippet}
	</ChartContainer>
</div>

<div class="strip"><div class="stripe" bind:this={jsStrip}></div></div>
<div class="strip-label">
	JS strip — same motion, written from rAF. Adds main-thread scheduling.
</div>

<style>
	.strip {
		height: 22px;
		margin: 6px 0;
		overflow: hidden;
		border-radius: 3px;
		background: #eee;
	}

	.stripe {
		height: 100%;
		width: calc(100% + 80px);
		will-change: transform;
		background: repeating-linear-gradient(90deg, #3b82f6 0 40px, #dbeafe 40px 80px);
	}

	.css-driven {
		animation: slide 0.25s linear infinite;
	}

	@keyframes slide {
		from {
			transform: translateX(0);
		}
		to {
			transform: translateX(-80px);
		}
	}

	.strip-label {
		font-family: system-ui;
		font-size: 12px;
		color: #666;
		padding: 0 1rem;
	}

	.readout {
		font-variant-numeric: tabular-nums;
		font-size: 13px;
	}

	.controls {
		display: flex;
		gap: 16px;
		margin: 8px 0;
		padding: 8px 12px;
		background: #f5f5f5;
		border-radius: 6px;
		font-size: 14px;
		align-items: center;
	}

	.group {
		display: flex;
		gap: 10px;
		align-items: center;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4/3;
		min-height: 200px;
		max-height: 600px;
	}

	.chart-wrapper.bg-hidden :global(.svg-background) {
		visibility: hidden;
	}

	.chart-wrapper.bg-none :global(.svg-background) {
		display: none;
	}

	/* The root <svg> carries the wheel/pointer handlers, so it stays hit-testable:
	   a visible child of a hidden parent paints and hit-tests normally, and the
	   interaction rect is fill="transparent" so nothing becomes visible. */
	.chart-wrapper.fg-hidden :global(.svg-foreground) {
		visibility: hidden;
	}

	.chart-wrapper.fg-hidden :global(.svg-foreground .interaction-target) {
		visibility: visible;
	}

	.chart-wrapper.promote :global(.svg-background),
	.chart-wrapper.promote :global(.svg-foreground) {
		will-change: transform;
	}
</style>
