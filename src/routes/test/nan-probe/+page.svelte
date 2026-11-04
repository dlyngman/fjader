<script lang="ts">
	import { onMount } from 'svelte';

	/**
	 * Does `v != v` find a NaN on this GPU?
	 *
	 * WGSL assumes floats are finite, so a shader compiler may fold `v != v` to
	 * false. fjader sends nulls to the GPU as NaN and finds them that way: M4
	 * decimation marks empty bins with NaN and compacts them out, and the line,
	 * area, colour and size shaders all skip or recolour NaN. Where the check is
	 * folded, M4 keeps the empty bins and the lines lose every segment touching
	 * one.
	 *
	 * Deliberately standalone. No coordinator, no scales, no marks: a buffer of
	 * known bit patterns, each check run on each value, in a compute shader (as
	 * M4 runs) and in a vertex shader (as the line shader runs), read back.
	 *
	 * The u32 column reads the same bytes through an array<u32> binding and
	 * tests the bit pattern. It never loads the value as a float, so it is the
	 * reference the other columns are judged against.
	 */

	const ROWS: { label: string; bits: number | null; nan: boolean }[] = [
		{ label: 'NaN 0x7FC00000', bits: 0x7fc00000, nan: true },
		{ label: '−NaN 0xFFC00000', bits: 0xffc00000, nan: true },
		{ label: 'sNaN 0x7F800001', bits: 0x7f800001, nan: true },
		{ label: '+Inf 0x7F800000', bits: 0x7f800000, nan: false },
		{ label: '1.0', bits: 0x3f800000, nan: false },
		{ label: '0.0', bits: 0x00000000, nan: false },
		// Computed in the shader from the 0.0 above, so it is a NaN the compiler
		// cannot see in a buffer. Its u32 cell reads the bits after the divide.
		{ label: '0.0 / 0.0 (computed)', bits: null, nan: true }
	];

	const METHODS = ['v != v', 'isNaN(v) fn', '!(v == v)', 'bits of f32', 'u32 view (reference)'];

	const LOADED = ROWS.filter((r) => r.bits !== null).length;
	const CELLS = ROWS.length * METHODS.length;
	const EXPECTED_KEPT = ROWS.filter((r) => r.bits !== null && !r.nan).length;

	const SHARED = /* wgsl */ `
		@group(0) @binding(0) var<storage, read> vf: array<f32>;
		@group(0) @binding(1) var<storage, read> vu: array<u32>;

		// The same function the line, area and parallel shaders define.
		fn isNaN(v: f32) -> bool {
			return v != v;
		}

		fn bitsNaN(u: u32) -> bool {
			return (u & 0x7fffffffu) > 0x7f800000u;
		}

		fn check(row: u32, method: u32) -> u32 {
			var f: f32;
			var u: u32;
			if (row < ${LOADED}u) {
				f = vf[row];
				u = vu[row];
			} else {
				f = vf[5] / vf[5];
				u = bitcast<u32>(f);
			}
			var r = false;
			switch (method) {
				case 0u: { r = f != f; }
				case 1u: { r = isNaN(f); }
				case 2u: { r = !(f == f); }
				case 3u: { r = bitsNaN(bitcast<u32>(f)); }
				default: { r = bitsNaN(u); }
			}
			return select(0u, 1u, r);
		}
	`;

	const COMPUTE = /* wgsl */ `
		${SHARED}
		@group(0) @binding(2) var<storage, read_write> outv: array<u32>;

		@compute @workgroup_size(1)
		fn main() {
			for (var i = 0u; i < ${CELLS}u; i++) {
				outv[i] = check(i / ${METHODS.length}u, i % ${METHODS.length}u);
			}

			// M4's compact pass, as written: skip NaN with continue, count the rest.
			var keptFloat = 0u;
			for (var i = 0u; i < ${LOADED}u; i++) {
				let x = vf[i];
				if (x != x) { continue; }
				keptFloat++;
			}
			// The same loop on the bit pattern.
			var keptBits = 0u;
			for (var i = 0u; i < ${LOADED}u; i++) {
				if (bitsNaN(vu[i])) { continue; }
				keptBits++;
			}
			outv[${CELLS}u] = keptFloat;
			outv[${CELLS + 1}u] = keptBits;
		}
	`;

	// One point per cell, at its own pixel. The vertex shader does the check
	// and hands the answer to the fragment flat; green marks a written pixel so
	// an untouched one cannot read as "not NaN".
	const RENDER = /* wgsl */ `
		${SHARED}

		struct VOut {
			@builtin(position) pos: vec4<f32>,
			@location(0) @interpolate(flat) result: u32,
		};

		@vertex
		fn vs(@builtin(vertex_index) i: u32) -> VOut {
			var o: VOut;
			let x = (f32(i) + 0.5) / f32(${CELLS}u) * 2.0 - 1.0;
			o.pos = vec4<f32>(x, 0.0, 0.0, 1.0);
			o.result = check(i / ${METHODS.length}u, i % ${METHODS.length}u);
			return o;
		}

		@fragment
		fn fs(v: VOut) -> @location(0) vec4<f32> {
			return vec4<f32>(f32(v.result), 1.0, 0.0, 1.0);
		}
	`;

	type Grid = (boolean | null)[][];

	let info = $state<string[]>([]);
	let compute = $state<Grid | null>(null);
	let vertex = $state<Grid | null>(null);
	let kept = $state<{ float: number; bits: number } | null>(null);
	let verdict = $state<string | null>(null);
	let failed = $state<string | null>(null);
	let running = $state(false);

	function toGrid(flags: (boolean | null)[]): Grid {
		return ROWS.map((_, r) => METHODS.map((_, m) => flags[r * METHODS.length + m]));
	}

	function inputBuffer(device: GPUDevice): GPUBuffer {
		const words = new Uint32Array(LOADED);
		ROWS.forEach((r, i) => {
			if (r.bits !== null) words[i] = r.bits;
		});
		const buffer = device.createBuffer({
			size: words.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			label: 'nan-probe-input'
		});
		device.queue.writeBuffer(buffer, 0, words);
		return buffer;
	}

	async function runCompute(device: GPUDevice, input: GPUBuffer) {
		const size = (CELLS + 2) * 4;
		const out = device.createBuffer({
			size,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
		});
		const readback = device.createBuffer({
			size,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
		const pipeline = device.createComputePipeline({
			layout: 'auto',
			compute: { module: device.createShaderModule({ code: COMPUTE }), entryPoint: 'main' }
		});
		const bindGroup = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				// The same bytes bound twice, once as f32 and once as u32.
				{ binding: 0, resource: { buffer: input } },
				{ binding: 1, resource: { buffer: input } },
				{ binding: 2, resource: { buffer: out } }
			]
		});
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginComputePass();
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bindGroup);
		pass.dispatchWorkgroups(1);
		pass.end();
		encoder.copyBufferToBuffer(out, 0, readback, 0, size);
		device.queue.submit([encoder.finish()]);

		await readback.mapAsync(GPUMapMode.READ);
		const words = new Uint32Array(readback.getMappedRange().slice(0));
		readback.unmap();
		readback.destroy();
		out.destroy();

		const flags = Array.from(words.subarray(0, CELLS), (w) => w === 1);
		return { grid: toGrid(flags), kept: { float: words[CELLS], bits: words[CELLS + 1] } };
	}

	async function runVertex(device: GPUDevice, input: GPUBuffer): Promise<Grid> {
		const format: GPUTextureFormat = 'rgba8unorm';
		const texture = device.createTexture({
			size: [CELLS, 1],
			format,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
		});
		// 256 is the row alignment copyTextureToBuffer requires.
		const bytesPerRow = Math.ceil((CELLS * 4) / 256) * 256;
		const readback = device.createBuffer({
			size: bytesPerRow,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
		const module = device.createShaderModule({ code: RENDER });
		const pipeline = device.createRenderPipeline({
			layout: 'auto',
			vertex: { module, entryPoint: 'vs' },
			fragment: { module, entryPoint: 'fs', targets: [{ format }] },
			primitive: { topology: 'point-list' }
		});
		const bindGroup = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: input } },
				{ binding: 1, resource: { buffer: input } }
			]
		});
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: texture.createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
					loadOp: 'clear',
					storeOp: 'store'
				}
			]
		});
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bindGroup);
		pass.draw(CELLS);
		pass.end();
		encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow }, [CELLS, 1]);
		device.queue.submit([encoder.finish()]);

		await readback.mapAsync(GPUMapMode.READ);
		const px = new Uint8Array(readback.getMappedRange().slice(0));
		readback.unmap();
		readback.destroy();
		texture.destroy();

		// Not written (green 0) is null, not "not NaN".
		const flags = Array.from({ length: CELLS }, (_, i) =>
			px[i * 4 + 1] === 255 ? px[i * 4] === 255 : null
		);
		return toGrid(flags);
	}

	function wrongCells(grid: Grid, method: number): number {
		return ROWS.filter((r, i) => grid[i][method] !== r.nan).length;
	}

	async function run() {
		running = true;
		info = [];
		compute = null;
		vertex = null;
		kept = null;
		verdict = null;
		failed = null;
		try {
			if (!navigator.gpu) throw new Error('This browser has no WebGPU.');
			const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
			if (!adapter) throw new Error('No GPU adapter.');
			const device = await adapter.requestDevice();
			const a = adapter.info;
			info = [
				`adapter: ${a.vendor} / ${a.architecture} / ${a.device || '—'} / ${a.description || '—'}`,
				`browser: ${navigator.userAgent}`
			];

			device.pushErrorScope('validation');
			const input = inputBuffer(device);
			const c = await runCompute(device, input);
			const v = await runVertex(device, input);
			const error = await device.popErrorScope();
			input.destroy();
			if (error) throw new Error(`Validation error: ${error.message}`);

			compute = c.grid;
			kept = c.kept;
			vertex = v;

			const reference = METHODS.length - 1;
			const refWrong = wrongCells(c.grid, reference) + wrongCells(v, reference);
			const floatWrong = [0, 1, 2].reduce(
				(n, m) => n + wrongCells(c.grid, m) + wrongCells(v, m),
				0
			);
			if (refWrong > 0) {
				verdict =
					'INCONCLUSIVE — the u32 reference itself is wrong, so the harness is not measuring what it claims.';
			} else if (floatWrong > 0 || c.kept.float !== EXPECTED_KEPT) {
				verdict =
					'BROKEN — float comparisons do not find NaN on this GPU. M4 keeps its empty bins and ' +
					'the line shader cannot discard NaN points.';
			} else {
				verdict = 'OK — every float comparison finds NaN on this GPU.';
			}
		} catch (e) {
			failed = (e as Error).message;
		} finally {
			running = false;
		}
	}

	function cell(value: boolean | null, expected: boolean): { text: string; ok: boolean } {
		if (value === null) return { text: 'not drawn', ok: false };
		return { text: value ? 'NaN' : '—', ok: value === expected };
	}

	onMount(run);
</script>

<main>
	<h1>NaN probe</h1>
	<p>
		Does <code>v != v</code> find a NaN on this GPU? Each check runs on each value in a compute shader
		(as M4 does) and in a vertex shader (as the line shader does). Red cells are wrong.
	</p>

	<button onclick={run} disabled={running}>{running ? 'running…' : 'run again'}</button>

	{#if failed}
		<p class="failed">{failed}</p>
	{:else}
		{#if verdict}
			<p class="verdict">{verdict}</p>
		{/if}

		{#each [{ title: 'Compute shader', grid: compute }, { title: 'Vertex shader', grid: vertex }] as section (section.title)}
			{#if section.grid}
				<h2>{section.title}</h2>
				<table>
					<thead>
						<tr>
							<th>value</th>
							{#each METHODS as m (m)}<th>{m}</th>{/each}
						</tr>
					</thead>
					<tbody>
						{#each ROWS as row, r (row.label)}
							<tr>
								<td>{row.label}</td>
								{#each METHODS as m, i (m)}
									{@const c = cell(section.grid[r][i], row.nan)}
									<td class:wrong={!c.ok}>{c.text}</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		{/each}

		{#if kept}
			<h2>M4 compact loop</h2>
			<p class:wrong={kept.float !== EXPECTED_KEPT}>
				<code>if (x != x) continue;</code> kept {kept.float} of {LOADED} (expected {EXPECTED_KEPT})
			</p>
			<p class:wrong={kept.bits !== EXPECTED_KEPT}>
				bit-pattern check kept {kept.bits} of {LOADED} (expected {EXPECTED_KEPT})
			</p>
		{/if}

		<pre>{info.join('\n')}</pre>
	{/if}
</main>

<style>
	main {
		font-family: system-ui, sans-serif;
		max-width: 60rem;
		margin: 2rem auto;
		padding: 0 1rem;
		line-height: 1.5;
	}
	table {
		border-collapse: collapse;
		font-size: 0.85rem;
		margin-bottom: 1rem;
	}
	th,
	td {
		border: 1px solid #d4d4d8;
		padding: 0.25rem 0.5rem;
		text-align: left;
	}
	.wrong {
		background: #fee2e2;
		color: #b91c1c;
		font-weight: 600;
	}
	pre {
		background: #f4f4f5;
		padding: 1rem;
		border-radius: 4px;
		overflow-x: auto;
		font-size: 0.8rem;
		white-space: pre-wrap;
	}
	.verdict {
		font-weight: 600;
		padding: 1rem;
		border-left: 4px solid #6b7280;
		background: #f9fafb;
	}
	.failed {
		color: #b91c1c;
		font-weight: 600;
	}
	button {
		margin-bottom: 1rem;
	}
</style>
