<script lang="ts">
	import { onMount } from 'svelte';

	/**
	 * Does immediate data survive `setPipeline`?
	 *
	 * The one question blocking the immediates conversion that cannot be
	 * answered by reading anything — not the spec, not the types. Underlying
	 * APIs sometimes invalidate push constants on a pipeline layout change, and
	 * the planned design leans on them NOT being invalidated: a shared prefix
	 * set once per pass, with each mark pushing only its own tail.
	 *
	 * Deliberately standalone. No coordinator, no scales, no marks — two
	 * pipelines, one render pass, and a texture read back — so a result cannot
	 * be an artifact of anything this library does.
	 *
	 * HOW IT READS THE ANSWER. Each draw writes one pixel, chosen by a scissor
	 * rect, whose red channel is the immediate value it saw. The first draw
	 * sets an immediate and the second does not. If the second pixel carries
	 * the first's value, the data survived the switch; if it is zero, the
	 * switch cleared it. The probe value is non-zero precisely so "cleared"
	 * and "wrote what it was given" cannot be confused.
	 *
	 * Asked in two parts, because only one of them gates the design. Pipelines
	 * with DIFFERENT immediate sizes is the narrow case, and it can be avoided
	 * for free by declaring the same size on every layout. Pipelines with the
	 * SAME size is the configuration that would actually ship, so it is the
	 * one that decides.
	 */

	const PROBE = 111;
	const SECOND = 222;

	let lines = $state<string[]>([]);
	let verdict = $state<string | null>(null);
	let failed = $state<string | null>(null);
	let running = $state(false);

	const say = (s: string) => (lines = [...lines, s]);

	function shader(words: number): string {
		const fields = words === 1 ? 'v: u32,' : 'v: u32,\n\t\t\t\tw: u32,';
		const green = words === 1 ? '0.0' : 'f32(imm.w) / 255.0';
		return /* wgsl */ `
			requires immediate_address_space;

			struct Probe {
				${fields}
			};
			var<immediate> imm: Probe;

			@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
				var p = array<vec2<f32>, 3>(
					vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
				);
				return vec4<f32>(p[i], 0.0, 1.0);
			}

			@fragment fn fs() -> @location(0) vec4<f32> {
				return vec4<f32>(f32(imm.v) / 255.0, ${green}, 0.0, 1.0);
			}
		`;
	}

	function makePipeline(device: GPUDevice, words: number, format: GPUTextureFormat) {
		const module = device.createShaderModule({ code: shader(words) });
		// A layout of its own, which is the point: the switch below crosses two
		// pipeline layouts, and immediate size is declared on the layout.
		const layout = device.createPipelineLayout({
			bindGroupLayouts: [],
			immediateSize: words * 4
		});
		return device.createRenderPipeline({
			layout,
			vertex: { module, entryPoint: 'vs' },
			fragment: { module, entryPoint: 'fs', targets: [{ format }] },
			primitive: { topology: 'triangle-list' }
		});
	}

	/**
	 * Draw twice in one pass, setting immediates only before the first.
	 * Returns the red byte each draw wrote.
	 */
	async function probe(
		device: GPUDevice,
		first: GPURenderPipeline,
		second: GPURenderPipeline,
		// Narrowed: the loose Uint32Array admits a SharedArrayBuffer, which
		// setImmediates does not take.
		data: Uint32Array<ArrayBuffer>
	): Promise<{ first: number; second: number; error: string | null }> {
		const format: GPUTextureFormat = 'rgba8unorm';
		const texture = device.createTexture({
			size: [2, 1],
			format,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
		});
		// 256 is the row alignment copyTextureToBuffer requires.
		const readback = device.createBuffer({
			size: 256,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});

		device.pushErrorScope('validation');

		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: texture.createView(),
					// Cleared to black, so an untouched pixel reads zero and cannot be
					// mistaken for a value that was written.
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
					loadOp: 'clear',
					storeOp: 'store'
				}
			]
		});

		pass.setPipeline(first);
		pass.setImmediates(0, data);
		pass.setScissorRect(0, 0, 1, 1);
		pass.draw(3);

		// The switch under test. No setImmediates before this draw.
		pass.setPipeline(second);
		pass.setScissorRect(1, 0, 1, 1);
		pass.draw(3);

		pass.end();
		encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 256 }, [2, 1]);
		device.queue.submit([encoder.finish()]);

		const error = await device.popErrorScope();
		await readback.mapAsync(GPUMapMode.READ);
		const px = new Uint8Array(readback.getMappedRange().slice(0));
		readback.unmap();
		readback.destroy();
		texture.destroy();

		return { first: px[0], second: px[4], error: error ? error.message : null };
	}

	async function run() {
		running = true;
		lines = [];
		verdict = null;
		failed = null;
		try {
			if (!navigator.gpu) throw new Error('This browser has no WebGPU.');
			if (!navigator.gpu.wgslLanguageFeatures?.has('immediate_address_space')) {
				throw new Error(
					'This browser has WebGPU but not the WGSL immediate_address_space feature, ' +
						'which is the feature under test. Chrome 149 or later.'
				);
			}

			const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
			if (!adapter) throw new Error('No GPU adapter.');

			// Question two, and it is just a readback: how much immediate space
			// this device will give. It decides how many parallel-coordinates axes
			// one draw can carry, and therefore how many draws a wide plot needs.
			const ceiling = adapter.limits.maxImmediateSize;
			const device = await adapter.requestDevice(
				ceiling ? { requiredLimits: { maxImmediateSize: ceiling } } : {}
			);
			say(`adapter reports maxImmediateSize: ${ceiling ?? 'undefined'} bytes`);
			say(`device granted maxImmediateSize: ${device.limits.maxImmediateSize} bytes`);
			say(
				`at 12 bytes per axis that is ${Math.floor(device.limits.maxImmediateSize / 12)} axes per draw`
			);
			say('');

			const format: GPUTextureFormat = 'rgba8unorm';
			const small = makePipeline(device, 1, format);
			const alsoSmall = makePipeline(device, 1, format);
			const large = makePipeline(device, 2, format);

			// The case that ships: two layouts, same immediate size.
			const same = await probe(device, small, alsoSmall, new Uint32Array([PROBE]));
			say(`SAME SIZE   first draw saw ${same.first}, second draw saw ${same.second}`);
			if (same.error) say(`            validation error: ${same.error}`);

			// The narrow case, avoidable by declaring one size everywhere.
			const differing = await probe(device, small, large, new Uint32Array([PROBE]));
			if (differing.error) {
				// A validation error fails the whole command buffer, so NEITHER
				// pixel was written and the numbers say nothing about either draw.
				// Reported this way because the obvious reading of "0, 0" — that
				// the switch cleared the data — is the wrong one.
				say('OTHER SIZE  refused: nothing was drawn, so neither pixel means anything');
				say(`            ${differing.error.split('\n')[0]}`);
			} else {
				say(`OTHER SIZE  first draw saw ${differing.first}, second draw saw ${differing.second}`);
			}
			say('');

			// A control: the same two pipelines, but the second sets its own
			// immediates. If this does not come back as expected the harness is
			// wrong and neither result above means anything.
			const control = await probe(device, small, alsoSmall, new Uint32Array([SECOND]));
			say(
				`CONTROL     a different probe value reads back as ${control.first} (expected ${SECOND})`
			);
			say('');

			if (control.first !== SECOND) {
				verdict =
					'INCONCLUSIVE — the control failed, so the harness is not measuring what it claims.';
			} else if (same.error) {
				verdict =
					'NO — setting immediates once per pass is a validation error. Every draw must set its own, ' +
					'so the shared-prefix design does not hold and each mark pushes the full struct.';
			} else if (same.second === PROBE) {
				verdict =
					'YES — immediate data survives a pipeline switch between layouts of the same size. ' +
					'The shared prefix can be set once per pass and each mark can push only its tail.';
			} else if (same.second === 0) {
				verdict =
					'NO — the pipeline switch cleared the immediate data. Every mark must set the full ' +
					'struct per draw, and the prefix-plus-tail split does not survive.';
			} else {
				verdict = `UNCLEAR — the second draw saw ${same.second}, which is neither the probe nor zero.`;
			}
		} catch (e) {
			failed = (e as Error).message;
		} finally {
			running = false;
		}
	}

	onMount(run);
</script>

<main>
	<h1>Immediates probe</h1>
	<p>
		Two pipelines, one render pass, immediates set only before the first draw. Whether the second
		draw still sees them decides how the scale parameters are pushed.
	</p>

	<button onclick={run} disabled={running}>{running ? 'running…' : 'run again'}</button>

	{#if failed}
		<p class="failed">{failed}</p>
	{:else}
		<pre>{lines.join('\n')}</pre>
		{#if verdict}
			<p class="verdict">{verdict}</p>
		{/if}
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
	pre {
		background: #f4f4f5;
		padding: 1rem;
		border-radius: 4px;
		overflow-x: auto;
		font-size: 0.85rem;
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
