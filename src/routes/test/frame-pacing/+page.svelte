<script>
	import { onMount } from 'svelte';

	// A CONTROL. No Fjader, no WebGPU, no canvas, no data — deliberately nothing to
	// import from $lib. The only question it answers: does this browser deliver frames
	// steadily on this machine, with nothing asked of it?
	//
	// Reached from /test/jank-isolation, where the CSS strip — a compositor-driven
	// animation with no JS at all — also janked. That has two readings, and they need
	// opposite responses:
	//
	//   (a) Chrome's frame pacing is off on this machine. Nothing in Fjader causes it
	//       and nothing in Fjader can fix it.
	//   (b) The chart saturates the GPU process, and everything on the page degrades
	//       with it. Compositor animations survive a busy main thread; they do not
	//       survive a backed-up Viz. That IS a Fjader problem, in the present path.
	//
	// This page reproduces (a) alone. Same strips, same speed, nothing else running.
	//   janks here too      -> (a). Stop looking in this codebase.
	//   smooth here         -> (b). The chart disturbs the compositor; chase the GPU
	//                          process, not the frame callback.
	//
	// Run it in Safari too. Safari being smooth on the same hardware is what made this
	// look like a Fjader bug; if Safari is smooth HERE and Chrome is not, the split is
	// in the browsers' presentation paths, on a page with no application code in it.

	let jsStrip = $state();
	const STRIPE_PX = 80;
	const STRIPE_PX_PER_SEC = 320;

	let p50 = $state(0);
	let p95 = $state(0);
	let worst = $state(0);
	let longGaps = $state(0);
	let frames = $state(0);
	let loafCount = $state(0);
	let loafWorst = $state(0);

	// p50 spacing is the display cadence the browser is actually driving, which is not
	// necessarily the panel's capability — the single most useful number here.
	const inferredHz = $derived(p50 > 0 ? Math.round(1000 / p50) : 0);

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
		worst = 0;
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
			if (d > worst) worst = d;
			frames++;

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
			// Not Chrome 123+. The strips still work.
		}

		return () => {
			cancelAnimationFrame(rafId);
			observer?.disconnect();
		};
	});
</script>

<div class="page">
	<h2>Frame Pacing Control</h2>
	<p>
		No Fjader, no WebGPU, no canvas. If these strips jank here, the jank is not coming from this
		codebase. Run it in Safari as well as Chrome.
	</p>

	<div class="readout">
		<span>frames <strong>{frames}</strong></span>
		<span>p50 <strong>{p50.toFixed(2)}ms</strong></span>
		<span>&asymp; <strong>{inferredHz}Hz</strong></span>
		<span>p95 <strong>{p95.toFixed(2)}ms</strong></span>
		<span>worst <strong>{worst.toFixed(1)}ms</strong></span>
		<span>gaps &gt;1.5&times;p50 <strong>{longGaps}</strong></span>
		<span>LoAF <strong>{loafCount}</strong> (worst {loafWorst.toFixed(0)}ms)</span>
		<button onclick={reset}>reset</button>
	</div>
	<p class="note">
		If the inferred Hz is not what the panel is set to, that is the whole story. Check
		<code>chrome://gpu</code>, then macOS Displays, then Low Power Mode and battery — macOS drops
		ProMotion refresh on battery, and Chrome and Safari do not respond to it identically.
	</p>

	<div class="strip-label">CSS strip — compositor only, zero JS. The floor.</div>
	<div class="strip"><div class="stripe css-driven"></div></div>

	<div class="strip-label">JS strip — same motion, written from rAF.</div>
	<div class="strip"><div class="stripe" bind:this={jsStrip}></div></div>
</div>

<style>
	.page {
		padding: 1rem;
		font-family: system-ui;
	}

	p {
		color: #666;
		font-size: 13px;
		max-width: 70ch;
	}

	.note {
		font-size: 12px;
	}

	.readout {
		display: flex;
		gap: 16px;
		align-items: center;
		margin: 12px 0;
		padding: 8px 12px;
		background: #f5f5f5;
		border-radius: 6px;
		font-size: 13px;
		font-variant-numeric: tabular-nums;
	}

	.strip {
		height: 22px;
		margin: 6px 0 14px;
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
		font-size: 12px;
		color: #666;
	}
</style>
