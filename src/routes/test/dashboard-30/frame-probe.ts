/**
 * Per-frame cost probe for the dashboard test page. What it records, for every
 * frame the browser renders while it runs:
 *
 * - `dt`: the time since the previous frame's start (rAF timestamps). At
 *   120 Hz a frame that makes its deadline is ~8.33 ms; a dropped frame shows
 *   as a multiple.
 * - `work`: main-thread time from the frame's start to the end of its
 *   rendering steps. The rAF callback posts a message; a posted message is a
 *   task, and tasks run after the frame's rAF callbacks, style, layout and
 *   paint. So `work` covers all of them: the coordinator's encode, Svelte's
 *   updates, and the DOM's style and layout. It does not split them; the
 *   Long Animation Frame entries do, for frames long enough to be reported.
 * - `mutations`: DOM mutation records under the dashboard since the previous
 *   frame (opt-in: observing has a cost of its own).
 * - `phase`: the scripted phase the frame belongs to.
 *
 * - `elementDraws`: `drawElementImageToTexture` calls (text atlas uploads)
 *   since the previous frame. An upload is change-time work: outside a data
 *   change this should stay 0.
 *
 * - `created`: WebGPU objects the page made since the previous frame, by kind
 *   (`CREATED`). Each is a wrapper object on Blink's heap, which its garbage
 *   collector sweeps on the main thread: what is made every frame is what a
 *   sweep finds during an interaction.
 *
 * And per `queue.submit`, the time until the GPU reports that work done
 * (`onSubmittedWorkDone`): an upper bound on GPU time per frame, since it
 * includes any queueing behind earlier work.
 *
 * Storage is preallocated typed arrays, so recording a frame allocates
 * nothing. Timing the GPU does allocate, per submit: a promise for the
 * submit's completion, and with pass timestamps the wrapped encoder's
 * closures and a readback. `device: null` turns both off, for a run whose
 * garbage collection is the thing measured; the counts need no device.
 */

const MAX_FRAMES = 30_000;
const MAX_SUBMITS = 60_000;

/**
 * What `created` counts, in the order of its columns. All but the last are
 * objects made; `writeBuffers` are uploads, counted beside them because an
 * upload per frame is the other thing an interaction loop should not do.
 */
export const CREATED = [
	'encoders',
	'computePasses',
	'renderPasses',
	'currentTextures',
	'textureViews',
	'bindGroups',
	'buffers',
	'textures',
	'workDone',
	'writeBuffers'
] as const;
export type CreatedKind = (typeof CREATED)[number];
const WORK_DONE = CREATED.indexOf('workDone');

/**
 * Counts calls that make a WebGPU object, by patching the interfaces'
 * prototypes: every device, encoder, context and texture on the page is
 * counted, whoever made it. A patched method passes its arguments on by
 * position and adds one to a typed array, so counting allocates nothing. An
 * argument the caller left out goes on as `undefined`, which WebIDL reads as
 * left out.
 */
class CreationCounter {
	readonly pending = new Uint32Array(CREATED.length);
	readonly #restore: (() => void)[] = [];

	constructor() {
		const interfaces = globalThis as unknown as Record<string, { prototype: object } | undefined>;
		const patch = (name: string, method: string, kind: CreatedKind) => {
			const proto = interfaces[name]?.prototype as Record<string, unknown> | undefined;
			const original = proto?.[method] as ((...args: unknown[]) => unknown) | undefined;
			if (!proto || typeof original !== 'function') return;
			const pending = this.pending;
			const at = CREATED.indexOf(kind);
			proto[method] = function (
				this: unknown,
				a: unknown,
				b: unknown,
				c: unknown,
				d: unknown,
				e: unknown
			) {
				pending[at]++;
				return original.call(this, a, b, c, d, e);
			};
			this.#restore.push(() => {
				proto[method] = original;
			});
		};
		patch('GPUDevice', 'createCommandEncoder', 'encoders');
		patch('GPUCommandEncoder', 'beginComputePass', 'computePasses');
		patch('GPUCommandEncoder', 'beginRenderPass', 'renderPasses');
		patch('GPUCanvasContext', 'getCurrentTexture', 'currentTextures');
		patch('GPUTexture', 'createView', 'textureViews');
		patch('GPUDevice', 'createBindGroup', 'bindGroups');
		patch('GPUDevice', 'createBuffer', 'buffers');
		patch('GPUDevice', 'createTexture', 'textures');
		patch('GPUQueue', 'onSubmittedWorkDone', 'workDone');
		patch('GPUQueue', 'writeBuffer', 'writeBuffers');
	}

	destroy(): void {
		for (const restore of this.#restore) restore();
	}
}

/** One kind's count in a phase: in all, and per frame. */
export interface CreatedSummary {
	total: number;
	p50: number;
	max: number;
}

export interface ProbeOptions {
	/** The element whose subtree mutations are counted, or null for none. */
	mutationRoot: Element | null;
	/**
	 * The device whose queue submissions are timed, or null for none: timing
	 * allocates per submit (see the file comment).
	 */
	device: GPUDevice | null;
}

export interface LoafEntry {
	start: number;
	duration: number;
	blockingDuration: number;
	renderStart: number;
	styleAndLayoutStart: number;
	phase: string;
	scripts: Array<{ invoker: string; duration: number; source: string }>;
}

export interface PhaseSummary {
	phase: string;
	frames: number;
	/** Display cadence: the median frame interval of the idle phase. */
	dtP50: number;
	dtP95: number;
	dtP99: number;
	dtMax: number;
	/** Frames the display had and this page did not draw: sum of round(dt / cadence) − 1. */
	dropped: number;
	/** Dropped frames as a share of the frames the display had in the phase. */
	droppedPct: number;
	workP50: number;
	workP95: number;
	workMax: number;
	gpuP50: number | null;
	gpuP95: number | null;
	/** GPU time of our passes per submit (timestamp queries), when the device has them. */
	passMsP50: number | null;
	passMsP95: number | null;
	/** Passes per submit: about one per chart drawn, plus compute work. */
	passesP50: number | null;
	passesMax: number | null;
	mutationsP50: number | null;
	mutationsMax: number | null;
	/** Text atlas uploads in the phase, and the most in one frame. */
	elementDraws: number;
	elementDrawsMax: number;
	/** WebGPU objects made in the phase, by kind. */
	created: Record<CreatedKind, CreatedSummary>;
	loafs: number;
}

function quantile(sorted: Float64Array, q: number): number {
	if (sorted.length === 0) return NaN;
	const i = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
	return sorted[i];
}

/**
 * GPU time per submit, from timestamp queries: each render and compute pass
 * the coordinator encodes gets begin/end timestamps, resolved into a readback
 * buffer when its encoder finishes. A submit's time is its last pass's end
 * minus its first pass's begin, so it counts the GPU executing our passes and
 * nothing else: not the queue waiting behind other work, and not the
 * compositor. Set beside the submit-to-done latency, the difference is time
 * spent outside our passes.
 *
 * Needs the device's 'timestamp-query' feature (the coordinator asks for it
 * when the adapter has it). Chrome quantizes the timestamps (to 100 µs by
 * default), which is plenty at frame scale.
 */
interface SubmitTiming {
	/** First pass's begin to last pass's end: includes any gaps between passes. */
	spanMs: number;
	/** The passes' own durations, summed. */
	sumMs: number;
	maxMs: number;
	/** The slowest pass's position in the submit, and its kind ('r' render, 'c' compute). */
	maxIndex: number;
	maxKind: string;
	/** Each pass's kind, in order. */
	kinds: string;
	/** Each pass's duration, in order. */
	each: number[];
	/**
	 * Each pass's label, in order: a render pass's is its chart's id (the
	 * coordinator labels it), a compute pass's its own name. '' without one.
	 */
	labels: string[];
}

class PassTimer {
	static readonly QUERIES = 512;
	static readonly RING = 8;
	readonly #querySet: GPUQuerySet;
	readonly #resolve: GPUBuffer;
	readonly #ring: { buffer: GPUBuffer; busy: boolean }[] = [];
	/** The readback the last finished encoder copied into, its query count and pass kinds. */
	#pending: { slot: number; count: number; kinds: string; labels: string[] } | null = null;
	readonly #restore: () => void;
	/**
	 * Whether the query set exists. Its creation can fail: Metal has few counter
	 * sample buffers, shared by every tab's devices. A pass given an invalid
	 * query set is invalid, and so is its whole frame, for every chart: so no
	 * pass is timed until the device has said the query set is good, and none
	 * ever if it is not.
	 */
	#usable = false;

	constructor(device: GPUDevice) {
		const n = PassTimer.QUERIES;
		const scopes = ['validation', 'out-of-memory', 'internal'] as const;
		for (const scope of scopes) device.pushErrorScope(scope);
		this.#querySet = device.createQuerySet({ type: 'timestamp', count: n });
		Promise.all(scopes.map(() => device.popErrorScope())).then(
			(errors) => {
				const error = errors.find((e) => e !== null);
				if (!error) this.#usable = true;
				else
					console.warn(
						'[frame-probe] No GPU pass timing: the timestamp query set could not be created ' +
							`(${error.message.split('\n')[0]}). Other tabs holding GPU devices use up the ` +
							'few Metal allows: close them, or restart the browser, for pass times.'
					);
			},
			() => {}
		);
		this.#resolve = device.createBuffer({
			size: n * 8,
			usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
		});
		for (let i = 0; i < PassTimer.RING; i++) {
			this.#ring.push({
				buffer: device.createBuffer({
					size: n * 8,
					usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
				}),
				busy: false
			});
		}
		const querySet = this.#querySet;
		const original = device.createCommandEncoder;
		device.createCommandEncoder = (descriptor?: GPUCommandEncoderDescriptor) => {
			const encoder = original.call(device, descriptor);
			let used = 0;
			let kinds = '';
			const labels: string[] = [];
			const timed = <D extends { timestampWrites?: unknown }, R>(
				begin: (d: D) => R,
				kind: string
			) => {
				return (d?: D): R => {
					const desc = (d ?? {}) as D;
					if (!this.#usable || used + 2 > n) return begin.call(encoder, desc);
					const had = desc.timestampWrites;
					desc.timestampWrites = {
						querySet,
						beginningOfPassWriteIndex: used,
						endOfPassWriteIndex: used + 1
					};
					used += 2;
					kinds += kind;
					labels.push((desc as { label?: string }).label ?? '');
					try {
						return begin.call(encoder, desc);
					} finally {
						// The coordinator reuses its pass descriptors: leave them as found.
						if (had === undefined) delete desc.timestampWrites;
						else desc.timestampWrites = had;
					}
				};
			};
			encoder.beginRenderPass = timed(
				encoder.beginRenderPass,
				'r'
			) as typeof encoder.beginRenderPass;
			encoder.beginComputePass = timed(
				encoder.beginComputePass,
				'c'
			) as typeof encoder.beginComputePass;
			const finish = encoder.finish;
			encoder.finish = (fd?: GPUCommandBufferDescriptor) => {
				const slot = used > 0 ? this.#ring.findIndex((r) => !r.busy) : -1;
				if (slot >= 0) {
					encoder.resolveQuerySet(querySet, 0, used, this.#resolve, 0);
					encoder.copyBufferToBuffer(this.#resolve, 0, this.#ring[slot].buffer, 0, used * 8);
					this.#ring[slot].busy = true;
					this.#pending = { slot, count: used, kinds, labels };
				}
				return finish.call(encoder, fd);
			};
			return encoder;
		};
		this.#restore = () => {
			device.createCommandEncoder = original;
		};
	}

	/**
	 * After a submit: its GPU time and pass count, delivered once the readback
	 * maps. Nothing when the submit's encoder was not timed.
	 */
	afterSubmit(deliver: (timing: SubmitTiming) => void): void {
		const pending = this.#pending;
		this.#pending = null;
		if (!pending) return;
		const entry = this.#ring[pending.slot];
		entry.buffer
			.mapAsync(GPUMapMode.READ, 0, pending.count * 8)
			.then(() => {
				const t = new BigInt64Array(entry.buffer.getMappedRange(0, pending.count * 8));
				let lo = t[0];
				let hi = t[1];
				let sum = 0;
				let max = 0;
				let maxAt = 0;
				const each: number[] = [];
				for (let k = 0; k < pending.count; k += 2) {
					if (t[k] < lo) lo = t[k];
					if (t[k + 1] > hi) hi = t[k + 1];
					const ms = Number(t[k + 1] - t[k]) / 1e6;
					each.push(ms);
					sum += ms;
					if (ms > max) {
						max = ms;
						maxAt = k / 2;
					}
				}
				entry.buffer.unmap();
				entry.busy = false;
				deliver({
					spanMs: Number(hi - lo) / 1e6,
					sumMs: sum,
					maxMs: max,
					maxIndex: maxAt,
					maxKind: pending.kinds[maxAt] ?? '?',
					kinds: pending.kinds,
					labels: pending.labels,
					each
				});
			})
			.catch(() => {
				entry.busy = false;
			});
	}

	destroy(): void {
		this.#restore();
		this.#querySet.destroy();
	}
}

/** A node as `tag.class`, or for one without a class, its parent's too: enough to find it. */
function describe(node: Node): string {
	const name = node.nodeName.toLowerCase();
	const cls = node instanceof Element ? (node.getAttribute('class') ?? '').split(' ')[0] : '';
	if (cls) return `${name}.${cls}`;
	const parent = node.parentElement;
	const parentCls = parent ? (parent.getAttribute('class') ?? '').split(' ')[0] : '';
	return parent
		? `${name}<${parent.nodeName.toLowerCase()}${parentCls ? '.' + parentCls : ''}`
		: name;
}

export class FrameProbe {
	readonly #ts = new Float64Array(MAX_FRAMES);
	readonly #work = new Float64Array(MAX_FRAMES);
	readonly #mutations = new Uint32Array(MAX_FRAMES);
	readonly #elementDraws = new Uint16Array(MAX_FRAMES);
	#pendingElementDraws = 0;
	/** Per kind of `CREATED`, the count per frame. */
	readonly #created = CREATED.map(() => new Uint16Array(MAX_FRAMES));
	// Made before the pass timer, which keeps the device's createCommandEncoder
	// to call: it must keep the counted one.
	readonly #counter = new CreationCounter();
	readonly #phase = new Uint16Array(MAX_FRAMES);
	#frames = 0;

	readonly #submitAt = new Float64Array(MAX_SUBMITS);
	readonly #submitDone = new Float64Array(MAX_SUBMITS);
	readonly #submitPhase = new Uint16Array(MAX_SUBMITS);
	/** GPU time of the submit's passes (timestamps, their durations summed), NaN when not timed. */
	readonly #submitPassMs = new Float64Array(MAX_SUBMITS);
	readonly #submitPasses = new Uint16Array(MAX_SUBMITS);
	readonly #submitTimings: (SubmitTiming | null)[] = [];
	#passTimer: PassTimer | null = null;
	readonly passesTimed: boolean;
	#submits = 0;

	readonly #phases: string[] = ['(none)'];
	#currentPhase = 0;
	#pendingMutations = 0;
	/**
	 * With mutations observed: per phase, how many records of each kind, by
	 * what changed and where (`attr tag.class @name`, `added tag.class in
	 * tag.class`, ...). Allocates per record, as observing itself does.
	 */
	readonly #mutationKinds: Record<string, Record<string, number>> = {};

	readonly loafs: LoafEntry[] = [];
	#running = false;
	#raf = 0;
	#channel: MessageChannel | null = null;
	#observer: MutationObserver | null = null;
	#loafObserver: PerformanceObserver | null = null;
	#restoreSubmit: (() => void) | null = null;
	/** The frame whose `work` the next message completes, or −1. */
	#awaiting = -1;
	#awaitingTs = 0;

	readonly mutationsObserved: boolean;
	readonly gpuObserved: boolean;

	constructor(options: ProbeOptions) {
		this.mutationsObserved = !!options.mutationRoot;
		this.gpuObserved = !!options.device;
		this.passesTimed = !!options.device?.features.has('timestamp-query');
		if (this.passesTimed) this.#passTimer = new PassTimer(options.device!);

		if (options.mutationRoot) {
			this.#observer = new MutationObserver((records) => {
				this.#pendingMutations += records.length;
				if (!this.#running) return;
				const kinds = (this.#mutationKinds[this.#phases[this.#currentPhase]] ??= {});
				const add = (key: string, n: number) => {
					kinds[key] = (kinds[key] ?? 0) + n;
				};
				for (const record of records) {
					const at = describe(record.target);
					if (record.type === 'attributes') add(`attr ${at} @${record.attributeName}`, 1);
					else if (record.type === 'characterData') add(`text ${at}`, 1);
					else {
						for (const node of record.addedNodes) add(`added ${describe(node)} in ${at}`, 1);
						for (const node of record.removedNodes) add(`removed ${describe(node)} in ${at}`, 1);
					}
				}
			});
			this.#observer.observe(options.mutationRoot, {
				subtree: true,
				childList: true,
				attributes: true,
				characterData: true
			});
		}

		if (options.device) {
			const queue = options.device.queue;
			const original = queue.submit;
			const submit = (buffers: Iterable<GPUCommandBuffer>): undefined => {
				original.call(queue, buffers);
				if (!this.#running || this.#submits >= MAX_SUBMITS) return;
				const i = this.#submits++;
				this.#submitAt[i] = performance.now();
				this.#submitDone[i] = NaN;
				this.#submitPhase[i] = this.#currentPhase;
				this.#submitPassMs[i] = NaN;
				this.#submitPasses[i] = 0;
				queue.onSubmittedWorkDone().then(() => {
					this.#submitDone[i] = performance.now();
				});
				// That one was the probe's own, not the page's.
				this.#counter.pending[WORK_DONE]--;
				this.#submitTimings[i] = null;
				this.#passTimer?.afterSubmit((timing) => {
					this.#submitPassMs[i] = timing.sumMs;
					this.#submitPasses[i] = timing.kinds.length;
					this.#submitTimings[i] = timing;
				});
			};
			queue.submit = submit;

			// Text atlas uploads (HTML-in-Canvas), counted per frame.
			type ElementQueue = GPUQueue & { drawElementImageToTexture?: (...args: unknown[]) => void };
			const q = queue as ElementQueue;
			const originalDraw = q.drawElementImageToTexture;
			if (originalDraw) {
				q.drawElementImageToTexture = (...args: unknown[]) => {
					originalDraw.apply(queue, args);
					if (this.#running) this.#pendingElementDraws++;
				};
			}
			this.#restoreSubmit = () => {
				queue.submit = original;
				if (originalDraw) q.drawElementImageToTexture = originalDraw;
			};
		}

		this.#channel = new MessageChannel();
		this.#channel.port1.onmessage = () => {
			const i = this.#awaiting;
			if (i < 0) return;
			this.#work[i] = performance.now() - this.#awaitingTs;
			this.#awaiting = -1;
		};

		try {
			this.#loafObserver = new PerformanceObserver((list) => {
				if (!this.#running) return;
				for (const entry of list.getEntries() as unknown as Array<
					PerformanceEntry & {
						blockingDuration: number;
						renderStart: number;
						styleAndLayoutStart: number;
						scripts: Array<{
							invoker: string;
							duration: number;
							sourceURL: string;
							sourceFunctionName: string;
						}>;
					}
				>) {
					this.loafs.push({
						start: entry.startTime,
						duration: entry.duration,
						blockingDuration: entry.blockingDuration,
						renderStart: entry.renderStart,
						styleAndLayoutStart: entry.styleAndLayoutStart,
						phase: this.#phases[this.#currentPhase],
						scripts: entry.scripts.map((s) => ({
							invoker: s.invoker,
							duration: s.duration,
							source: `${s.sourceURL.split('/').pop()}:${s.sourceFunctionName}`
						}))
					});
				}
			});
			this.#loafObserver.observe({ type: 'long-animation-frame', buffered: false });
		} catch {
			// No Long Animation Frames API: the per-frame numbers still work.
		}
	}

	/** Frames from now on belong to `name`. */
	setPhase(name: string): void {
		let i = this.#phases.indexOf(name);
		if (i < 0) i = this.#phases.push(name) - 1;
		this.#currentPhase = i;
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#pendingMutations = 0;
		this.#counter.pending.fill(0);
		const tick = (ts: number) => {
			if (!this.#running) return;
			this.#raf = requestAnimationFrame(tick);
			if (this.#frames >= MAX_FRAMES) return;
			const i = this.#frames++;
			this.#ts[i] = ts;
			this.#work[i] = NaN;
			this.#phase[i] = this.#currentPhase;
			this.#mutations[i] = this.#pendingMutations;
			this.#pendingMutations = 0;
			this.#elementDraws[i] = this.#pendingElementDraws;
			this.#pendingElementDraws = 0;
			const pending = this.#counter.pending;
			for (let k = 0; k < pending.length; k++) {
				this.#created[k][i] = Math.min(pending[k], 0xffff);
				pending[k] = 0;
			}
			this.#awaiting = i;
			this.#awaitingTs = ts;
			this.#channel!.port2.postMessage(0);
		};
		this.#raf = requestAnimationFrame(tick);
	}

	stop(): void {
		this.#running = false;
		cancelAnimationFrame(this.#raf);
	}

	destroy(): void {
		this.stop();
		this.#observer?.disconnect();
		this.#loafObserver?.disconnect();
		this.#restoreSubmit?.();
		this.#passTimer?.destroy();
		this.#counter.destroy();
		this.#channel?.port1.close();
	}

	get frameCount(): number {
		return this.#frames;
	}

	/** Per-phase summary. Cadence is the idle phase's median interval (else the run's). */
	summarize(idlePhase = 'idle'): { cadence: number; phases: PhaseSummary[] } {
		const n = this.#frames;
		const dtOf = (i: number) => (i === 0 ? NaN : this.#ts[i] - this.#ts[i - 1]);

		const collect = (phaseIndex: number | null) => {
			const dts: number[] = [];
			const works: number[] = [];
			const muts: number[] = [];
			let draws = 0;
			let drawsMax = 0;
			const made: number[][] = CREATED.map(() => []);
			// Frame 0 has no interval; a phase's first frame measures the gap
			// since the previous phase's last, which is still a real frame.
			for (let i = 1; i < n; i++) {
				if (phaseIndex !== null && this.#phase[i] !== phaseIndex) continue;
				dts.push(dtOf(i));
				if (!Number.isNaN(this.#work[i])) works.push(this.#work[i]);
				muts.push(this.#mutations[i]);
				draws += this.#elementDraws[i];
				if (this.#elementDraws[i] > drawsMax) drawsMax = this.#elementDraws[i];
				for (let k = 0; k < made.length; k++) made[k].push(this.#created[k][i]);
			}
			const created = {} as Record<CreatedKind, CreatedSummary>;
			CREATED.forEach((kind, k) => {
				const sorted = Float64Array.from(made[k]).sort();
				created[kind] = {
					total: made[k].reduce((sum, v) => sum + v, 0),
					p50: sorted.length ? quantile(sorted, 0.5) : 0,
					max: sorted.length ? sorted[sorted.length - 1] : 0
				};
			});
			return {
				dts: Float64Array.from(dts).sort(),
				works: Float64Array.from(works).sort(),
				muts: Float64Array.from(muts).sort(),
				draws,
				drawsMax,
				created
			};
		};

		const idleIndex = this.#phases.indexOf(idlePhase);
		const cadence = quantile(collect(idleIndex >= 0 ? idleIndex : null).dts, 0.5);

		const phases: PhaseSummary[] = [];
		for (let p = 1; p < this.#phases.length; p++) {
			const { dts, works, muts, draws, drawsMax, created } = collect(p);
			if (dts.length === 0) continue;
			let dropped = 0;
			let slots = 0;
			for (const dt of dts) {
				const k = Math.max(1, Math.round(dt / cadence));
				slots += k;
				dropped += k - 1;
			}
			const gpu: number[] = [];
			for (let i = 0; i < this.#submits; i++) {
				if (this.#submitPhase[i] !== p) continue;
				const done = this.#submitDone[i];
				if (!Number.isNaN(done)) gpu.push(done - this.#submitAt[i]);
			}
			const gpuSorted = Float64Array.from(gpu).sort();
			const passMs: number[] = [];
			const passes: number[] = [];
			for (let i = 0; i < this.#submits; i++) {
				if (this.#submitPhase[i] !== p || Number.isNaN(this.#submitPassMs[i])) continue;
				passMs.push(this.#submitPassMs[i]);
				passes.push(this.#submitPasses[i]);
			}
			const passMsSorted = Float64Array.from(passMs).sort();
			const passesSorted = Float64Array.from(passes).sort();
			const timed = this.passesTimed && passMs.length > 0;
			phases.push({
				phase: this.#phases[p],
				frames: dts.length,
				dtP50: quantile(dts, 0.5),
				dtP95: quantile(dts, 0.95),
				dtP99: quantile(dts, 0.99),
				dtMax: dts[dts.length - 1],
				dropped,
				droppedPct: slots ? (100 * dropped) / slots : 0,
				workP50: quantile(works, 0.5),
				workP95: quantile(works, 0.95),
				workMax: works.length ? works[works.length - 1] : NaN,
				gpuP50: this.gpuObserved && gpu.length ? quantile(gpuSorted, 0.5) : null,
				gpuP95: this.gpuObserved && gpu.length ? quantile(gpuSorted, 0.95) : null,
				passMsP50: timed ? quantile(passMsSorted, 0.5) : null,
				passMsP95: timed ? quantile(passMsSorted, 0.95) : null,
				passesP50: timed ? quantile(passesSorted, 0.5) : null,
				passesMax: timed ? passesSorted[passesSorted.length - 1] : null,
				mutationsP50: this.mutationsObserved ? quantile(muts, 0.5) : null,
				mutationsMax: this.mutationsObserved ? muts[muts.length - 1] : null,
				elementDraws: draws,
				elementDrawsMax: drawsMax,
				created,
				loafs: this.loafs.filter((l) => l.phase === this.#phases[p]).length
			});
		}
		return { cadence, phases };
	}

	/** Everything recorded, as plain arrays, for the saved log. */
	toJSON() {
		const n = this.#frames;
		const s = this.#submits;
		return {
			phases: this.#phases,
			frames: {
				ts: Array.from(this.#ts.subarray(0, n)),
				work: Array.from(this.#work.subarray(0, n)),
				mutations: this.mutationsObserved ? Array.from(this.#mutations.subarray(0, n)) : null,
				elementDraws: Array.from(this.#elementDraws.subarray(0, n)),
				created: Object.fromEntries(
					CREATED.map((kind, k) => [kind, Array.from(this.#created[k].subarray(0, n))])
				),
				phase: Array.from(this.#phase.subarray(0, n))
			},
			submits: this.gpuObserved
				? {
						at: Array.from(this.#submitAt.subarray(0, s)),
						done: Array.from(this.#submitDone.subarray(0, s)),
						phase: Array.from(this.#submitPhase.subarray(0, s)),
						passMs: Array.from(this.#submitPassMs.subarray(0, s)),
						passes: Array.from(this.#submitPasses.subarray(0, s)),
						timings: this.#submitTimings.slice(0, s)
					}
				: null,
			mutationKinds: this.mutationsObserved ? this.#mutationKinds : null,
			loafs: this.loafs
		};
	}
}
