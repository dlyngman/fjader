/**
 * A spike: raw rows kept on the GPU. The columns are uploaded (here:
 * generated) once; a brush is a compute pass that writes one bit per row; a
 * pan or zoom moves a uniform. Nothing per row runs in JavaScript and nothing
 * is uploaded per frame. It answers one question with numbers: at 1M and 10M
 * rows, what does a frame cost in each of three ways of drawing them?
 *
 * - `full`: every row an instanced, blended quad, as `Dots` draws today. The
 *   vertex shader reads the row's mask bit and dims an unselected row.
 * - `density`: a compute pass counts rows per grid cell (all, and selected);
 *   one fullscreen triangle shades the grid.
 * - `rep`: a compute pass keeps one row per grid cell, the one with the
 *   highest index (an atomic max, so the same row wins on every frame: no
 *   reordering between frames, no compaction); one dot is drawn per cell.
 *
 * Its own device and its own frame loop, on purpose: it measures the
 * technique, not the library. Default WebGPU limits only.
 */

export type Mode = 'full' | 'density' | 'rep';

export interface SpikeOptions {
	rows: number;
	mode: Mode;
	/** Grid cell edge in device pixels (density and rep). */
	cell: number;
	/** Dot radius in device pixels. */
	radius: number;
	alpha: number;
	msaa: 1 | 4;
}

/** What a frame of the session does. */
export interface FrameState {
	/** Data to [0, 1]: `(x - x0) * xs`, the same for y. */
	view: [number, number, number, number];
	/** 1D brush on the brush column, or null. */
	brush: [number, number] | null;
	/** 2D brush in data units (x0, x1, y0, y1), or null. */
	rect: [number, number, number, number] | null;
	/** Categories kept, as a bit set, or null for all. */
	categories: number | null;
}

const WORKGROUP = 256;
const CATEGORIES = 12;
const PASSES = ['mask', 'bin', 'render'] as const;
export type PassName = (typeof PASSES)[number];

const UNIFORMS = /* wgsl */ `
struct U {
	view: vec4f,
	rect: vec4f,
	brush: vec2f,
	res: vec2f,
	n: u32,
	catMask: u32,
	flags: u32,
	gridW: u32,
	gridH: u32,
	cell: u32,
	radius: f32,
	alpha: f32,
}
@group(0) @binding(0) var<uniform> u: U;

fn toUnit(x: f32, y: f32) -> vec2f {
	return vec2f((x - u.view.x) * u.view.y, (y - u.view.z) * u.view.w);
}
`;

const GENERATE = /* wgsl */ `
${UNIFORMS}
@group(0) @binding(1) var<storage, read_write> xs: array<f32>;
@group(0) @binding(2) var<storage, read_write> ys: array<f32>;
@group(0) @binding(3) var<storage, read_write> cs: array<f32>;
@group(0) @binding(4) var<storage, read_write> cats: array<u32>;

fn pcg(v: u32) -> u32 {
	let s = v * 747796405u + 2891336453u;
	let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
	return (w >> 22u) ^ w;
}
fn unit(h: u32) -> f32 {
	return f32(h >> 8u) / 16777216.0;
}

// Six clusters of different widths, so a zoomed-out view overdraws heavily in
// places and is empty in others, as real scatters are.
@compute @workgroup_size(${WORKGROUP})
fn generate(@builtin(global_invocation_id) id: vec3u) {
	let i = id.x;
	if (i >= u.n) { return; }
	let h0 = pcg(i);
	let h1 = pcg(h0);
	let h2 = pcg(h1);
	let h3 = pcg(h2);
	let h4 = pcg(h3);
	let k = h0 % 6u;
	let centre = vec2f(0.18 + 0.13 * f32(k), 0.25 + 0.5 * fract(f32(k) * 0.37));
	let width = 0.02 + 0.035 * f32(k % 3u);
	// Box-Muller.
	let r = sqrt(-2.0 * log(max(unit(h1), 1e-7)));
	let a = 6.2831853 * unit(h2);
	let g = vec2f(r * cos(a), r * sin(a));
	xs[i] = clamp(centre.x + width * g.x, 0.0, 1.0);
	ys[i] = clamp(centre.y + width * (0.6 * g.x + 0.8 * g.y), 0.0, 1.0);
	cs[i] = unit(h3);
	cats[i] = h4 % ${CATEGORIES}u;
}
`;

const MASK = /* wgsl */ `
${UNIFORMS}
@group(0) @binding(1) var<storage, read> xs: array<f32>;
@group(0) @binding(2) var<storage, read> ys: array<f32>;
@group(0) @binding(3) var<storage, read> cs: array<f32>;
@group(0) @binding(4) var<storage, read> cats: array<u32>;
@group(0) @binding(5) var<storage, read_write> mask: array<u32>;

// One invocation per 32 rows: it owns its word, so no atomics.
@compute @workgroup_size(${WORKGROUP})
fn writeMask(@builtin(global_invocation_id) id: vec3u) {
	let w = id.x;
	let first = w * 32u;
	if (first >= u.n) { return; }
	var bits = 0u;
	for (var b = 0u; b < 32u; b++) {
		let i = first + b;
		if (i >= u.n) { break; }
		var keep = true;
		if ((u.flags & 1u) != 0u) {
			let c = cs[i];
			keep = keep && c >= u.brush.x && c < u.brush.y;
		}
		if ((u.flags & 2u) != 0u) {
			let x = xs[i];
			let y = ys[i];
			keep = keep && x >= u.rect.x && x < u.rect.y && y >= u.rect.z && y < u.rect.w;
		}
		if ((u.flags & 4u) != 0u) {
			keep = keep && ((u.catMask >> cats[i]) & 1u) != 0u;
		}
		if (keep) { bits |= 1u << b; }
	}
	mask[w] = bits;
}
`;

const BIN = /* wgsl */ `
${UNIFORMS}
@group(0) @binding(1) var<storage, read> xs: array<f32>;
@group(0) @binding(2) var<storage, read> ys: array<f32>;
@group(0) @binding(5) var<storage, read> mask: array<u32>;
@group(0) @binding(6) var<storage, read_write> grid: array<atomic<u32>>;

fn cellOf(i: u32) -> i32 {
	let p = toUnit(xs[i], ys[i]);
	if (p.x < 0.0 || p.x >= 1.0 || p.y < 0.0 || p.y >= 1.0) { return -1; }
	let gx = min(u32(p.x * f32(u.gridW)), u.gridW - 1u);
	let gy = min(u32(p.y * f32(u.gridH)), u.gridH - 1u);
	return i32(gy * u.gridW + gx);
}

// Two counters per cell: every row, and the selected rows.
@compute @workgroup_size(${WORKGROUP})
fn count(@builtin(global_invocation_id) id: vec3u) {
	let i = id.x;
	if (i >= u.n) { return; }
	let at = cellOf(i);
	if (at < 0) { return; }
	atomicAdd(&grid[2u * u32(at)], 1u);
	if (((mask[i >> 5u] >> (i & 31u)) & 1u) != 0u) {
		atomicAdd(&grid[2u * u32(at) + 1u], 1u);
	}
}

// One row per cell: the highest index, the same on every frame.
@compute @workgroup_size(${WORKGROUP})
fn pick(@builtin(global_invocation_id) id: vec3u) {
	let i = id.x;
	if (i >= u.n) { return; }
	let at = cellOf(i);
	if (at < 0) { return; }
	atomicMax(&grid[u32(at)], i + 1u);
}
`;

const DOT = /* wgsl */ `
struct V {
	@builtin(position) position: vec4f,
	@location(0) corner: vec2f,
	@location(1) @interpolate(flat) selected: u32,
}

const CORNERS = array<vec2f, 6>(
	vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1)
);

fn dotAt(row: u32, vertex: u32) -> V {
	var out: V;
	let corner = CORNERS[vertex];
	let p = toUnit(xs[row], ys[row]);
	let clip = vec2f(p.x * 2.0 - 1.0, p.y * 2.0 - 1.0);
	out.position = vec4f(clip + corner * u.radius * 2.0 / u.res, 0.0, 1.0);
	out.corner = corner;
	out.selected = (mask[row >> 5u] >> (row & 31u)) & 1u;
	return out;
}

@fragment
fn fs(in: V) -> @location(0) vec4f {
	let d = length(in.corner);
	if (d > 1.0) { discard; }
	let edge = 1.0 - smoothstep(0.8, 1.0, d);
	if (in.selected != 0u) {
		return vec4f(0.27, 0.51, 0.71, u.alpha * edge);
	}
	return vec4f(0.6, 0.6, 0.6, u.alpha * 0.35 * edge);
}
`;

const DRAW_FULL = /* wgsl */ `
${UNIFORMS}
@group(0) @binding(1) var<storage, read> xs: array<f32>;
@group(0) @binding(2) var<storage, read> ys: array<f32>;
@group(0) @binding(5) var<storage, read> mask: array<u32>;
${DOT}
@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> V {
	return dotAt(instance, vertex);
}
`;

const DRAW_REP = /* wgsl */ `
${UNIFORMS}
@group(0) @binding(1) var<storage, read> xs: array<f32>;
@group(0) @binding(2) var<storage, read> ys: array<f32>;
@group(0) @binding(5) var<storage, read> mask: array<u32>;
@group(0) @binding(6) var<storage, read> grid: array<u32>;
${DOT}
@vertex
fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> V {
	let picked = grid[instance];
	if (picked == 0u) {
		var out: V;
		out.position = vec4f(2.0, 2.0, 0.0, 1.0);
		return out;
	}
	return dotAt(picked - 1u, vertex);
}
`;

const DRAW_DENSITY = /* wgsl */ `
${UNIFORMS}
@group(0) @binding(6) var<storage, read> grid: array<u32>;

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
	let p = vec2f(f32((vertex << 1u) & 2u), f32(vertex & 2u));
	return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) at: vec4f) -> @location(0) vec4f {
	let gx = min(u32(at.x) / u.cell, u.gridW - 1u);
	// The grid's y grows upward, the framebuffer's downward.
	let gy = u.gridH - 1u - min(u32(at.y) / u.cell, u.gridH - 1u);
	let cell = 2u * (gy * u.gridW + gx);
	let total = grid[cell];
	if (total == 0u) { discard; }
	let share = f32(grid[cell + 1u]) / f32(total);
	// What blending n dots of this alpha would have left.
	let coverage = 1.0 - pow(1.0 - u.alpha, f32(total));
	let colour = mix(vec3f(0.6), vec3f(0.27, 0.51, 0.71), share);
	return vec4f(colour, coverage * mix(0.35, 1.0, share));
}
`;

/** The shaders, by name: for validating them outside a browser. */
export const SHADERS = { GENERATE, MASK, BIN, DRAW_FULL, DRAW_REP, DRAW_DENSITY };

export interface PhaseSummary {
	phase: string;
	frames: number;
	dtP50: number;
	dtP95: number;
	dtMax: number;
	droppedPct: number;
	encodeP50: number;
	encodeP95: number;
	/** GPU time per pass and their sum, ms; null without timestamp queries. */
	gpu: Record<PassName | 'total', { p50: number; p95: number; max: number }> | null;
}

const MAX_FRAMES = 20_000;
const RING = 8;

function quantile(sorted: Float64Array, q: number): number {
	if (sorted.length === 0) return NaN;
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

export class Spike {
	readonly device: GPUDevice;
	readonly options: SpikeOptions;
	readonly timed: boolean;
	readonly gridW: number;
	readonly gridH: number;
	/** Bytes held on the GPU, by what holds them. */
	readonly bytes: Record<string, number>;

	readonly #context: GPUCanvasContext;
	readonly #canvas: HTMLCanvasElement;
	readonly #uniformData = new ArrayBuffer(80);
	readonly #f32 = new Float32Array(this.#uniformData);
	readonly #u32 = new Uint32Array(this.#uniformData);
	readonly #uniforms: GPUBuffer;
	readonly #grid: GPUBuffer | null;
	readonly #maskPipeline: GPUComputePipeline;
	readonly #maskGroup: GPUBindGroup;
	readonly #binPipeline: GPUComputePipeline | null = null;
	readonly #binGroup: GPUBindGroup | null = null;
	readonly #drawPipeline: GPURenderPipeline;
	readonly #drawGroup: GPUBindGroup;
	readonly #msaa: GPUTextureView | null;
	readonly #colorAttachment: GPURenderPassColorAttachment;
	readonly #renderPass: GPURenderPassDescriptor;
	readonly #maskPass: GPUComputePassDescriptor = { label: 'mask' };
	readonly #binPass: GPUComputePassDescriptor = { label: 'bin' };
	readonly #submit: GPUCommandBuffer[] = [];

	readonly #querySet: GPUQuerySet | null = null;
	readonly #resolve: GPUBuffer | null = null;
	readonly #ring: { buffer: GPUBuffer; busy: boolean }[] = [];

	// Per frame, preallocated.
	readonly #ts = new Float64Array(MAX_FRAMES);
	readonly #encode = new Float64Array(MAX_FRAMES);
	readonly #phase = new Uint8Array(MAX_FRAMES);
	readonly #gpu = PASSES.map(() => new Float64Array(MAX_FRAMES).fill(NaN));
	readonly #phases: string[] = [];
	#frames = 0;

	#lastMaskKey = '';
	#lastBinKey = '';

	static async create(canvas: HTMLCanvasElement, options: SpikeOptions): Promise<Spike> {
		const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
		if (!adapter) throw new Error('No WebGPU adapter.');
		const timed = adapter.features.has('timestamp-query');
		const device = await adapter.requestDevice({
			requiredFeatures: timed ? ['timestamp-query'] : []
		});
		const spike = new Spike(device, canvas, options, timed);
		await spike.#generate();
		return spike;
	}

	readonly #columns: { x: GPUBuffer; y: GPUBuffer; c: GPUBuffer; cat: GPUBuffer; mask: GPUBuffer };

	private constructor(
		device: GPUDevice,
		canvas: HTMLCanvasElement,
		options: SpikeOptions,
		timed: boolean
	) {
		this.device = device;
		this.options = options;
		this.timed = timed;
		this.#canvas = canvas;
		const { rows, mode, cell, msaa } = options;

		const format = navigator.gpu.getPreferredCanvasFormat();
		this.#context = canvas.getContext('webgpu')!;
		this.#context.configure({ device, format, alphaMode: 'opaque' });

		const column = (label: string) =>
			device.createBuffer({ label, size: rows * 4, usage: GPUBufferUsage.STORAGE });
		const words = Math.ceil(rows / 32);
		this.#columns = {
			x: column('x'),
			y: column('y'),
			c: column('c'),
			cat: column('cat'),
			mask: device.createBuffer({ label: 'mask', size: words * 4, usage: GPUBufferUsage.STORAGE })
		};
		this.#uniforms = device.createBuffer({
			size: this.#uniformData.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});

		this.gridW = Math.ceil(canvas.width / cell);
		this.gridH = Math.ceil(canvas.height / cell);
		const cells = this.gridW * this.gridH;
		const gridBytes = mode === 'density' ? cells * 8 : mode === 'rep' ? cells * 4 : 0;
		this.#grid = gridBytes
			? device.createBuffer({ label: 'grid', size: gridBytes, usage: GPUBufferUsage.STORAGE })
			: null;

		const samples = msaa === 4 && mode !== 'density' ? 4 : 1;
		const msaaTexture =
			samples === 4
				? device.createTexture({
						size: [canvas.width, canvas.height],
						format,
						sampleCount: 4,
						usage: GPUTextureUsage.RENDER_ATTACHMENT
					})
				: null;
		this.#msaa = msaaTexture?.createView() ?? null;
		this.bytes = {
			columns: rows * 16,
			mask: words * 4,
			grid: gridBytes,
			msaa: msaaTexture ? canvas.width * canvas.height * 4 * 4 : 0
		};

		const { x, y, c, cat, mask } = this.#columns;
		const entry = (binding: number, buffer: GPUBuffer): GPUBindGroupEntry => ({
			binding,
			resource: { buffer }
		});
		const uniformEntry = entry(0, this.#uniforms);

		this.#maskPipeline = device.createComputePipeline({
			layout: 'auto',
			compute: { module: device.createShaderModule({ code: MASK }), entryPoint: 'writeMask' }
		});
		this.#maskGroup = device.createBindGroup({
			layout: this.#maskPipeline.getBindGroupLayout(0),
			entries: [uniformEntry, entry(1, x), entry(2, y), entry(3, c), entry(4, cat), entry(5, mask)]
		});

		if (this.#grid) {
			const density = mode === 'density';
			this.#binPipeline = device.createComputePipeline({
				layout: 'auto',
				compute: {
					module: device.createShaderModule({ code: BIN }),
					entryPoint: density ? 'count' : 'pick'
				}
			});
			// `pick` reads no mask: an auto layout has only what the entry point uses.
			const entries = [uniformEntry, entry(1, x), entry(2, y), entry(6, this.#grid)];
			if (density) entries.push(entry(5, mask));
			this.#binGroup = device.createBindGroup({
				layout: this.#binPipeline.getBindGroupLayout(0),
				entries
			});
		}

		const code = mode === 'full' ? DRAW_FULL : mode === 'rep' ? DRAW_REP : DRAW_DENSITY;
		const module = device.createShaderModule({ code });
		this.#drawPipeline = device.createRenderPipeline({
			layout: 'auto',
			vertex: { module, entryPoint: 'vs' },
			fragment: {
				module,
				entryPoint: 'fs',
				targets: [
					{
						format,
						blend: {
							color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
							alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
						}
					}
				]
			},
			primitive: { topology: 'triangle-list' },
			multisample: { count: samples }
		});
		const drawEntries =
			mode === 'density'
				? [uniformEntry, entry(6, this.#grid!)]
				: [uniformEntry, entry(1, x), entry(2, y), entry(5, mask)];
		if (mode === 'rep') drawEntries.push(entry(6, this.#grid!));
		this.#drawGroup = device.createBindGroup({
			layout: this.#drawPipeline.getBindGroupLayout(0),
			entries: drawEntries
		});

		// The canvas's view is the one object a frame must make: set per frame.
		this.#colorAttachment = {
			view: null as unknown as GPUTextureView,
			clearValue: { r: 1, g: 1, b: 1, a: 1 },
			loadOp: 'clear',
			storeOp: this.#msaa ? 'discard' : 'store'
		};
		this.#renderPass = { label: 'render', colorAttachments: [this.#colorAttachment] };

		if (timed) {
			this.#querySet = device.createQuerySet({ type: 'timestamp', count: PASSES.length * 2 });
			this.#resolve = device.createBuffer({
				size: PASSES.length * 16,
				usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
			});
			for (let i = 0; i < RING; i++) {
				this.#ring.push({
					buffer: device.createBuffer({
						size: PASSES.length * 16,
						usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
					}),
					busy: false
				});
			}
			PASSES.forEach((name, k) => {
				const writes = {
					querySet: this.#querySet!,
					beginningOfPassWriteIndex: k * 2,
					endOfPassWriteIndex: k * 2 + 1
				};
				if (name === 'mask') this.#maskPass.timestampWrites = writes;
				else if (name === 'bin') this.#binPass.timestampWrites = writes;
				else this.#renderPass.timestampWrites = writes;
			});
		}
	}

	/** Fill the columns, on the GPU, and wait for it. */
	async #generate(): Promise<void> {
		const { device } = this;
		const { x, y, c, cat } = this.#columns;
		const pipeline = device.createComputePipeline({
			layout: 'auto',
			compute: { module: device.createShaderModule({ code: GENERATE }), entryPoint: 'generate' }
		});
		this.#writeUniforms({ view: [0, 1, 0, 1], brush: null, rect: null, categories: null });
		const group = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: this.#uniforms } },
				{ binding: 1, resource: { buffer: x } },
				{ binding: 2, resource: { buffer: y } },
				{ binding: 3, resource: { buffer: c } },
				{ binding: 4, resource: { buffer: cat } }
			]
		});
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginComputePass();
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, group);
		pass.dispatchWorkgroups(Math.ceil(this.options.rows / WORKGROUP));
		pass.end();
		device.queue.submit([encoder.finish()]);
		await device.queue.onSubmittedWorkDone();
	}

	#writeUniforms(state: FrameState): void {
		const f = this.#f32;
		const u = this.#u32;
		f.set(state.view, 0);
		if (state.rect) f.set(state.rect, 4);
		if (state.brush) f.set(state.brush, 8);
		f[10] = this.#canvas.width;
		f[11] = this.#canvas.height;
		u[12] = this.options.rows;
		u[13] = state.categories ?? 0;
		u[14] = (state.brush ? 1 : 0) | (state.rect ? 2 : 0) | (state.categories !== null ? 4 : 0);
		u[15] = this.gridW;
		u[16] = this.gridH;
		u[17] = this.options.cell;
		f[18] = this.options.radius;
		f[19] = this.options.alpha;
		this.device.queue.writeBuffer(this.#uniforms, 0, this.#uniformData);
	}

	/**
	 * One frame: the mask when the selection changed, the grid when the view
	 * or (for density) the selection changed, then the draw. `ts` is the
	 * frame's rAF timestamp.
	 */
	frame(ts: number, phase: string, state: FrameState): void {
		const t0 = performance.now();
		const { device, options } = this;
		const { rows, mode } = options;
		this.#writeUniforms(state);

		const maskKey = `${state.brush}|${state.rect}|${state.categories}`;
		const maskDirty = maskKey !== this.#lastMaskKey;
		this.#lastMaskKey = maskKey;
		const binKey = mode === 'density' ? `${state.view}|${maskKey}` : `${state.view}`;
		const binDirty = this.#grid !== null && binKey !== this.#lastBinKey;
		this.#lastBinKey = binKey;

		const encoder = device.createCommandEncoder();
		if (maskDirty) {
			const pass = encoder.beginComputePass(this.#maskPass);
			pass.setPipeline(this.#maskPipeline);
			pass.setBindGroup(0, this.#maskGroup);
			pass.dispatchWorkgroups(Math.ceil(Math.ceil(rows / 32) / WORKGROUP));
			pass.end();
		}
		if (binDirty) {
			encoder.clearBuffer(this.#grid!);
			const pass = encoder.beginComputePass(this.#binPass);
			pass.setPipeline(this.#binPipeline!);
			pass.setBindGroup(0, this.#binGroup!);
			pass.dispatchWorkgroups(Math.ceil(rows / WORKGROUP));
			pass.end();
		}

		const view = this.#context.getCurrentTexture().createView();
		if (this.#msaa) {
			this.#colorAttachment.view = this.#msaa;
			this.#colorAttachment.resolveTarget = view;
		} else {
			this.#colorAttachment.view = view;
		}
		const pass = encoder.beginRenderPass(this.#renderPass);
		pass.setPipeline(this.#drawPipeline);
		pass.setBindGroup(0, this.#drawGroup);
		if (mode === 'full') pass.draw(6, rows);
		else if (mode === 'rep') pass.draw(6, this.gridW * this.gridH);
		else pass.draw(3);
		pass.end();

		const i = this.#frames < MAX_FRAMES ? this.#frames++ : -1;
		let slot = -1;
		if (this.#querySet && i >= 0) {
			slot = this.#ring.findIndex((r) => !r.busy);
			if (slot >= 0) {
				encoder.resolveQuerySet(this.#querySet, 0, PASSES.length * 2, this.#resolve!, 0);
				encoder.copyBufferToBuffer(
					this.#resolve!,
					0,
					this.#ring[slot].buffer,
					0,
					PASSES.length * 16
				);
			}
		}
		this.#submit[0] = encoder.finish();
		device.queue.submit(this.#submit);

		if (i >= 0) {
			let p = this.#phases.indexOf(phase);
			if (p < 0) p = this.#phases.push(phase) - 1;
			this.#ts[i] = ts;
			this.#phase[i] = p;
			this.#encode[i] = performance.now() - t0;
			if (slot >= 0) this.#read(slot, i, maskDirty, binDirty);
		}
	}

	/** A frame's pass times, once its readback maps. A pass that did not run is 0. */
	#read(slot: number, frame: number, maskRan: boolean, binRan: boolean): void {
		const entry = this.#ring[slot];
		entry.busy = true;
		entry.buffer.mapAsync(GPUMapMode.READ).then(
			() => {
				const t = new BigInt64Array(entry.buffer.getMappedRange());
				const ran = [maskRan, binRan, true];
				for (let k = 0; k < PASSES.length; k++) {
					this.#gpu[k][frame] = ran[k] ? Number(t[k * 2 + 1] - t[k * 2]) / 1e6 : 0;
				}
				entry.buffer.unmap();
				entry.busy = false;
			},
			() => {
				entry.busy = false;
			}
		);
	}

	/** Forget the frames recorded so far: the session starts here. */
	reset(): void {
		this.#frames = 0;
		this.#phases.length = 0;
		for (const times of this.#gpu) times.fill(NaN);
	}

	/**
	 * Per phase. `cadence` is the display's frame interval, measured by the
	 * page before the session: a phase too slow to keep up cannot say what the
	 * display's rate was.
	 */
	summarize(cadence: number): { cadence: number; phases: PhaseSummary[] } {
		const n = this.#frames;
		const of = (p: number) => {
			const dt: number[] = [];
			const encode: number[] = [];
			const gpu: number[][] = PASSES.map(() => []);
			const total: number[] = [];
			for (let i = 1; i < n; i++) {
				if (this.#phase[i] !== p) continue;
				dt.push(this.#ts[i] - this.#ts[i - 1]);
				encode.push(this.#encode[i]);
				if (!Number.isNaN(this.#gpu[0][i])) {
					let sum = 0;
					for (let k = 0; k < PASSES.length; k++) {
						gpu[k].push(this.#gpu[k][i]);
						sum += this.#gpu[k][i];
					}
					total.push(sum);
				}
			}
			return { dt, encode, gpu, total };
		};
		const sorted = (xs: number[]) => Float64Array.from(xs).sort();
		const stat = (xs: number[]) => {
			const s = sorted(xs);
			return { p50: quantile(s, 0.5), p95: quantile(s, 0.95), max: s[s.length - 1] ?? NaN };
		};
		const phases = this.#phases.map((phase, p): PhaseSummary => {
			const { dt, encode, gpu, total } = of(p);
			const dts = sorted(dt);
			let slots = 0;
			let dropped = 0;
			for (const d of dt) {
				const k = Math.max(1, Math.round(d / cadence));
				slots += k;
				dropped += k - 1;
			}
			const encodes = sorted(encode);
			return {
				phase,
				frames: dt.length,
				dtP50: quantile(dts, 0.5),
				dtP95: quantile(dts, 0.95),
				dtMax: dts[dts.length - 1] ?? NaN,
				droppedPct: slots ? (100 * dropped) / slots : 0,
				encodeP50: quantile(encodes, 0.5),
				encodeP95: quantile(encodes, 0.95),
				gpu:
					this.timed && total.length
						? {
								mask: stat(gpu[0]),
								bin: stat(gpu[1]),
								render: stat(gpu[2]),
								total: stat(total)
							}
						: null
			};
		});
		return { cadence, phases };
	}

	toJSON() {
		const n = this.#frames;
		return {
			phases: this.#phases,
			ts: Array.from(this.#ts.subarray(0, n)),
			encode: Array.from(this.#encode.subarray(0, n)),
			phase: Array.from(this.#phase.subarray(0, n)),
			gpu: Object.fromEntries(
				PASSES.map((name, k) => [name, Array.from(this.#gpu[k].subarray(0, n))])
			)
		};
	}

	destroy(): void {
		this.device.destroy();
	}
}
