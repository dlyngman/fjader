<script>
	import { onMount, onDestroy } from 'svelte';

	let canvas;
	let info = $state('Initializing...');
	let zoom = 1.0;
	let hue = 0;
	let rafId;
	let device;
	let context;
	let format;
	let lastTime = 0;
	let deltas = [];
	let jankCount = 0;
	let frameCount = 0;

	// --- Layer toggles ---
	let showSVG = $state(false);
	let showContainStrict = $state(false);
	let showTranslateZ = $state(false);
	let showWillChange = $state(false);
	let svgTickCount = $state(10);
	let showMSAA = $state(false);

	// Generate fake ticks
	const ticks = $derived(Array.from({ length: svgTickCount }, (_, i) => i * (600 / svgTickCount)));

	onMount(async () => {
		if (!navigator.gpu) {
			info = 'WebGPU not supported';
			return;
		}

		const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
		device = await adapter.requestDevice();
		format = navigator.gpu.getPreferredCanvasFormat();

		context = canvas.getContext('webgpu');
		context.configure({ device, format, alphaMode: 'premultiplied' });

		const dpr = window.devicePixelRatio || 1;
		canvas.width = 800 * dpr;
		canvas.height = 600 * dpr;
		canvas.style.width = '800px';
		canvas.style.height = '600px';

		lastTime = performance.now();
		rafId = requestAnimationFrame(frame);
		info = 'Running — zoom with wheel over the canvas. Toggle layers to find jank source.';
	});

	onDestroy(() => {
		if (rafId) cancelAnimationFrame(rafId);
	});

	function frame(time) {
		rafId = requestAnimationFrame(frame);

		const delta = time - lastTime;
		lastTime = time;
		frameCount++;

		deltas.push(delta);
		if (deltas.length > 360) deltas.shift();

		if (delta > 12.5 && frameCount > 10) {
			jankCount++;
		}

		hue = (hue + zoom * 0.5) % 360;
		const r = hslChannel(hue, 0.6, 0.5, 0);
		const g = hslChannel(hue, 0.6, 0.5, 8);
		const b = hslChannel(hue, 0.6, 0.5, 4);

		const texture = context.getCurrentTexture();
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: texture.createView(),
					loadOp: 'clear',
					storeOp: 'store',
					clearValue: { r, g, b, a: 1 }
				}
			]
		});
		pass.end();
		device.queue.submit([encoder.finish()]);

		if (frameCount % 60 === 0) {
			const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
			const max = Math.max(...deltas.slice(-120));
			const fps = (1000 / avg).toFixed(1);
			info = `FPS: ${fps} | Avg: ${avg.toFixed(2)}ms | Max(1s): ${max.toFixed(2)}ms | Janks: ${jankCount} | Zoom: ${zoom.toFixed(2)}`;
		}
	}

	function hslChannel(h, s, l, offset) {
		const k = (offset + h / 30) % 12;
		const a = s * Math.min(l, 1 - l);
		return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
	}

	function handleWheel(event) {
		event.preventDefault();
		zoom = Math.max(0.1, Math.min(10, zoom * (1 - event.deltaY * 0.001)));
	}

	function resetJanks() {
		jankCount = 0;
		frameCount = 0;
		deltas = [];
	}
</script>

<div class="page">
	<h2>WebGPU Jank Isolation Test</h2>
	<p class="info">{info}</p>

	<div class="controls">
		<label
			><input type="checkbox" bind:checked={showSVG} onchange={resetJanks} /> SVG layers (axis-like elements
			around canvas)</label
		>
		<label
			><input type="checkbox" bind:checked={showContainStrict} onchange={resetJanks} /> contain: strict
			on wrapper</label
		>
		<label
			><input type="checkbox" bind:checked={showTranslateZ} onchange={resetJanks} /> transform: translateZ(0)
			on layers</label
		>
		<label
			><input type="checkbox" bind:checked={showWillChange} onchange={resetJanks} /> will-change: transform
			on layers</label
		>
		{#if showSVG}
			<label
				>SVG ticks: <input type="range" min="0" max="50" bind:value={svgTickCount} />
				{svgTickCount}</label
			>
		{/if}
		<button onclick={resetJanks}>Reset Jank Counter</button>
	</div>

	<!-- Chart-like wrapper (mimics ChartContainer structure) -->
	<div class="chart-wrapper" class:contain-strict={showContainStrict} onwheel={handleWheel}>
		{#if showSVG}
			<!-- SVG background (mimics Grid + axis background) -->
			<svg
				class="svg-bg"
				class:translate-z={showTranslateZ}
				class:will-change-transform={showWillChange}
				width="800"
				height="600"
			>
				{#each ticks as y, i (i)}
					<line x1="0" x2="800" y1={y} y2={y} stroke="#eee" />
				{/each}
				{#each ticks as x, i (i)}
					<line x1={x} x2={x} y1="0" y2="600" stroke="#eee" />
				{/each}
			</svg>
		{/if}

		<div
			class="canvas-layer"
			class:translate-z={showTranslateZ}
			class:will-change-transform={showWillChange}
		>
			<canvas bind:this={canvas}></canvas>
		</div>

		{#if showSVG}
			<!-- SVG foreground (mimics axis ticks + labels) -->
			<svg
				class="svg-fg"
				class:translate-z={showTranslateZ}
				class:will-change-transform={showWillChange}
				width="800"
				height="600"
			>
				<!-- X axis ticks -->
				{#each ticks as x, i (i)}
					<line x1={x} x2={x} y1="600" y2="605" stroke="#999" />
					<text {x} y="618" text-anchor="middle" font-size="10" fill="#666"
						>{(x * zoom).toFixed(0)}</text
					>
				{/each}
				<!-- Y axis ticks -->
				{#each ticks as y, i (i)}
					<line x1="0" x2="-5" y1={y} y2={y} stroke="#999" />
					<text x="-8" y={y + 3} text-anchor="end" font-size="10" fill="#666"
						>{(y * zoom).toFixed(0)}</text
					>
				{/each}
			</svg>
		{/if}
	</div>

	<p class="note">
		Toggle layers one at a time. After each toggle, zoom with wheel and watch the jank counter.<br
		/>
		The layer that causes jank count to increase is the culprit.
	</p>
</div>

<style>
	.page {
		padding: 2rem;
		font-family: system-ui;
	}
	.info {
		font-family: monospace;
		font-size: 14px;
		background: #f0f0f0;
		padding: 8px 12px;
		border-radius: 4px;
		margin: 12px 0;
	}
	.controls {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 16px 0;
		padding: 12px;
		background: #fafafa;
		border: 1px solid #ddd;
		border-radius: 6px;
	}
	.controls label {
		font-size: 14px;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.controls button {
		align-self: flex-start;
		padding: 4px 12px;
		cursor: pointer;
	}
	.chart-wrapper {
		position: relative;
		width: 800px;
		height: 600px;
		border: 1px solid #ccc;
		touch-action: none;
		overscroll-behavior: none;
		isolation: isolate;
	}
	.chart-wrapper.contain-strict {
		contain: strict;
	}
	.svg-bg,
	.svg-fg,
	.canvas-layer {
		position: absolute;
		top: 0;
		left: 0;
	}
	.svg-bg {
		z-index: 1;
	}
	.canvas-layer {
		z-index: 2;
	}
	.svg-fg {
		z-index: 3;
		pointer-events: none;
	}

	.translate-z {
		transform: translateZ(0);
	}
	.will-change-transform {
		will-change: transform;
	}

	canvas {
		display: block;
	}
	.note {
		font-size: 13px;
		color: #666;
		margin-top: 16px;
	}
</style>
