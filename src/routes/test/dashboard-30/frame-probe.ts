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
 * And per `queue.submit`, the time until the GPU reports that work done
 * (`onSubmittedWorkDone`): an upper bound on GPU time per frame, since it
 * includes any queueing behind earlier work.
 *
 * Storage is preallocated typed arrays, so recording allocates nothing per
 * frame and does not disturb what it measures.
 */

const MAX_FRAMES = 30_000;
const MAX_SUBMITS = 60_000;

export interface ProbeOptions {
	/** The element whose subtree mutations are counted, or null for none. */
	mutationRoot: Element | null;
	/** The device whose queue submissions are timed, or null for none. */
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
	mutationsP50: number | null;
	mutationsMax: number | null;
	loafs: number;
}

function quantile(sorted: Float64Array, q: number): number {
	if (sorted.length === 0) return NaN;
	const i = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
	return sorted[i];
}

export class FrameProbe {
	readonly #ts = new Float64Array(MAX_FRAMES);
	readonly #work = new Float64Array(MAX_FRAMES);
	readonly #mutations = new Uint32Array(MAX_FRAMES);
	readonly #phase = new Uint16Array(MAX_FRAMES);
	#frames = 0;

	readonly #submitAt = new Float64Array(MAX_SUBMITS);
	readonly #submitDone = new Float64Array(MAX_SUBMITS);
	readonly #submitPhase = new Uint16Array(MAX_SUBMITS);
	#submits = 0;

	readonly #phases: string[] = ['(none)'];
	#currentPhase = 0;
	#pendingMutations = 0;

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

		if (options.mutationRoot) {
			this.#observer = new MutationObserver((records) => {
				this.#pendingMutations += records.length;
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
				queue.onSubmittedWorkDone().then(() => {
					this.#submitDone[i] = performance.now();
				});
			};
			queue.submit = submit;
			this.#restoreSubmit = () => {
				queue.submit = original;
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
			// Frame 0 has no interval; a phase's first frame measures the gap
			// since the previous phase's last, which is still a real frame.
			for (let i = 1; i < n; i++) {
				if (phaseIndex !== null && this.#phase[i] !== phaseIndex) continue;
				dts.push(dtOf(i));
				if (!Number.isNaN(this.#work[i])) works.push(this.#work[i]);
				muts.push(this.#mutations[i]);
			}
			return {
				dts: Float64Array.from(dts).sort(),
				works: Float64Array.from(works).sort(),
				muts: Float64Array.from(muts).sort()
			};
		};

		const idleIndex = this.#phases.indexOf(idlePhase);
		const cadence = quantile(collect(idleIndex >= 0 ? idleIndex : null).dts, 0.5);

		const phases: PhaseSummary[] = [];
		for (let p = 1; p < this.#phases.length; p++) {
			const { dts, works, muts } = collect(p);
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
				mutationsP50: this.mutationsObserved ? quantile(muts, 0.5) : null,
				mutationsMax: this.mutationsObserved ? muts[muts.length - 1] : null,
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
				phase: Array.from(this.#phase.subarray(0, n))
			},
			submits: this.gpuObserved
				? {
						at: Array.from(this.#submitAt.subarray(0, s)),
						done: Array.from(this.#submitDone.subarray(0, s)),
						phase: Array.from(this.#submitPhase.subarray(0, s))
					}
				: null,
			loafs: this.loafs
		};
	}
}
