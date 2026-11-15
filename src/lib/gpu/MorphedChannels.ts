import { noteTransition, transitionsObserved } from '$lib/animation/transition-log';
import { RESOLVE_IMMEDIATE_SIZE, RESOLVE_WORKGROUP, resolvePipelineFor } from './ResolveShader';
import { TransitionClock, type ClockLoop } from '$lib/animation/TransitionClock';
import { immediatesSupported } from './immediates';
import { FOLD_IMMEDIATE_SIZE, foldPipelineFor } from './FoldShader';
import { foldScaleKind, type FoldScaleKind } from './ScaleNormalize';

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

/** No bindings: the default for `write`'s `land`. */
const NO_BINDINGS: readonly number[] = [];

/**
 * The coordinator's slice this needs. Structural, so tests can supply a fake.
 * It is also the loop an owned clock joins — the clock does that itself.
 */
export interface MorphHost extends ClockLoop {
	registerComputeWork(key: string, fn: (encoder: GPUCommandEncoder) => void): void;
	removeComputeWork(key: string): void;
	/**
	 * Whether a chart is in this frame's draw list. A mark whose charts are
	 * not records what it would fold from but does not fold: nobody sees it.
	 * Absent: every chart counts as drawn.
	 */
	chartDrawnThisFrame?(chartId: string): boolean;
}

/**
 * The scale a morphing channel's values are measured on, as a fold reads it:
 * its params as the shaders read them (`gpuState`, packed as
 * `#writeScaleParam` packs them) and the count of its folding snaps.
 */
export interface FoldScale {
	readonly snapCount: number;
	readonly gpuState: {
		readonly domainMin: number;
		readonly domainMax: number;
		readonly domainScale: number;
		readonly p4: number;
	};
	readonly scaleType?: string;
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
	/**
	 * The scale a binding's values are measured on, or null for one that is
	 * not (a band id, an Other share). Asked on every encode, like `clockHost`.
	 * Absent: no binding folds.
	 */
	scaleFor?(binding: number): FoldScale | null;
}

interface Channel {
	binding: number;
	from: GPUBuffer;
	to: GPUBuffer;
	resolved: GPUBuffer;
	/** Bytes allocated, the same for all three data buffers. */
	size: number;
	/** Rows in use; the dispatch covers these and no more. */
	count: number;
	bindGroup: GPUBindGroup | null;
	/** Written to land at once rather than travel: `from` takes `to` at the next encode. */
	land: boolean;
	/**
	 * The params of this channel's scale at its last encode: what its values
	 * were drawn with. Packed as the shaders read them. Valid once `drawnSet`.
	 */
	drawn: Float32Array;
	drawnSet: boolean;
	/** The scale's `snapCount` at the last encode. */
	snapSeen: number;
	/** This encode folds the channel through the scale's snap, into `current`. */
	fold: FoldScaleKind | null;
	/** The scale's params as this frame draws them. */
	current: Float32Array;
	/** The scale `drawn` and `snapSeen` belong to. */
	scale: FoldScale | null;
	foldBindGroup: GPUBindGroup | null;
	/** The kind `foldBindGroup` was made for: each kind has its own layout. */
	foldBindGroupKind: FoldScaleKind | null;
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
 *
 * Over the values' bits, read through a view of the same buffer: a
 * histogram's rows are keyed by bin edges, fractions a sum would truncate
 * away, so a re-bin could otherwise hash like the bins it replaced.
 */
export function alignmentKey(ids: ArrayLike<number>): number {
	const bits =
		ids instanceof Float32Array ? new Uint32Array(ids.buffer, ids.byteOffset, ids.length) : ids;
	let hash = bits.length;
	for (let i = 0; i < bits.length; i++) hash = (Math.imul(hash, 31) + bits[i]) | 0;
	return hash;
}

export class MorphedChannels {
	#device: GPUDevice;
	#host: MorphHost;
	#label: string;
	#clockHostFor: () => ClockHost | null;
	#affectedCharts: () => string[];
	#scaleFor: ((binding: number) => FoldScale | null) | null;

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

	/** `count`, `t`, `offset`. A channel owns its buffers, so `offset` stays 0. */
	#immediates = new ArrayBuffer(RESOLVE_IMMEDIATE_SIZE);
	#immediatesView = new DataView(this.#immediates);
	/** The fold's: `count`, then the drawn and current params (FoldShader). */
	#foldImmediates = new ArrayBuffer(FOLD_IMMEDIATE_SIZE);
	#foldImmediatesView = new DataView(this.#foldImmediates);

	/**
	 * Whether this browser can run the resolve kernel at all.
	 *
	 * Where immediates are missing a mark writes these channels as static, which
	 * is what it did before morphing existed. In practice the coordinator has
	 * already refused the device by then — the slot tables resolve through the
	 * same kernel and cannot degrade — so this fallback is reachable only if that
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
		this.#scaleFor = options.scaleFor ?? null;
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
	 *
	 * `land`: bindings whose new values take effect at once while the rest
	 * travel. For a channel whose change is shown some other way at that moment
	 * (an Other bar's split, when both sides of it look the same): sliding it
	 * would draw a movement nothing asked for. `'all'`: the whole update lands,
	 * for a catch-up result (MarkHandle.resultCause).
	 */
	write(
		rowIds: ArrayLike<number>,
		channels: readonly (readonly [number, AllowSharedBufferSource])[],
		land: readonly number[] | 'all' = NO_BINDINGS
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
			channel.land = land === 'all' || land.includes(binding);
			this.#device.queue.writeBuffer(channel.to, 0, data as ArrayBufferView<ArrayBuffer>);
		}
		// A fresh buffer holds nothing that was ever on screen, so there is
		// nothing to fold from — including when only one channel grew.
		if (reallocated) travels = false;

		this.#dirty = true;
		// Every channel landing travels nothing, so it starts no transition: on
		// a shared band clock a restart would set every sibling folding for a
		// transition with nowhere to go.
		// A loop, not `every`: this runs on each data update of a brush, and
		// the callback would allocate per write.
		let allLand = land === 'all';
		if (land !== 'all' && land.length > 0) {
			allLand = true;
			for (let i = 0; i < channels.length; i++) {
				if (!land.includes(channels[i][0])) {
					allLand = false;
					break;
				}
			}
		}
		if (travels && !allLand) this.#startTransition();
		else if (!travels) this.#snapPending = true;
		if (transitionsObserved()) {
			// Snaps when the row set changed or a buffer grew, or every channel lands.
			noteTransition('morph', !travels || allLand, this.#affectedCharts, this.#label);
		}

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

		// Scale snaps first: a fold restarts the clock, which the read below
		// then sees, and its plain fold must not copy over the folded `from`.
		const snap = this.#snapPending;
		if (this.#takeScaleSnaps(snap)) {
			this.#startTransition();
			// Every other channel folds from where it is too, explicitly. The
			// clock read below may not report a restart: a mark that never had a
			// transition gets its first clock here, and a first clock is not
			// read as one. That every channel of such a mark has from == to is
			// true today, but it is a chain of reasoning, not a guarantee.
			this.#foldPending = true;
			if (transitionsObserved()) {
				noteTransition('morph', false, this.#affectedCharts, this.#label);
			}
		}

		this.#readClock();
		const t = this.#clockT;
		if (this.#clockRestarted) this.#foldPending = true;
		const resolveT = snap ? 1 : t;

		if (!snap && !this.#foldPending && !this.#dirty && resolveT === this.#resolvedT) return;

		let folds = false;
		for (let i = 0; i < channels.length; i++) {
			const channel = channels[i];
			if (snap || channel.land) {
				// A landed channel: from = to, so the mix is its new value at any t.
				encoder.copyBufferToBuffer(channel.to, 0, channel.from, 0, channel.size);
				channel.land = false;
				channel.fold = null;
			} else if (channel.fold) {
				// Its scale snapped: `from` is what is on screen, re-expressed in the
				// new domain, written by the fold dispatch in the pass below.
				folds = true;
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

		const pass = encoder.beginComputePass(this.#passDescriptor);
		// Folds before resolves: each writes a `from` the resolve below reads.
		// Dispatches in one pass see each other's writes, in order.
		if (folds) this.#encodeFolds(pass);

		const { pipeline, layout } = resolvePipelineFor(this.#device);
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
			pass.dispatchWorkgroups(Math.ceil(channel.count / RESOLVE_WORKGROUP));
		}
		pass.end();
	}

	/**
	 * Record what each scaled channel is drawn with this frame, and mark the
	 * ones whose scale made a folding snap since their last encode (its
	 * `snapCount` moved) to fold from the params they were drawn with to these.
	 * Every frame, at rest too: a fold needs the params of the frame before it.
	 *
	 * Not on a snap of the row set (`snap`: nothing aligned to fold), not for a
	 * channel landing at once, and not while none of the mark's charts is drawn
	 * this frame: nobody sees it, so the params are recorded and the snap is
	 * used up, and the return to view (its first frame seen) keeps nothing.
	 * Returns whether any channel folds.
	 */
	#takeScaleSnaps(snap: boolean): boolean {
		const scaleFor = this.#scaleFor;
		if (!scaleFor) return false;
		const channels = this.#channelList;
		// Asked once, and only when a snap is seen: the common frame asks nothing.
		let onScreen: boolean | null = null;
		let any = false;
		for (let i = 0; i < channels.length; i++) {
			const channel = channels[i];
			channel.fold = null;
			const scale = scaleFor(channel.binding);
			const kind = scale ? foldScaleKind(scale.scaleType) : null;
			if (!scale || !kind) {
				channel.scale = null;
				channel.drawnSet = false;
				continue;
			}
			// Another scale's count says nothing about this one's snaps.
			if (scale !== channel.scale) {
				channel.scale = scale;
				channel.drawnSet = false;
				// Built now rather than at the first fold (cached per device and
				// kind): a shader that does not compile shows when the mark first
				// draws, not on the rare frame a snap folds.
				foldPipelineFor(this.#device, kind);
			}
			// "What this frame draws": nothing in JS changes gpuState between
			// the compute work and the draw passes of one frame (frame order:
			// updateRenderState, compute, draw). Should that order change, so
			// does what `drawn` means.
			const g = scale.gpuState;
			const current = channel.current;
			current[0] = g.domainMin;
			current[1] = g.domainMax;
			current[2] = g.domainScale;
			current[3] = g.p4;
			const snapped = channel.drawnSet && scale.snapCount !== channel.snapSeen;
			channel.snapSeen = scale.snapCount;
			if (snapped && !snap && !channel.land && (onScreen ??= this.#onScreen())) {
				// `drawn` still holds last frame's params; #encodeFolds takes it.
				channel.fold = kind;
				any = true;
			} else {
				channel.drawn.set(current);
				channel.drawnSet = true;
			}
		}
		return any;
	}

	/** Whether any of the mark's charts is drawn this frame (the host's draw list). */
	#onScreen(): boolean {
		const drawn = this.#host.chartDrawnThisFrame;
		if (!drawn) return true;
		const charts = this.#affectedCharts();
		for (let i = 0; i < charts.length; i++) {
			if (drawn.call(this.#host, charts[i])) return true;
		}
		return false;
	}

	/**
	 * The fold dispatches, one per folding channel: `from` takes its on-screen
	 * values in the new domain (FoldShader). Each then draws with the params it
	 * folded into.
	 */
	#encodeFolds(pass: GPUComputePassEncoder): void {
		const channels = this.#channelList;
		const view = this.#foldImmediatesView;
		for (let i = 0; i < channels.length; i++) {
			const channel = channels[i];
			const kind = channel.fold;
			if (!kind) continue;
			channel.fold = null;
			if (channel.count > 0) {
				const { pipeline, layout } = foldPipelineFor(this.#device, kind);
				pass.setPipeline(pipeline);
				// The layout is the kind's, so a bind group is too.
				if (channel.foldBindGroupKind !== kind) {
					channel.foldBindGroup = this.#device.createBindGroup({
						layout,
						entries: [
							{ binding: 0, resource: { buffer: channel.resolved } },
							{ binding: 1, resource: { buffer: channel.from } }
						]
					});
					channel.foldBindGroupKind = kind;
				}
				view.setUint32(0, channel.count, true);
				for (let k = 0; k < 4; k++) {
					view.setFloat32(16 + 4 * k, channel.drawn[k], true);
					view.setFloat32(32 + 4 * k, channel.current[k], true);
				}
				pass.setImmediates(0, this.#foldImmediates);
				pass.setBindGroup(0, channel.foldBindGroup!);
				pass.dispatchWorkgroups(Math.ceil(channel.count / RESOLVE_WORKGROUP));
			}
			channel.drawn.set(channel.current);
			channel.drawnSet = true;
		}
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

		// A fresh channel was never drawn, so it has nothing to fold from.
		const channel: Channel = {
			binding,
			from: make('from'),
			to: make('to'),
			resolved: make('resolved'),
			size,
			count: 0,
			bindGroup: null,
			land: false,
			drawn: new Float32Array(4),
			drawnSet: false,
			snapSeen: 0,
			fold: null,
			current: new Float32Array(4),
			scale: null,
			foldBindGroup: null,
			foldBindGroupKind: null
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
