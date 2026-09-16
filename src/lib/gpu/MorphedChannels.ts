import { VALUE_RESOLVE_SHADER, VALUE_RESOLVE_WORKGROUP } from './ValueResolveShader';
import { TransitionClock } from '$lib/animation/TransitionClock';

/**
 * Channels of one mark that morph between data updates rather than replacing
 * outright.
 *
 * Each holds three buffers where a static channel holds one: `from` and `to` are
 * read by a compute pass, and `resolved = mix(from, to, t)` is what the vertex
 * stage binds — in place of the static buffer, not in addition to it. So
 * animating a channel costs the vertex stage nothing, which is what makes it
 * affordable on a mark already at the device's storage-buffer limit.
 *
 * THE FOLD. When a transition restarts, whatever is on screen becomes the new
 * `from`. On screen is the resolved buffer as last dispatched, so the fold is a
 * buffer copy, and it reads neither `from` nor `to` — which is what lets data
 * land at any moment, in any order relative to anything else. Writing it as
 * `from = mix(from, to, t)` would need the OLD `to`, making the order of two
 * writes load-bearing and silently wrong if they ever swap.
 *
 * THE SNAP. Some updates have nothing to travel from: the first one, a buffer
 * that had to be reallocated, and a row set that is not the one being animated.
 * Those copy `to` over `from`, which makes the mix the identity for every t.
 *
 * THE CLOCK. A mark ADOPTS the band scale's clock when it has one, so a bar's
 * height travels on the same number as its slot — two clocks with two velocities
 * desynchronise on a retarget, and the bar reaches its rank before or after it
 * finishes growing. It OWNS one otherwise. Adoption is safe across marks because
 * a mark with no new data folds to where it already is and does not move.
 */

/** The coordinator's slice this needs. Structural, so tests can supply a fake. */
export interface MorphHost {
	registerComputeWork(key: string, fn: (encoder: GPUCommandEncoder) => void): void;
	removeComputeWork(key: string): void;
	addAnimatedSource(source: TransitionClock): void;
	removeAnimatedSource(source: TransitionClock): void;
}

/** A scale that owns a data-transition clock marks can adopt. */
interface ClockHost {
	clock: TransitionClock;
	startTransition(): void;
}

export interface MorphedChannelsOptions {
	device: GPUDevice;
	host: MorphHost;
	/** Unique per renderer; also the compute-work key. */
	label: string;
	/** The chart's scale on an axis, or null. */
	scaleFor(axis: 'x' | 'y'): unknown;
	/** Charts to redraw while this mark's OWN clock runs. */
	affectedCharts(): string[];
}

type BandAxis = 'x' | 'y';

interface Channel {
	from: GPUBuffer;
	to: GPUBuffer;
	resolved: GPUBuffer;
	params: GPUBuffer;
	/** Bytes allocated, the same for all three data buffers. */
	size: number;
	/** Rows in use; the dispatch covers these and no more. */
	count: number;
	bindGroup: GPUBindGroup | null;
	/** What `params` holds, so a frame that changes neither writes nothing. */
	paramsCount: number;
	paramsT: number;
}

const PIPELINES = new WeakMap<GPUDevice, GPUComputePipeline>();

/** One resolve pipeline per device: the kernel is channel-agnostic. */
function pipelineFor(device: GPUDevice): GPUComputePipeline {
	let pipeline = PIPELINES.get(device);
	if (!pipeline) {
		pipeline = device.createComputePipeline({
			label: 'value-resolve',
			layout: 'auto',
			compute: {
				module: device.createShaderModule({ label: 'value-resolve', code: VALUE_RESOLVE_SHADER }),
				entryPoint: 'main'
			}
		});
		PIPELINES.set(device, pipeline);
	}
	return pipeline;
}

/**
 * A cheap fingerprint of the band ids, per update.
 *
 * Morphing assumes row `i` is the same category on every update. That is
 * guaranteed upstream — one row per category, in category order — and it has
 * silently not been, more than once; the failure looks like data, a bar
 * travelling to its neighbour's value and back. So the claim is checked, and a
 * change snaps rather than interpolates. A hash rather than a comparison
 * because it costs one pass and no retained copy.
 */
export function alignmentKey(ids: ArrayLike<number>): number {
	let hash = ids.length;
	for (let i = 0; i < ids.length; i++) hash = (hash * 31 + ids[i]) | 0;
	return hash;
}

export class MorphedChannels {
	#device: GPUDevice;
	#host: MorphHost;
	#label: string;
	#scaleFor: (axis: BandAxis) => unknown;
	#affectedCharts: () => string[];

	#channels = new Map<number, Channel>();
	#registered = false;

	#alignmentKey: number | null = null;
	#bandAxis: BandAxis | null = null;

	/** The next dispatch starts from `to`. */
	#snapPending = false;
	/** The next dispatch starts from what is on screen. */
	#foldPending = false;
	/** `to` changed since `resolved` was last computed. */
	#dirty = false;
	/** The t `resolved` was last computed at. */
	#resolvedT = 1;

	/** Last version seen from the clock, to notice a restart this mark did not cause. */
	#lastClockVersion: number | null = null;
	#ownClock: TransitionClock | null = null;

	#paramsScratch = new ArrayBuffer(16);
	#paramsView = new DataView(this.#paramsScratch);

	constructor(options: MorphedChannelsOptions) {
		this.#device = options.device;
		this.#host = options.host;
		this.#label = options.label;
		this.#scaleFor = options.scaleFor;
		this.#affectedCharts = options.affectedCharts;
	}

	/** The buffer the vertex stage binds for this channel, if it morphs. */
	resolved(binding: number): GPUBuffer | undefined {
		return this.#channels.get(binding)?.resolved;
	}

	/**
	 * One data update: every morphing channel's new values, and the band ids
	 * that say which category each row is.
	 *
	 * All channels in one call, so one update starts one transition. Returns
	 * whether any buffer was (re)allocated, which the caller must rebind.
	 */
	write(
		bandAxis: BandAxis,
		bandIds: ArrayLike<number>,
		channels: readonly (readonly [number, AllowSharedBufferSource])[]
	): boolean {
		const key = alignmentKey(bandIds);
		let travels = this.#alignmentKey === key && this.#bandAxis === bandAxis;
		if (this.#bandAxis !== bandAxis) this.#lastClockVersion = null;
		this.#alignmentKey = key;
		this.#bandAxis = bandAxis;

		let reallocated = false;
		for (const [binding, data] of channels) {
			let channel = this.#channels.get(binding);
			if (!channel || channel.size < data.byteLength) {
				channel = this.#allocate(binding, data.byteLength, channel);
				reallocated = true;
			}
			channel.count = data.byteLength >> 2;
			this.#device.queue.writeBuffer(channel.to, 0, data as ArrayBufferView<ArrayBuffer>);
		}
		// A fresh buffer holds nothing that was ever on screen, so there is
		// nothing to fold from — including when only one channel grew.
		if (reallocated) travels = false;

		this.#dirty = true;
		if (travels) this.#startTransition();
		else this.#snapPending = true;

		if (!this.#registered) {
			this.#registered = true;
			this.#host.registerComputeWork(this.#label, (encoder) => this.encode(encoder));
		}
		return reallocated;
	}

	/**
	 * Stop morphing a channel and release its buffers. Returns whether it was
	 * morphing, in which case the caller's binding has lost its buffer.
	 */
	drop(binding: number): boolean {
		const channel = this.#channels.get(binding);
		if (!channel) return false;
		this.#destroyChannel(channel);
		this.#channels.delete(binding);
		return true;
	}

	/**
	 * Fold or snap, then resolve every channel, in one encoder and one pass.
	 *
	 * The copy has to precede the pass: the fold reads what the previous
	 * dispatch resolved, and this one is about to overwrite it.
	 *
	 * Skipped entirely when nothing would change — no pending fold or snap, no
	 * new data, and the same t as last time. At rest that is every frame, which
	 * matters because the coordinator runs compute work on every frame it
	 * renders, and hover and pan render a lot of frames.
	 *
	 * Each channel keeps its own params buffer: queue writes all land before any
	 * command in the submit, so one buffer shared across dispatches would give
	 * every dispatch the last channel's values.
	 */
	encode(encoder: GPUCommandEncoder): void {
		if (this.#channels.size === 0) return;

		const { t, restarted } = this.#readClock();
		if (restarted) this.#foldPending = true;
		const snap = this.#snapPending;
		const resolveT = snap ? 1 : t;

		if (!snap && !this.#foldPending && !this.#dirty && resolveT === this.#resolvedT) return;

		for (const channel of this.#channels.values()) {
			if (snap) {
				encoder.copyBufferToBuffer(channel.to, 0, channel.from, 0, channel.size);
			} else if (this.#foldPending) {
				// A transition interrupted mid-flight continues from where it is,
				// and one at rest copies `to` onto itself, which is correct without
				// being a special case.
				encoder.copyBufferToBuffer(channel.resolved, 0, channel.from, 0, channel.size);
			}
		}
		this.#snapPending = false;
		this.#foldPending = false;
		this.#dirty = false;
		this.#resolvedT = resolveT;

		const pipeline = pipelineFor(this.#device);
		const pass = encoder.beginComputePass({ label: `${this.#label}-resolve` });
		pass.setPipeline(pipeline);
		for (const channel of this.#channels.values()) {
			if (channel.count === 0) continue;

			if (channel.paramsCount !== channel.count || channel.paramsT !== resolveT) {
				this.#paramsView.setUint32(0, channel.count, true);
				this.#paramsView.setFloat32(4, resolveT, true);
				this.#device.queue.writeBuffer(channel.params, 0, this.#paramsScratch);
				channel.paramsCount = channel.count;
				channel.paramsT = resolveT;
			}

			channel.bindGroup ??= this.#device.createBindGroup({
				layout: pipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: channel.from } },
					{ binding: 1, resource: { buffer: channel.to } },
					{ binding: 2, resource: { buffer: channel.resolved } },
					{ binding: 3, resource: { buffer: channel.params } }
				]
			});
			pass.setBindGroup(0, channel.bindGroup);
			pass.dispatchWorkgroups(Math.ceil(channel.count / VALUE_RESOLVE_WORKGROUP));
		}
		pass.end();
	}

	/**
	 * Release everything. Unregisters FIRST: the coordinator runs compute work
	 * every frame, and a closure over destroyed buffers turns teardown into a
	 * validation error on the next frame, with nothing left to name the cause.
	 */
	destroy(): void {
		if (this.#registered) {
			this.#host.removeComputeWork(this.#label);
			this.#registered = false;
		}
		if (this.#ownClock) {
			this.#host.removeAnimatedSource(this.#ownClock);
			this.#ownClock = null;
		}
		for (const channel of this.#channels.values()) this.#destroyChannel(channel);
		this.#channels.clear();
	}

	#allocate(binding: number, required: number, previous: Channel | undefined): Channel {
		if (previous) this.#destroyChannel(previous);

		const BLOCK = 256;
		const size = (Math.ceil(Math.ceil(required * 1.5) / BLOCK) * BLOCK + 3) & ~3;
		const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
		const make = (role: string) =>
			this.#device.createBuffer({ size, usage, label: `${this.#label}-${binding}-${role}` });

		const channel: Channel = {
			from: make('from'),
			to: make('to'),
			resolved: make('resolved'),
			params: this.#device.createBuffer({
				size: 16,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				label: `${this.#label}-${binding}-params`
			}),
			size,
			count: 0,
			bindGroup: null,
			paramsCount: -1,
			paramsT: -1
		};
		this.#channels.set(binding, channel);
		return channel;
	}

	#destroyChannel(channel: Channel): void {
		channel.from.destroy();
		channel.to.destroy();
		channel.resolved.destroy();
		channel.params.destroy();
	}

	/** The band axis's scale, when it owns a clock this mark should adopt. */
	#clockHost(): ClockHost | null {
		if (!this.#bandAxis) return null;
		const scale = this.#scaleFor(this.#bandAxis) as Partial<ClockHost> | null | undefined;
		return scale?.clock && scale.startTransition ? (scale as ClockHost) : null;
	}

	#startTransition(): void {
		const scale = this.#clockHost();
		if (scale) {
			scale.startTransition();
			return;
		}
		this.#ownClock ??= new TransitionClock();
		// Read at start rather than construction: a facet grid registers its
		// cells after the mark's first data has landed.
		this.#ownClock._affectedChartsArray = this.#affectedCharts();
		this.#ownClock.restart();
		// Every time: the loop evicts a clock when it settles.
		this.#host.addAnimatedSource(this.#ownClock);
	}

	/**
	 * Where the clock is, and whether it restarted since last asked.
	 *
	 * A restart this mark did not cause still resets `t` to 0 — a sibling mark's
	 * data landing on the same axis, or another facet cell — and without folding
	 * on it this mark's values snap back to where its own transition started.
	 *
	 * The clock's own version, not the slot table's: settling bumps the slot
	 * version while no new transition began. The first observation is not a
	 * restart, or the opening frame would fold against nothing.
	 */
	#readClock(): { t: number; restarted: boolean } {
		const clock = this.#clockHost()?.clock ?? this.#ownClock;
		if (!clock) {
			this.#lastClockVersion = null;
			return { t: 1, restarted: false };
		}
		const restarted = this.#lastClockVersion !== null && clock.version !== this.#lastClockVersion;
		this.#lastClockVersion = clock.version;
		return { t: clock.t, restarted };
	}
}
