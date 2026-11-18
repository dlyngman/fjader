<script>
	/**
	 * HTML-in-Canvas probe (proposal_gpu_text.md, phase 0 V1): what this browser
	 * actually exposes, checked by using it rather than by reading about it.
	 *
	 * 1. Detection: the API surface on each prototype, plus every member whose
	 *    name mentions "Element" on GPUQueue and HTMLCanvasElement, so a rename
	 *    shows up as a new name rather than as a missing one.
	 * 2. WebGPU host: a canvas configured for `webgpu` hosts a drawable label.
	 *    In its `paint` handler, `queue.drawElementImageToTexture` draws the
	 *    label into an rgba8unorm texture and into the canvas's own texture (so
	 *    it is visible). The texture is read back and its painted pixels counted.
	 *    Then the same call outside `paint`, a text change and a style change
	 *    (does `paint` fire, with the label in `changedElements`?), and the
	 *    raster scale (default size against CSS size).
	 * 3. 2D fallback: the same label drawn with `drawElementImage` into a 2D
	 *    canvas, then copied to a GPU texture with `copyExternalImageToTexture`.
	 * 4. Atlas: a CSS-laid-out container of 300 strings (flex-wrap) drawn into
	 *    one texture; each sampled string's layout box must hold painted pixels
	 *    at its place in the texture. Plus a first timing: DOM change → paint →
	 *    upload done, for all 300 and for 20 changed.
	 *
	 * Results render below; Save results downloads them as JSON.
	 */
	import { onMount, tick } from 'svelte';

	let results = $state([]);
	let finished = $state(false);
	let gpuCanvas = $state();
	let gpuLabel = $state();
	let atlas = $state();
	let canvas2d = $state();
	let label2d = $state();

	const LABEL = 'Delay 12.3k · ÅÄÖ 東京 ✈';
	const ATLAS_COUNT = 300;
	let atlasStrings = $state(
		Array.from({ length: ATLAS_COUNT }, (_, i) =>
			i % 3 === 0 ? `${(i * 137) % 9973}` : i % 3 === 1 ? `cat-${i}` : `${(i * 7.3).toFixed(1)}k`
		)
	);

	function rec(name, ok, detail = '') {
		results = [...results, { name, ok, detail: String(detail) }];
	}

	const frame = () => new Promise((r) => requestAnimationFrame(r));

	/** Members of a prototype chain whose names match `re`. */
	function membersMatching(proto, re) {
		const names = new Set();
		for (let p = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
			for (const n of Object.getOwnPropertyNames(p)) if (re.test(n)) names.add(n);
		}
		return [...names].sort();
	}

	/** Painted pixels (alpha > 0) in a texture, in all and inside each rect. */
	async function readback(device, texture, w, h, rects = []) {
		const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
		const buffer = device.createBuffer({
			size: bytesPerRow * h,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
		const encoder = device.createCommandEncoder();
		encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [w, h]);
		device.queue.submit([encoder.finish()]);
		await buffer.mapAsync(GPUMapMode.READ);
		const data = new Uint8Array(buffer.getMappedRange());
		let painted = 0;
		let minX = w,
			minY = h,
			maxX = -1,
			maxY = -1;
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				if (data[y * bytesPerRow + x * 4 + 3] > 0) {
					painted++;
					if (x < minX) minX = x;
					if (x > maxX) maxX = x;
					if (y < minY) minY = y;
					if (y > maxY) maxY = y;
				}
			}
		}
		const inRects = rects.map(([x0, y0, x1, y1]) => {
			let n = 0;
			for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
				for (let x = Math.max(0, x0); x < Math.min(w, x1); x++)
					if (data[y * bytesPerRow + x * 4 + 3] > 0) n++;
			return n;
		});
		buffer.unmap();
		buffer.destroy();
		return { painted, bbox: maxX < 0 ? null : [minX, minY, maxX + 1, maxY + 1], inRects };
	}

	function makeTexture(device, w, h) {
		return device.createTexture({
			size: [w, h],
			format: 'rgba8unorm',
			usage:
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.RENDER_ATTACHMENT
		});
	}

	/** Size the canvas backing store to its CSS box at device pixels. */
	function sizeBacking(canvas) {
		const r = canvas.getBoundingClientRect();
		canvas.width = Math.round(r.width * devicePixelRatio);
		canvas.height = Math.round(r.height * devicePixelRatio);
		return { w: canvas.width, h: canvas.height };
	}

	/**
	 * Resolves with the next `paint` event on `canvas` (or null after `ms`),
	 * running `inside(event)` within the handler: drawing must happen there.
	 */
	function nextPaint(canvas, inside = () => {}, ms = 1500) {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				canvas.onpaint = null;
				resolve(null);
			}, ms);
			canvas.onpaint = (event) => {
				clearTimeout(timer);
				canvas.onpaint = null;
				let error = null;
				try {
					inside(event);
				} catch (e) {
					error = e;
				}
				resolve({ event, error });
			};
		});
	}

	/** The opt-in, both spellings: `content="drawable"` (157+) and `layoutsubtree` (before). */
	function optIn(canvas) {
		canvas.setAttribute('content', 'drawable');
		canvas.setAttribute('layoutsubtree', '');
	}

	async function run() {
		// --- 1. Detection -------------------------------------------------------
		const has = (proto, name) => !!proto && name in proto;
		const C2D = globalThis.CanvasRenderingContext2D?.prototype;
		const O2D = globalThis.OffscreenCanvasRenderingContext2D?.prototype;
		const GQ = globalThis.GPUQueue?.prototype;
		const GL2 = globalThis.WebGL2RenderingContext?.prototype;
		const HC = globalThis.HTMLCanvasElement?.prototype;
		rec('2D drawElementImage', has(C2D, 'drawElementImage'));
		rec('OffscreenCanvas 2D drawElementImage', has(O2D, 'drawElementImage'));
		rec('GPUQueue.drawElementImageToTexture', has(GQ, 'drawElementImageToTexture'));
		rec('WebGL2 texElementSubImage2D', has(GL2, 'texElementSubImage2D'));
		for (const m of [
			'requestPaint',
			'getElementImageDefaultSize',
			'captureElementImage',
			'updateElementGeometry',
			'getElementTransform',
			'onpaint'
		])
			rec(`HTMLCanvasElement.${m}`, has(HC, m));
		rec('GPUQueue members matching /element/i', true, membersMatching(GQ, /element/i).join(', '));
		rec(
			'HTMLCanvasElement members matching /element|paint|content|layout/i',
			true,
			membersMatching(HC, /element|paint|content|layout/i).join(', ')
		);
		rec(
			'Chrome version',
			true,
			navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent
		);

		if (!navigator.gpu) {
			rec('WebGPU', false, 'navigator.gpu missing');
			return;
		}
		const adapter = await navigator.gpu.requestAdapter();
		const device = await adapter.requestDevice();

		// --- 2. WebGPU host ----------------------------------------------------
		optIn(gpuCanvas);
		const { w, h } = sizeBacking(gpuCanvas);
		const ctx = gpuCanvas.getContext('webgpu');
		const format = navigator.gpu.getPreferredCanvasFormat();
		ctx.configure({
			device,
			format,
			alphaMode: 'premultiplied',
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST
		});
		const target = makeTexture(device, w, h);
		const canDrawGPU = has(GQ, 'drawElementImageToTexture');

		let size = null;
		const draw = (texture) => {
			size = gpuCanvas.getElementImageDefaultSize?.(gpuLabel) ?? null;
			const sw = Math.max(1, Math.min(w, Math.ceil(size?.width ?? w)));
			const sh = Math.max(1, Math.min(h, Math.ceil(size?.height ?? h)));
			device.queue.drawElementImageToTexture({ source: gpuLabel }, { texture, size: [sw, sh] });
		};

		gpuCanvas.requestPaint?.();
		const first = await nextPaint(gpuCanvas, () => {
			if (!canDrawGPU) return;
			draw(target);
			draw(ctx.getCurrentTexture());
		});
		rec('WebGPU host: paint fires', !!first, first ? '' : 'no paint within 1.5 s');
		if (first) {
			rec(
				'WebGPU host: paint.changedElements has the label',
				!!first.event.changedElements?.includes?.(gpuLabel),
				`changedElements: ${first.event.changedElements?.length ?? 'missing'}`
			);
			rec(
				'WebGPU host: drawElementImageToTexture inside paint',
				canDrawGPU && !first.error,
				first.error ? `${first.error.name}: ${first.error.message}` : ''
			);
		}
		if (canDrawGPU && first && !first.error) {
			await device.queue.onSubmittedWorkDone();
			const rb = await readback(device, target, w, h);
			rec(
				'WebGPU host: texture has painted pixels',
				rb.painted > 0,
				`${rb.painted} px, bbox ${JSON.stringify(rb.bbox)}`
			);
			const css = gpuLabel.getBoundingClientRect();
			rec(
				'WebGPU host: raster scale (default size / CSS size)',
				!!size,
				size
					? `default ${size.width.toFixed(1)}×${size.height.toFixed(1)}, CSS ${css.width.toFixed(1)}×${css.height.toFixed(1)}, ratio ${(size.width / css.width).toFixed(3)}, devicePixelRatio ${devicePixelRatio}`
					: 'getElementImageDefaultSize missing'
			);

			// Outside paint, once a snapshot exists.
			try {
				const t2 = makeTexture(device, w, h);
				draw(t2);
				await device.queue.onSubmittedWorkDone();
				const rb2 = await readback(device, t2, w, h);
				t2.destroy();
				rec(
					'WebGPU host: drawElementImageToTexture outside paint',
					rb2.painted > 0,
					`${rb2.painted} px`
				);
			} catch (e) {
				rec(
					'WebGPU host: drawElementImageToTexture outside paint',
					false,
					`${e.name}: ${e.message}`
				);
			}

			// A text change: paint fires again, with the label changed.
			const textPaint = nextPaint(gpuCanvas);
			gpuLabel.textContent = 'Changed 98.7k';
			const tp = await textPaint;
			rec(
				'WebGPU host: paint fires on text change',
				!!tp?.event.changedElements?.includes?.(gpuLabel),
				tp ? `changedElements: ${tp.event.changedElements?.length}` : 'no paint'
			);

			// A style change (colour, as a theme switch would make).
			const stylePaint = nextPaint(gpuCanvas);
			// Inline: a class Svelte never sees in markup has its rule pruned.
			gpuLabel.style.color = '#b91c1c';
			const sp = await stylePaint;
			rec(
				'WebGPU host: paint fires on style change',
				!!sp?.event.changedElements?.includes?.(gpuLabel),
				sp ? `changedElements: ${sp.event.changedElements?.length}` : 'no paint'
			);
		}

		// --- 3. 2D fallback ----------------------------------------------------
		if (has(C2D, 'drawElementImage')) {
			optIn(canvas2d);
			const s2 = sizeBacking(canvas2d);
			const c2 = canvas2d.getContext('2d');
			canvas2d.requestPaint?.();
			const p2 = await nextPaint(canvas2d, () => {
				c2.clearRect(0, 0, s2.w, s2.h);
				c2.drawElementImage(label2d, 0, 0);
			});
			rec(
				'2D host: drawElementImage inside paint',
				!!p2 && !p2.error,
				!p2 ? 'no paint' : p2.error ? `${p2.error.name}: ${p2.error.message}` : ''
			);
			if (p2 && !p2.error) {
				const t3 = makeTexture(device, s2.w, s2.h);
				try {
					device.queue.copyExternalImageToTexture({ source: canvas2d }, { texture: t3 }, [
						s2.w,
						s2.h
					]);
					await device.queue.onSubmittedWorkDone();
					const rb3 = await readback(device, t3, s2.w, s2.h);
					rec(
						'2D host → copyExternalImageToTexture: painted pixels',
						rb3.painted > 0,
						`${rb3.painted} px, bbox ${JSON.stringify(rb3.bbox)}`
					);
				} catch (e) {
					rec('2D host → copyExternalImageToTexture', false, `${e.name}: ${e.message}`);
				}
				t3.destroy();
			}
		}

		// --- 4. Atlas ------------------------------------------------------------
		if (canDrawGPU) {
			// Sized at draw time from the laid-out container: a change can wrap
			// it onto a new row, and a texture sized before would cut that off.
			let tA = null;
			const drawAtlas = () => {
				const sz = gpuCanvas.getElementImageDefaultSize(atlas);
				const tw = Math.min(4096, Math.ceil(sz.width));
				const th = Math.min(4096, Math.ceil(sz.height));
				if (!tA || tA.width < tw || tA.height < th) {
					tA?.destroy();
					tA = makeTexture(device, tw, th);
				}
				device.queue.drawElementImageToTexture(
					{ source: atlas },
					{
						texture: tA,
						size: [
							Math.min(tA.width, Math.ceil(sz.width)),
							Math.min(tA.height, Math.ceil(sz.height))
						]
					}
				);
				return sz;
			};
			// Full: every string new.
			const t0 = performance.now();
			const full = nextPaint(gpuCanvas, () => drawAtlas());
			atlasStrings = atlasStrings.map((s) => `${s}·`);
			await tick();
			const pf = await full;
			await device.queue.onSubmittedWorkDone();
			const fullMs = performance.now() - t0;
			if (!pf || pf.error) {
				rec('Atlas: draw 300 strings', false, pf?.error ? `${pf.error.message}` : 'no paint');
			} else {
				// Sampled strings: each one's layout box, in texture pixels, must be painted.
				const sz = gpuCanvas.getElementImageDefaultSize(atlas);
				const box = atlas.getBoundingClientRect();
				const scale = sz.width / box.width;
				const spans = atlas.querySelectorAll('span');
				const sample = [0, 1, 2, 57, 123, 150, 199, 250, 298, 299].filter((i) => i < spans.length);
				const rects = sample.map((i) => {
					const r = spans[i].getBoundingClientRect();
					return [
						Math.floor((r.left - box.left) * scale),
						Math.floor((r.top - box.top) * scale),
						Math.ceil((r.right - box.left) * scale),
						Math.ceil((r.bottom - box.top) * scale)
					];
				});
				const rb4 = await readback(device, tA, tA.width, tA.height, rects);
				const empty = sample.filter((_, k) => rb4.inRects[k] === 0);
				rec(
					'Atlas: sampled strings painted at their layout boxes',
					empty.length === 0 && rb4.painted > 0,
					`scale ${scale.toFixed(3)}, texture ${tA.width}×${tA.height}, ${rb4.painted} px painted; empty boxes: ${empty.length ? empty.join(', ') : 'none'}`
				);
				// Changed: 20 strings.
				const t1 = performance.now();
				const part = nextPaint(gpuCanvas, () => drawAtlas());
				atlasStrings = atlasStrings.map((s, i) => (i % 15 === 0 ? `${s}!` : s));
				await tick();
				const pp = await part;
				await device.queue.onSubmittedWorkDone();
				const partMs = performance.now() - t1;
				rec(
					'Atlas: first timing (DOM change → paint → upload done)',
					!!pp && !pp.error,
					`300 changed: ${fullMs.toFixed(1)} ms; 20 changed: ${partMs.toFixed(1)} ms (includes waiting for the next frame); changedElements on the 20: ${pp?.event.changedElements?.length}`
				);
			}
			tA?.destroy();
		}
		target.destroy();
	}

	onMount(async () => {
		await tick();
		await frame();
		try {
			await run();
		} catch (e) {
			rec('probe', false, `${e.name}: ${e.message}`);
		}
		finished = true;
	});

	function save() {
		const blob = new Blob(
			[JSON.stringify({ userAgent: navigator.userAgent, devicePixelRatio, results }, null, 2)],
			{ type: 'application/json' }
		);
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'html-in-canvas-probe.json';
		a.click();
		URL.revokeObjectURL(a.href);
	}
</script>

<svelte:head><title>HTML-in-Canvas probe</title></svelte:head>

<div class="page">
	<h1>HTML-in-Canvas probe</h1>
	<p>
		{finished ? 'Done.' : 'Running…'}
		<button disabled={!finished} onclick={save}>Save results</button>
	</p>

	<table>
		<tbody>
			{#each results as r, i (i)}
				<tr>
					<td class:ok={r.ok} class:fail={!r.ok}>{r.ok ? 'yes' : 'no'}</td>
					<td>{r.name}</td>
					<td class="detail">{r.detail}</td>
				</tr>
			{/each}
		</tbody>
	</table>

	<div class="surfaces">
		<div>
			<h2>WebGPU canvas (label drawn into its texture)</h2>
			<canvas class="host" bind:this={gpuCanvas}>
				<div class="label" drawable="" bind:this={gpuLabel}>{LABEL}</div>
				<div class="atlas" drawable="" bind:this={atlas}>
					{#each atlasStrings as s, i (i)}<span>{s}</span>{/each}
				</div>
			</canvas>
		</div>
		<div>
			<h2>2D canvas (drawElementImage)</h2>
			<canvas class="host2d" bind:this={canvas2d}>
				<div class="label" drawable="" bind:this={label2d}>{LABEL}</div>
			</canvas>
		</div>
	</div>
</div>

<style>
	.page {
		padding: 1rem;
		font-family: system-ui, sans-serif;
	}
	table {
		border-collapse: collapse;
		font-size: 13px;
		margin-bottom: 1rem;
	}
	td {
		padding: 2px 10px;
		border-bottom: 1px solid #eee;
		vertical-align: top;
	}
	.ok {
		color: #15803d;
		font-weight: 600;
	}
	.fail {
		color: #b00020;
		font-weight: 600;
	}
	.detail {
		font-family: ui-monospace, monospace;
		font-size: 12px;
		color: #444;
		max-width: 80ch;
	}
	.surfaces {
		display: flex;
		gap: 24px;
		flex-wrap: wrap;
	}
	h2 {
		font-size: 13px;
	}
	.host {
		width: 720px;
		height: 320px;
		border: 1px solid #ccc;
	}
	.host2d {
		width: 360px;
		height: 80px;
		border: 1px solid #ccc;
	}
	.label {
		font:
			600 14px system-ui,
			sans-serif;
		color: #1f2937;
		width: max-content;
	}
	.atlas {
		width: 700px;
		display: flex;
		flex-wrap: wrap;
		gap: 2px 6px;
		font:
			11px system-ui,
			sans-serif;
		color: #111;
	}
</style>
