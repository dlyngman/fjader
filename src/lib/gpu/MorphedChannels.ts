import {
	VALUE_RESOLVE_IMMEDIATE_SIZE,
	VALUE_RESOLVE_SHADER,
	VALUE_RESOLVE_WORKGROUP
} from './ValueResolveShader';
import { TransitionClock, type ClockLoop } from '$lib/animation/TransitionClock';
import { immediatesSupported } from './immediates';

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

/**
 * The coordinator's slice this needs. Structural, so tests can supply a fake.
 * It is also the loop an owned clock joins — the clock does that itself.
 */
export interface MorphHost extends ClockLoop {
	registerComputeWork(key: string, fn: (encoder: GPUCommandEncoder) => void): void;
	removeComputeWork(key: string): void;
}

/** A scale's slots, when they own a data-transition clock marks can adopt. */
export interface ClockHost {
	clock: TransitionClock;
	startTransition(): void;
}

export interface MorphedChannelsOptions {
	device: GPUDevice;
	host: MorphHost;
	/** Unique per renderer; also the compute-work key. */
	label: string;
	/**
	 * The clock to adopt, or null to own one. Asked on every encode rather than
	 * once, because the scale that supplies it can arrive after the first data.
	 */
	clockHost(): ClockHost | null;
	/** Charts to redraw while this mark's OWN clock runs. */
	affectedCharts(): string[];
}

interface Channel {
	from: GPUBuffer;
	to: GPUBuffer;
	resolved: GPUBuffer;
	/** Bytes allocated, the same for all three data buffers. */
	size: number;
	/** Rows in use; the dispatch covers these and no more. */
	count: number;
	bindGroup: GPUBindGroup | null;
}

interface ResolvePipeline {
	pipeline: GPUComputePipeline;
	layout: GPUBindGroupLayout;
}

const PIPELINES = new WeakMap<GPUDevice, ResolvePipeline>();

/**
 * One resolve pipeline per device: the kernel is channel-agnostic.
 *
 * An explicit layout rather than 'auto', so the immediate range is stated here
 * and not left to how a default layout infers it.
 */
function pipelineFor(device: GPUDevice): ResolvePipeline {
	let entry = PIPELINES.get(device);
	if (!entry) {
		const stage = GPUShaderStage.COMPUTE;
		const layout = device.createBindGroupLayout({
			label: 'value-resolve',
			entries: [
				{ binding: 0, visibility: stage, buffer: { type: 'read-only-storage' } },
				{ binding: 1, visibility: stage, buffer: { type: 'read-only-storage' } },
				{ binding: 2, visibility: stage, buffer: { type: 'storage' } }
			]
		});
		const pipeline = device.createComputePipeline({
			label: 'value-resolve',
			layout: device.createPipelineLayout({
				label: 'value-resolve',
				bindGroupLayouts: [layout],
				immediateSize: VALUE_RESOLVE_IMMEDIATE_SIZE
			}),
			compute: {
				module: device.createShaderModule({ label: 'value-resolve', code: VALUE_RESOLVE_SHADER }),
				entryPoint: 'main'
			}
		});
		entry = { pipeline, layout };
		PIPELINES.set(device, entry);
	}
	return entry;
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
	#clockHostFor: () => ClockHost | null;
	#affectedCharts: () => string[];

	#channels = new Map<number, Channel>();
	/**
	 * The same channels as an array, for the per-frame loops: iterating a Map
	 * allocates an iterator, and encode runs on every rendered frame.
	 */
	#channelList: Channel[] = [];
	#registered = false;

	#alignmentKey: number | null = null;

	/** The next dispatch starts from `to`. */
	#snapPending = false;
	/** The next dispatch starts from what is on screen. */
	#foldPending = false;
	/** `to` changed since `resolved` was last computed. */
	#dirty = false;
	/** The t `resolved` was last computed at. */
	#resolvedT = 1;

	/**
	 * The clock last read, and its version then — to notice a restart this mark
	 * did not cause. Both, because a version only means something against the
	 * clock it came from: a mark that starts adopting a scale's clock, or whose
	 * scale is replaced, is reading a different counter.
	 */
	#lastClock: TransitionClock | null = null;
	#lastClockVersion = 0;
	/** #readClock's results, in fields rather than a returned object. */
	#clockT = 1;
	#clockRestarted = false;
	/** Built once: a descriptor per encode would be an allocation per frame. */
	#passDescriptor: GPUComputePassDescriptor;
	#ownClock: TransitionClock | null = null;

	#immediates = new ArrayBuffer(VALUE_RESOLVE_IMMEDIATE_SIZE);
	#immediatesView = new DataView(this.#immediates);

	/**
	 * Whether this browser can run the resolve kernel at all.
	 *
	 * Where immediates are missing a mark writes these channels as static, which
	 * is what it did before morphing existed. In practice the coordinator has
	 * already refused the device by then — the slot kernel needs the same
	 * feature and cannot degrade — so this fallback is reachable only if that
	 * floor is ever lowered. It is kept because a silent snap is the right
	 * behaviour for THIS half either way.
	 */
	static get supported(): boolean {
		return immediatesSupported();
	}

	constructor(options: MorphedChannelsOptions) {
		this.#device = options.device;
		this.#host = options.host;
		this.#label = options.label;
		this.#clockHostFor = options.clockHost;
		this.#affectedCharts = options.affectedCharts;
		this.#passDescriptor = { label: `${options.label}-resolve` };
	}

	/** The buffer the vertex stage binds for this channel, if it morphs. */
	resolved(binding: number): GPUBuffer | undefined {
		return this.#channels.get(binding)?.resolved;
	}

	/**
	 * One data update: every morphing channel's new values, and the ids that say
	 * which category each row is.
	 *
	 * All channels in one call, so one update starts one transition. Returns
	 * whether any buffer was (re)allocated, which the caller must rebind.
	 */
	write(
		rowIds: ArrayLike<number>,
		channels: readonly (readonly [number, AllowSharedBufferSource])[]
	): boolean {
		const key = alignmentKey(rowIds);
		let travels = this.#alignmentKey === key;
		this.#alignmentKey = key;

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
		this.#channelList = [...this.#channels.values()];
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
	 * `count` and `t` go to each dispatch as immediates, which are pass state set
	 * in command order — so each dispatch reads its own, with no buffer to write.
	 */
	encode(encoder: GPUCommandEncoder): void {
		const channels = this.#channelList;
		if (channels.length === 0) return;

		this.#readClock();
		const t = this.#clockT;
		if (this.#clockRestarted) this.#foldPending = true;
		const snap = this.#snapPending;
		const resolveT = snap ? 1 : t;

		if (!snap && !this.#foldPending && !this.#dirty && resolveT === this.#resolvedT) return;

		for (let i = 0; i < channels.length; i++) {
			const channel = channels[i];
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

		const { pipeline, layout } = pipelineFor(this.#device);
		const pass = encoder.beginComputePass(this.#passDescriptor);
		pass.setPipeline(pipeline);
		this.#immediatesView.setFloat32(4, resolveT, true);
		for (let i = 0; i < channels.length; i++) {
			const channel = channels[i];
			if (channel.count === 0) continue;

			channel.bindGroup ??= this.#device.createBindGroup({
				layout,
				entries: [
					{ binding: 0, resource: { buffer: channel.from } },
					{ binding: 1, resource: { buffer: channel.to } },
					{ binding: 2, resource: { buffer: channel.resolved } }
				]
			});
			this.#immediatesView.setUint32(0, channel.count, true);
			pass.setImmediates(0, this.#immediates);
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
		this.#ownClock?.stop();
		this.#ownClock = null;
		for (const channel of this.#channelList) this.#destroyChannel(channel);
		this.#channels.clear();
		this.#channelList = [];
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
			size,
			count: 0,
			bindGroup: null
		};
		this.#channels.set(binding, channel);
		this.#channelList = [...this.#channels.values()];
		return channel;
	}

	#destroyChannel(channel: Channel): void {
		channel.from.destroy();
		channel.to.destroy();
		channel.resolved.destroy();
	}

	/**
	 * The clock this mark runs on: the host's when there is one, its own
	 * otherwise. Never both — adopting stops the clock it owned, and the switch
	 * reads as a restart, so the next encode folds from what is on screen.
	 */
	#clock(host: ClockHost | null): TransitionClock | null {
		if (!host) return this.#ownClock;
		if (this.#ownClock) {
			this.#ownClock.stop();
			this.#ownClock = null;
		}
		return host.clock;
	}

	/**
	 * Start a transition — unless one is already waiting to be folded.
	 *
	 * New data on an aligned row set means a new transition, and for a
	 * value-only update nothing else would start one. But a write often lands
	 * right behind a restart it did not issue: the reorder its own result caused,
	 * or a sibling's. If the clock has restarted since this mark last folded, the
	 * next encode folds that restart, and the new `to` goes along with it —
	 * issuing a second restart would only repeat the scale's O(dim) slot fold and
	 * re-upload its slot tables, for nothing.
	 */
	#startTransition(): void {
		const host = this.#clockHostFor();
		const clock = this.#clock(host);
		if (clock && clock === this.#lastClock && clock.version !== this.#lastClockVersion) {
			return;
		}
		if (host) {
			host.startTransition();
			return;
		}
		// The charts are asked for, not captured: a facet grid registers its
		// cells after the mark's first data has landed.
		this.#ownClock ??= new TransitionClock({ loop: this.#host, charts: this.#affectedCharts });
		this.#ownClock.restart();
	}

	/**
	 * Where the clock is, and whether it restarted since last asked.
	 *
	 * A restart this mark did not cause still resets `t` to 0 — a sibling mark's
	 * data landing on the same axis, or another facet cell — and without folding
	 * on it this mark's values snap back to where its own transition started.
	 *
	 * The clock's own version, not the slot table's: settling bumps the slot
	 * version while no new transition began. A DIFFERENT clock from last time
	 * counts as a restart too — its t has nothing to do with the old one's, so
	 * continuing without a fold would jump. The first clock ever read is not a
	 * restart: until then nothing has animated, and `from` already equals what
	 * is on screen.
	 */
	#readClock(): void {
		const clock = this.#clock(this.#clockHostFor());
		if (!clock) {
			this.#lastClock = null;
			this.#clockT = 1;
			this.#clockRestarted = false;
			return;
		}
		const last = this.#lastClock;
		this.#clockRestarted =
			last !== null && (clock !== last || clock.version !== this.#lastClockVersion);
		this.#lastClock = clock;
		this.#lastClockVersion = clock.version;
		this.#clockT = clock.t;
	}
}
