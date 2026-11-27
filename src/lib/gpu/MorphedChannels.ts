import { noteTransition, transitionsObserved } from '$lib/animation/transition-log';
import {
	RESOLVE_IMMEDIATE_SIZE,
	RESOLVE_WORKGROUP,
	SCALED_RESOLVE_IMMEDIATE_SIZE,
	resolvePipelineFor,
	scaledResolvePipelineFor
} from './ResolveShader';
import { TransitionClock, type ClockLoop } from '$lib/animation/TransitionClock';
import { immediatesSupported } from './immediates';
import { foldScaleKind, type FoldScaleKind } from './ScaleNormalize';
import {
	GATHER_IMMEDIATE_SIZE,
	REMAP_IMMEDIATE_SIZE,
	gatherPipelineFor,
	remapPipelineFor,
	type RemapCurve,
	type RemapKind
} from './RemapShader';

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
 *
 * THE SCALE. A channel measured on a continuous scale (`scaleFor`: a bar's
 * value edges) resolves in pixel space: `from` keeps the scale params it was
 * drawn under (`fromParams`, taken whenever `from` is set: a snap or a landing
 * takes this frame's, a fold or a remap the previous frame's), and the resolve
 * mixes the two POSITIONS, drawn under the scale as it is now (ResolveShader).
 * Any other channel (an Other share, a band id) resolves as a plain mix.
 *
 * THE RIDE. While the scale runs a unit-change tween (`tween`: a rebin's new
 * unit), a scaled channel that is moving rides it instead of its own clock:
 * `to` is placed under the TARGET domain and the mix weight is the channel's
 * share of the scale's progress, `g = (f − f0) / (1 − f0)`, `f0` the f its
 * `from` was drawn at. Every value on the scale then travels on one progress,
 * from where it was drawn to where the target puts it, so a pure change of
 * unit holds a bar's height exactly; against the moving domain instead, `to`
 * would be a moving end point and bars dip. Every segment start re-anchors (a
 * new segment, data landing, the mark's own transition), the tween's end
 * lands, and a channel at rest stays out: drawn under the moving domain, `to`
 * already follows the static path, at no cost.
 *
 * THE GATHER. While a merge holds its layout (BaseGPURenderer), a write
 * carries the new rows in the NEW layout and a map onto the held one: the
 * rows stay, `to` takes each held row's parent value (RemapShader's gather)
 * and the write travels as an aligned one. `whenLanding` tells the renderer
 * when it has landed, so it can write the new layout.
 */

/**
 * How close to 1 a fold's `f0` lands instead of riding: `g = (f − f0)/(1 − f0)`
 * has nothing left to divide. Far below a tween's rest precision on f.
 */
const LAND_EPS = 1e-4;

/** No bindings: the default for `write`'s `land`. */
const NO_BINDINGS: readonly number[] = [];

/**
 * The coordinator's slice this needs. Structural, so tests can supply a fake.
 * It is also the loop an owned clock joins — the clock does that itself.
 */
export interface MorphHost extends ClockLoop {
	registerMorphWork(key: string, work: MorphWork): void;
	removeMorphWork(key: string): void;
}

/**
 * A mark's morph work for one frame, in the two halves a shared pass needs.
 * The host calls `prepare` on every mark's, then opens ONE compute pass and
 * calls `dispatch` on those that asked for it: a pass per mark was a pass
 * object per animating mark per frame.
 */
export interface MorphWork {
	/**
	 * What must be on the encoder, outside a pass: the fold's copies. They
	 * read what the previous frame resolved, which this frame's dispatches
	 * overwrite, so every mark's come before the pass. False when there is
	 * nothing to dispatch (at rest).
	 */
	prepare(encoder: GPUCommandEncoder): boolean;
	/** The remaps, gathers and resolves, into the pass. After a true `prepare` only. */
	dispatch(pass: GPUComputePassEncoder): void;
}

/**
 * The scale a morphing channel's values are measured on, as its resolve reads
 * it: the params the shaders draw with (`gpuState`, packed as
 * `#writeScaleParam` packs them) and its type.
 */
export interface ChannelScale {
	readonly gpuState: {
		readonly domainMin: number;
		readonly domainMax: number;
		readonly domainScale: number;
		readonly p4: number;
	};
	readonly scaleType?: string;
	/**
	 * The scale's unit-change tween while one runs (`LinearScaleState.tween`):
	 * its segment, the progress `f` this frame was drawn at, and the target
	 * domain's params. Null or absent otherwise.
	 */
	readonly tween?: Readonly<{
		segment: number;
		f: number;
		targetParams: ChannelScale['gpuState'];
	}> | null;
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
	 * Absent: every binding resolves as a plain mix.
	 */
	scaleFor?(binding: number): ChannelScale | null;
	/**
	 * The curve a path's rows are drawn with, for a rebin's remap and gather
	 * to sample it (RemapShader's RemapCurve), or null to apply the map's
	 * weights as they are. Asked per dispatch, once per rebin. Absent: null.
	 */
	curve?(): RemapCurve | null;
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
	 * The params of this channel's scale at its last encode: what `resolved`
	 * holds values under. Packed as the shaders read them. Valid once
	 * `drawnSet`.
	 */
	drawn: Float32Array;
	drawnSet: boolean;
	/** The scale's params as this frame draws them. */
	current: Float32Array;
	/** The params `from` holds values under: set wherever `from` is. */
	fromParams: Float32Array;
	/**
	 * Riding the scale's tween: the channel mixes by its share of the scale's
	 * progress, `g = (f − f0) / (1 − f0)`, with `to` under the target params.
	 * Set when `from` is taken during a tween (a fold, a remap), cleared when
	 * `from` takes `to` (a snap, a landing, the tween's end).
	 */
	riding: boolean;
	/** The segment ridden, and the scale's `f` that `from` was drawn at. */
	segment: number;
	f0: number;
	/** This frame's tween as read (#readScales): whether one runs, its segment, f, target. */
	tweenOn: boolean;
	tweenSegment: number;
	tweenF: number;
	target: Float32Array;
	/** The tween's segment (−1: none) and f at the last encode: what `resolved` was drawn at. */
	drawnSegment: number;
	drawnF: number;
	/** From the tween, for the next encode: fold into a new segment; land (the tween ended). */
	foldHere: boolean;
	landHere: boolean;
	/**
	 * `from` took `to` (a snap, a landing) and nothing has been taken from the
	 * screen since: the value is `to`, exactly, whatever t a clock still
	 * running says and wherever the domain goes. Cleared by a fold or a remap.
	 */
	settled: boolean;
	/** The scale `drawn` belongs to, and the kind it resolves with (null: a plain mix). */
	scale: ChannelScale | null;
	kind: FoldScaleKind | null;
	/** The pixel-space resolve's bind group, and the kind its layout belongs to. */
	scaledBindGroup: GPUBindGroup | null;
	scaledBindGroupKind: FoldScaleKind | null;
	/**
	 * A pending remap reads this channel's old rows from here: its `resolved`
	 * as last drawn (a buffer kept through a reallocation, or the current one).
	 * Null without a remap, or for a channel with nothing on screen (it snaps).
	 */
	remapSource: GPUBuffer | null;
	/** The new rows a pending gather reads (a hold's write), in the new layout. */
	gatherSource: GPUBuffer | null;
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

export class MorphedChannels implements MorphWork {
	#device: GPUDevice;
	#host: MorphHost;
	#label: string;
	#clockHostFor: () => ClockHost | null;
	#affectedCharts: () => string[];
	#scaleFor: ((binding: number) => ChannelScale | null) | null;
	#curve: (() => RemapCurve | null) | null;

	#channels = new Map<number, Channel>();
	/**
	 * The same channels as an array, for the per-frame loops: iterating a Map
	 * allocates an iterator, and encode runs on every rendered frame.
	 */
	#channelList: Channel[] = [];
	#registered = false;

	#alignmentKey: number | null = null;

	/**
	 * A pending remap's map buffer (bin-remap.ts): set by a rebin write, read
	 * by the next encode's remap dispatches, then retired. Each channel's old
	 * rows are its `remapSource`.
	 */
	#remap: GPUBuffer | null = null;
	/**
	 * Buffers a remap has read (its map, a source kept through a
	 * reallocation), destroyed at the start of the next encode: by then the
	 * frame that read them has been submitted, and destroying a buffer in use
	 * by submitted work is allowed, where one only recorded is not.
	 */
	#retired: GPUBuffer[] = [];

	/** A pending gather's map (a hold's write): new bins onto the held ones. */
	#gather: GPUBuffer | null = null;
	/** Called once, from an encode, when nothing moves any more (whenAtRest). */
	#restWaiter: (() => void) | null = null;
	/** The share of a ride or clock by which the rows arrive (write's `lead`). */
	#lead = 1;
	#gatherImmediates = new ArrayBuffer(GATHER_IMMEDIATE_SIZE);
	#gatherImmediatesView = new DataView(this.#gatherImmediates);
	/** The next dispatch starts from `to`. */
	#snapPending = false;
	/** The next dispatch starts from what is on screen. */
	#foldPending = false;
	/** `to` changed since `resolved` was last computed. */
	#dirty = false;
	/** The t `resolved` was last computed at. */
	#resolvedT = 1;
	/** A channel rides a tween, or has a fold or landing from one: no early return. */
	#tweenWork = false;

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
	/** What `prepare` decided, for the `dispatch` that follows it. */
	#stagedT = 1;
	#stagedRemap: GPUBuffer | null = null;
	#stagedRemaps = false;
	#ownClock: TransitionClock | null = null;

	/** `count`, `t`, `offset`. A channel owns its buffers, so `offset` stays 0. */
	#immediates = new ArrayBuffer(RESOLVE_IMMEDIATE_SIZE);
	#immediatesView = new DataView(this.#immediates);
	/** The pixel-space resolve's: `count`, `t`, `offset`, a pad, then `fromParams` and `current`. */
	#scaledImmediates = new ArrayBuffer(SCALED_RESOLVE_IMMEDIATE_SIZE);
	#scaledImmediatesView = new DataView(this.#scaledImmediates);
	/** The remap's: `count` padded to 16, then the drawn and current params (RemapShader). */
	#remapImmediates = new ArrayBuffer(REMAP_IMMEDIATE_SIZE);
	#remapImmediatesView = new DataView(this.#remapImmediates);

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
		this.#curve = options.curve ?? null;
		this.#passDescriptor = { label: `${options.label}-resolve` };
	}

	/** Whether `binding` morphs: a hold can gather only into channels it has. */
	has(binding: number): boolean {
		return this.#channels.has(binding);
	}

	/**
	 * Call `fn` once, from an encode, when every channel has arrived (by its
	 * share of the scale's tween while riding one, by the clock otherwise, each
	 * through the write's lead) and no write is pending. Replaces any earlier
	 * waiter. Called from inside the frame's compute work: `fn` must not write
	 * buffers a draw this frame binds (defer it, e.g. to a microtask).
	 */
	whenLanding(fn: (() => void) | null): void {
		this.#restWaiter = fn;
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
		land: readonly number[] | 'all' = NO_BINDINGS,
		/**
		 * For a write whose row set is a rebin of the one on screen: the map
		 * from the old bins to the new (`buildBinRemap`). The new rows then
		 * start where the old ones they cover were drawn, and travel, rather
		 * than snap. Ignored when the row set did not change.
		 */
		remap: Uint32Array | null = null,
		/**
		 * For a write during a merge's hold: the map from these rows' (new)
		 * bins onto the held ones (`buildBinRemap(new, held)`). The held rows
		 * stay, `rowIds` and `land` are not read, and every channel must
		 * already morph (`has`). See THE GATHER. With `remap` too, a CUT: the
		 * rows become `rowIds` (the held bars cut at the new edges), `from`
		 * comes from the held rows on screen through `remap`, and `to` from
		 * these rows through `gather`.
		 */
		gather: Uint32Array | null = null,
		/**
		 * With `gather`: the share of the ride by which these rows arrive (a
		 * hold's: they converge before the swap, so the new layout takes over
		 * where they are). 1 arrives with the ride. Any other write resets it.
		 */
		lead = 1
	): boolean {
		if (gather && remap && this.#alignmentKey !== null) {
			this.#lead = lead;
			return this.#writeCut(rowIds, channels, remap, gather);
		}
		if (gather && this.#alignmentKey !== null) {
			this.#lead = lead;
			this.#writeGather(channels, gather);
			return false;
		}
		this.#lead = 1;
		// Any other write replaces `to` outright: a gather still pending would
		// overwrite it with the held layout's.
		if (this.#gather) this.#retireGather();
		const key = alignmentKey(rowIds);
		let travels = this.#alignmentKey === key;
		const hadRows = this.#alignmentKey !== null;
		this.#alignmentKey = key;

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

		// A rebin: the new rows start from the old ones on screen, through the
		// map. Only from rows that were drawn and with nothing pending: a
		// second rebin before the first one ran maps from a layout `resolved`
		// never held, so it snaps (and the pending remap is dropped).
		let remapping = false;
		if (!travels && remap && !allLand && hadRows) {
			if (this.#remap) this.#retireRemap();
			else remapping = true;
		} else if (!travels && this.#remap) {
			this.#retireRemap();
		}

		let reallocated = false;
		for (const [binding, data] of channels) {
			let channel = this.#channels.get(binding);
			// The buffer a remap reads the old rows from: this channel's
			// resolved, kept alive through a reallocation until it has run.
			const source = remapping ? (channel?.resolved ?? null) : null;
			if (!channel || channel.size < data.byteLength) {
				channel = this.#allocate(binding, data.byteLength, channel, source !== null);
				reallocated = true;
			}
			channel.count = data.byteLength >> 2;
			channel.land = land === 'all' || land.includes(binding);
			if (remapping) channel.remapSource = source;
			this.#device.queue.writeBuffer(channel.to, 0, data as ArrayBufferView<ArrayBuffer>);
		}
		// A fresh buffer holds nothing that was ever on screen, so there is
		// nothing to fold from — including when only one channel grew. A remap
		// reads the old rows from the buffer it kept, so it still travels.
		if (reallocated && !remapping) travels = false;

		if (remapping) {
			const map = this.#device.createBuffer({
				size: Math.max(16, remap!.byteLength),
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				label: `${this.#label}-remap`
			});
			this.#device.queue.writeBuffer(map, 0, remap as Uint32Array<ArrayBuffer>);
			this.#remap = map;
		}

		this.#dirty = true;
		if (remapping) {
			this.#startTransition();
		} else if (travels && this.#remap) {
			// Absorbed: a pending remap takes an aligned write along (the same
			// new rows); its transition carries the new `to`. Not a fold:
			// `resolved` is still in the old layout.
		} else if (travels && !allLand) {
			// Every transition a mark starts folds from what is on screen, whether
			// or not a clock read would notice it: an own clock created by this
			// write has never been read, and its first read is not a restart.
			this.#foldPending = true;
			this.#startTransition();
		} else if (!travels) {
			this.#snapPending = true;
		}
		if (transitionsObserved()) {
			// Snaps when the row set changed with no map, a buffer grew, or every
			// channel lands. A remapped rebin travels.
			const lands = remapping ? false : !travels || allLand;
			noteTransition('morph', lands, this.#affectedCharts, this.#label);
		}

		if (!this.#registered) {
			this.#registered = true;
			this.#host.registerMorphWork(this.#label, this);
		}
		return reallocated;
	}

	/**
	 * A hold's write: each channel's new rows go to a buffer of their own for
	 * the gather, which writes the held `to` in the next encode. The held rows
	 * fold from the screen and travel, as an aligned write does. With a remap
	 * pending (the held layout was written this frame and has not run), the
	 * remap builds `from` and the gather `to`: no fold.
	 */
	#writeGather(
		channels: readonly (readonly [number, AllowSharedBufferSource])[],
		gather: Uint32Array,
		/** Fold from the screen (a hold); false for a cut, whose remap builds `from`. */
		fold = true
	): void {
		for (const [binding, data] of channels) {
			const channel = this.#channels.get(binding);
			if (!channel) continue;
			if (channel.gatherSource) this.#retired.push(channel.gatherSource);
			const source = this.#device.createBuffer({
				size: Math.max(16, data.byteLength),
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				label: `${this.#label}-${binding}-gather`
			});
			this.#device.queue.writeBuffer(source, 0, data as ArrayBufferView<ArrayBuffer>);
			channel.gatherSource = source;
			channel.land = false;
		}
		if (this.#gather) this.#retired.push(this.#gather);
		const map = this.#device.createBuffer({
			size: Math.max(16, gather.byteLength),
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			label: `${this.#label}-gather-map`
		});
		this.#device.queue.writeBuffer(map, 0, gather as Uint32Array<ArrayBuffer>);
		this.#gather = map;

		this.#dirty = true;
		if (fold && !this.#remap) this.#foldPending = true;
		this.#startTransition();
		if (transitionsObserved()) noteTransition('morph', false, this.#affectedCharts, this.#label);
		if (!this.#registered) {
			this.#registered = true;
			this.#host.registerMorphWork(this.#label, this);
		}
	}

	/**
	 * A cut's write: a new row set (the pieces), whose `from` is the held rows
	 * on screen through the remap (one held parent each), and whose `to` is
	 * the new rows through the gather (one new parent each). It travels. With
	 * a remap already pending, the held rows on screen are not the ones the
	 * maps are from: it snaps to the gathered values instead.
	 */
	#writeCut(
		rowIds: ArrayLike<number>,
		channels: readonly (readonly [number, AllowSharedBufferSource])[],
		remap: Uint32Array,
		gather: Uint32Array
	): boolean {
		const pending = this.#remap !== null;
		if (pending) this.#retireRemap();
		if (this.#gather) this.#retireGather();
		this.#alignmentKey = alignmentKey(rowIds);
		const bytes = rowIds.length * 4;
		let reallocated = false;
		for (const [binding] of channels) {
			let channel = this.#channels.get(binding);
			if (!channel) continue;
			const source = pending ? null : channel.resolved;
			if (channel.size < bytes) {
				channel = this.#allocate(binding, bytes, channel, source !== null);
				reallocated = true;
			}
			channel.count = rowIds.length;
			channel.land = false;
			channel.remapSource = source;
		}
		// `to` from the gather; the sources are this write's rows, new layout.
		this.#writeGather(channels, gather, false);
		if (pending) {
			this.#snapPending = true;
		} else {
			const map = this.#device.createBuffer({
				size: Math.max(16, remap.byteLength),
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				label: `${this.#label}-remap`
			});
			this.#device.queue.writeBuffer(map, 0, remap as Uint32Array<ArrayBuffer>);
			this.#remap = map;
			this.#foldPending = false;
		}
		return reallocated;
	}

	/** Drop a pending gather (another write replaced `to`): its buffers go after this frame. */
	#retireGather(): void {
		if (this.#gather) this.#retired.push(this.#gather);
		this.#gather = null;
		for (const channel of this.#channelList) {
			if (channel.gatherSource) this.#retired.push(channel.gatherSource);
			channel.gatherSource = null;
		}
	}

	/**
	 * The gather dispatches, one per channel with new rows: the held `to`
	 * takes each held row's parent value (RemapShader's gather). In the pass
	 * after any remap and before the resolves, which read `to`.
	 */
	#encodeGathers(pass: GPUComputePassEncoder, map: GPUBuffer): void {
		const channels = this.#channelList;
		const { pipeline, layout } = gatherPipelineFor(this.#device, this.#curve?.() ?? null);
		for (let i = 0; i < channels.length; i++) {
			const channel = channels[i];
			const source = channel.gatherSource;
			if (!source) continue;
			channel.gatherSource = null;
			if (channel.count > 0) {
				pass.setPipeline(pipeline);
				// Per write: the source is a different buffer each time.
				const bindGroup = this.#device.createBindGroup({
					layout,
					entries: [
						{ binding: 0, resource: { buffer: source } },
						{ binding: 1, resource: { buffer: channel.to } },
						{ binding: 2, resource: { buffer: map } }
					]
				});
				this.#gatherImmediatesView.setUint32(0, channel.count, true);
				pass.setImmediates(0, this.#gatherImmediates);
				pass.setBindGroup(0, bindGroup);
				pass.dispatchWorkgroups(Math.ceil(channel.count / RESOLVE_WORKGROUP));
			}
			this.#retired.push(source);
		}
		this.#retired.push(map);
		this.#gather = null;
	}

	/**
	 * Progress `g` (a ride's share, or the clock) as the rows travel it: with a
	 * lead below 1 they arrive at `lead` and stay. Past 1 (a spring's
	 * overshoot) unchanged, so it is continuous at 1.
	 */
	#led(g: number): number {
		const lead = this.#lead;
		if (lead >= 1 || g >= 1) return g;
		return Math.min(g / lead, 1);
	}

	/**
	 * Tell a waiter (whenLanding) that every channel has arrived: a
	 * riding channel by its share of the tween as drawn this frame, any other
	 * by the clock (or landed). No write may be pending. After the encode's own
	 * work, so a landing this frame counts.
	 */
	#notifyRest(): void {
		const waiter = this.#restWaiter;
		if (!waiter) return;
		if (this.#gather || this.#remap) return;
		if (this.#foldPending || this.#snapPending || this.#dirty) return;
		const channels = this.#channelList;
		for (let i = 0; i < channels.length; i++) {
			const channel = channels[i];
			if (channel.count === 0) continue;
			if (channel.riding) {
				if (this.#led((channel.tweenF - channel.f0) / (1 - channel.f0)) < 1) return;
			} else if (!channel.settled && this.#led(this.#resolvedT) < 1) {
				return;
			}
		}
		this.#restWaiter = null;
		waiter();
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
	 * Fold or snap, then resolve every channel, in one encoder and a pass of
	 * its own: `prepare` and `dispatch` together, for a host with no shared
	 * pass. The coordinator calls the halves (`MorphWork`).
	 */
	encode(encoder: GPUCommandEncoder): void {
		if (!this.prepare(encoder)) return;
		const pass = encoder.beginComputePass(this.#passDescriptor);
		this.dispatch(pass);
		pass.end();
	}

	/**
	 * The fold or snap: the copies, on the encoder.
	 *
	 * The copy has to precede the pass: the fold reads what the previous
	 * dispatch resolved, and this one is about to overwrite it.
	 *
	 * Skipped entirely when nothing would change — no pending fold or snap, no
	 * new data, and the same t as last time. At rest that is every frame, which
	 * matters because the coordinator runs this on every frame it renders, and
	 * hover and pan render a lot of frames.
	 */
	prepare(encoder: GPUCommandEncoder): boolean {
		const channels = this.#channelList;
		if (channels.length === 0) return false;

		// What a remap read last frame: that frame has been submitted since.
		if (this.#retired.length > 0) this.#destroyRetired();

		// Each scaled channel's params as this frame draws them.
		this.#readScales();

		const snap = this.#snapPending;
		const remap = this.#remap;
		this.#readClock();
		const t = this.#clockT;
		if (this.#clockRestarted) this.#foldPending = true;
		const resolveT = snap ? 1 : t;

		if (
			!snap &&
			!this.#foldPending &&
			!this.#dirty &&
			resolveT === this.#resolvedT &&
			!this.#tweenWork
		) {
			this.#moveDrawn();
			this.#notifyRest();
			return false;
		}

		let remaps = false;
		for (let i = 0; i < channels.length; i++) {
			const channel = channels[i];
			if (snap || channel.land || (remap && !channel.remapSource)) {
				// A landed channel: from = to, so the mix is its new value at any t.
				// So is a rebin's channel with no old rows on screen. `to` is
				// drawn under this frame's params, and so is `from` now. It does
				// not ride a tween: drawn under the moving domain, `to` already
				// follows every static value's path.
				this.#landChannel(encoder, channel);
				if (channel.remapSource && channel.remapSource !== channel.resolved) {
					this.#retired.push(channel.remapSource);
				}
				channel.remapSource = null;
			} else if (remap) {
				// A rebin: `from` is the old rows on screen, mapped onto the new
				// bins, written by the remap dispatch in the pass below.
				remaps = true;
				channel.settled = false;
				this.#ride(channel);
			} else if (this.#foldPending || channel.foldHere) {
				// A transition interrupted mid-flight continues from where it is,
				// and one at rest copies `to` onto itself, which is correct without
				// being a special case. `resolved` holds values under last frame's
				// params, so `from` does now: every fold takes them. A fold during a
				// tween rides it from the f those params were drawn at.
				if (!this.#ride(channel) && channel.tweenOn && channel.kind) {
					// Folded as the tween lands (f0 at 1): nothing left to ride.
					this.#landChannel(encoder, channel);
				} else {
					encoder.copyBufferToBuffer(channel.resolved, 0, channel.from, 0, channel.size);
					channel.fromParams.set(channel.drawnSet ? channel.drawn : channel.current);
					channel.settled = false;
				}
			} else if (channel.landHere) {
				// The tween ended: the domain is its target, so `to` is where the
				// ride ends. Landing it stops a clock still running from
				// mixing it back.
				this.#landChannel(encoder, channel);
			}
			channel.foldHere = false;
			channel.landHere = false;
		}
		this.#snapPending = false;
		this.#foldPending = false;
		this.#dirty = false;
		this.#resolvedT = resolveT;
		this.#stagedT = resolveT;
		this.#stagedRemap = remap;
		this.#stagedRemaps = remaps;
		return true;
	}

	/**
	 * Resolve every channel, into a pass that may hold other marks' work.
	 *
	 * `count` and `t` go to each dispatch as immediates, which are pass state set
	 * in command order — so each dispatch reads its own, with no buffer to write.
	 * Nothing here relies on the pass's state as it arrives: every dispatch sets
	 * its pipeline, its bind group and its immediates.
	 */
	dispatch(pass: GPUComputePassEncoder): void {
		const channels = this.#channelList;
		const resolveT = this.#stagedT;
		const remap = this.#stagedRemap;
		const remaps = this.#stagedRemaps;
		this.#stagedRemap = null;
		// Remaps before resolves: each writes a `from` the resolve below reads.
		// Dispatches in one pass see each other's writes, in order.
		if (remaps) this.#encodeRemaps(pass, remap!);
		else if (remap) this.#retireRemap();
		// Gathers after remaps, before resolves: they write the `to` both read.
		const gather = this.#gather;
		if (gather) this.#encodeGathers(pass, gather);

		this.#immediatesView.setFloat32(4, this.#led(resolveT), true);
		let plainSet = false;
		for (let i = 0; i < channels.length; i++) {
			const channel = channels[i];
			if (channel.count === 0) continue;
			const kind = channel.kind;
			if (kind) {
				const { pipeline, layout } = scaledResolvePipelineFor(this.#device, kind);
				pass.setPipeline(pipeline);
				plainSet = false;
				if (channel.scaledBindGroupKind !== kind) {
					channel.scaledBindGroup = this.#device.createBindGroup({
						layout,
						entries: [
							{ binding: 0, resource: { buffer: channel.from } },
							{ binding: 1, resource: { buffer: channel.to } },
							{ binding: 2, resource: { buffer: channel.resolved } }
						]
					});
					channel.scaledBindGroupKind = kind;
				}
				// Riding: its share of the scale's progress, unclamped (the axis
				// overshoots with f, and so does the bar), `to` under the target.
				// Otherwise the mark's clock, `to` under this frame's params.
				const riding = channel.riding;
				const view = this.#scaledImmediatesView;
				view.setUint32(0, channel.count, true);
				view.setFloat32(
					4,
					this.#led(riding ? (channel.tweenF - channel.f0) / (1 - channel.f0) : resolveT),
					true
				);
				view.setUint32(12, !riding && (channel.settled || resolveT >= 1) ? 1 : 0, true);
				const toParams = riding ? channel.target : channel.current;
				for (let k = 0; k < 4; k++) {
					view.setFloat32(16 + 4 * k, channel.fromParams[k], true);
					view.setFloat32(32 + 4 * k, toParams[k], true);
					view.setFloat32(48 + 4 * k, channel.current[k], true);
				}
				pass.setImmediates(0, this.#scaledImmediates);
				pass.setBindGroup(0, channel.scaledBindGroup!);
			} else {
				const { pipeline, layout } = resolvePipelineFor(this.#device);
				if (!plainSet) {
					pass.setPipeline(pipeline);
					plainSet = true;
				}
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
			}
			pass.dispatchWorkgroups(Math.ceil(channel.count / RESOLVE_WORKGROUP));
		}
		this.#moveDrawn();
		this.#notifyRest();
	}

	/**
	 * Each scaled channel's scale and its params as this frame draws them
	 * (`current`). "What this frame draws": nothing in JS changes gpuState
	 * between the compute work and the draw passes of one frame (frame order:
	 * updateRenderState, compute, draw). Should that order change, so does what
	 * `drawn` means. A channel whose scale changes starts with no record, and
	 * builds its pipeline at once, so a shader that does not compile shows when
	 * the mark first draws.
	 */
	#readScales(): void {
		const scaleFor = this.#scaleFor;
		const channels = this.#channelList;
		let work = false;
		for (let i = 0; i < channels.length; i++) {
			const channel = channels[i];
			const scale = scaleFor ? scaleFor(channel.binding) : null;
			const kind = scale ? foldScaleKind(scale.scaleType) : null;
			if (!scale || !kind) {
				channel.scale = null;
				channel.kind = null;
				channel.drawnSet = false;
				channel.tweenOn = false;
				channel.tweenSegment = -1;
				if (channel.riding) {
					channel.landHere = true;
					work = true;
				}
				continue;
			}
			if (scale !== channel.scale || kind !== channel.kind) {
				channel.scale = scale;
				channel.kind = kind;
				channel.drawnSet = false;
				scaledResolvePipelineFor(this.#device, kind);
			}
			const g = scale.gpuState;
			const current = channel.current;
			current[0] = g.domainMin;
			current[1] = g.domainMax;
			current[2] = g.domainScale;
			current[3] = g.p4;
			// A channel that has not drawn yet holds values under these params.
			if (!channel.drawnSet) channel.fromParams.set(current);

			const tween = scale.tween ?? null;
			if (tween) {
				channel.tweenOn = true;
				channel.tweenSegment = tween.segment;
				channel.tweenF = tween.f;
				const p = tween.targetParams;
				const target = channel.target;
				target[0] = p.domainMin;
				target[1] = p.domainMax;
				target[2] = p.domainScale;
				target[3] = p.p4;
			} else {
				channel.tweenOn = false;
				channel.tweenSegment = -1;
			}
			if (channel.riding) {
				// A new segment re-anchors from the screen; the tween's end lands.
				if (!tween) channel.landHere = true;
				else if (tween.segment !== channel.segment) channel.foldHere = true;
				work = true;
			} else if (tween && this.#resolvedT < 1) {
				// Mid-way on its own clock when a tween runs: join it, or its `to`
				// would chase the moving domain. A channel at rest stays out: drawn
				// under the moving domain it already follows the static path.
				channel.foldHere = true;
				work = true;
			}
		}
		this.#tweenWork = work;
	}

	/**
	 * Start riding the scale's tween from `from` as about to be taken (a fold,
	 * a remap: last frame's screen), or not, without one. `f0` is the f that
	 * screen was drawn at: last frame's within the same segment, 0 on a new
	 * one (it starts where the last one was drawn). False also when `f0` is at
	 * 1 (|1 − f0| below LAND_EPS, either side: a fold during an overshoot has
	 * f0 > 1 and still rides, g running 0 → 1 as f falls back): the tween is
	 * landing and `g` would divide by nothing.
	 */
	#ride(channel: Channel): boolean {
		if (!channel.kind || !channel.tweenOn) {
			channel.riding = false;
			return false;
		}
		const f0 = channel.drawnSegment === channel.tweenSegment ? channel.drawnF : 0;
		if (Math.abs(1 - f0) < LAND_EPS) {
			channel.riding = false;
			return false;
		}
		channel.f0 = f0;
		channel.segment = channel.tweenSegment;
		channel.riding = true;
		return true;
	}

	/** `from` takes `to`, under this frame's params: the mix is `to` at any t. */
	#landChannel(encoder: GPUCommandEncoder, channel: Channel): void {
		encoder.copyBufferToBuffer(channel.to, 0, channel.from, 0, channel.size);
		channel.fromParams.set(channel.current);
		channel.land = false;
		channel.riding = false;
		channel.settled = true;
	}

	/** After an encode: what was drawn this frame is what the next one moves from. */
	#moveDrawn(): void {
		const channels = this.#channelList;
		for (let i = 0; i < channels.length; i++) {
			const channel = channels[i];
			if (!channel.kind) continue;
			channel.drawn.set(channel.current);
			channel.drawnSet = true;
			channel.drawnSegment = channel.tweenOn ? channel.tweenSegment : -1;
			channel.drawnF = channel.tweenF;
		}
	}

	/**
	 * The remap dispatches, one per channel with old rows: `from` takes the old
	 * rows on screen, mapped onto the new bins (RemapShader), in the units they
	 * were drawn in, which become `fromParams`. Then the map and any source
	 * kept through a reallocation are retired.
	 */
	#encodeRemaps(pass: GPUComputePassEncoder, map: GPUBuffer): void {
		const channels = this.#channelList;
		const view = this.#remapImmediatesView;
		for (let i = 0; i < channels.length; i++) {
			const channel = channels[i];
			const source = channel.remapSource;
			if (!source) continue;
			channel.remapSource = null;
			const drawn = channel.drawnSet ? channel.drawn : channel.current;
			const kind: RemapKind = channel.kind ?? 'none';
			if (channel.count > 0) {
				const { pipeline, layout } = remapPipelineFor(this.#device, kind, this.#curve?.() ?? null);
				pass.setPipeline(pipeline);
				// Per remap: the old buffer is a different one each rebin.
				const bindGroup = this.#device.createBindGroup({
					layout,
					entries: [
						{ binding: 0, resource: { buffer: source } },
						{ binding: 1, resource: { buffer: channel.to } },
						{ binding: 2, resource: { buffer: channel.from } },
						{ binding: 3, resource: { buffer: map } }
					]
				});
				view.setUint32(0, channel.count, true);
				for (let k = 0; k < 4; k++) {
					view.setFloat32(16 + 4 * k, drawn[k], true);
					view.setFloat32(32 + 4 * k, channel.current[k], true);
				}
				pass.setImmediates(0, this.#remapImmediates);
				pass.setBindGroup(0, bindGroup);
				pass.dispatchWorkgroups(Math.ceil(channel.count / RESOLVE_WORKGROUP));
			}
			channel.fromParams.set(drawn);
			if (source !== channel.resolved) this.#retired.push(source);
		}
		this.#retired.push(map);
		this.#remap = null;
	}

	#destroyRetired(): void {
		for (let i = 0; i < this.#retired.length; i++) this.#retired[i].destroy();
		this.#retired.length = 0;
	}

	/**
	 * Release everything. Unregisters FIRST: the coordinator runs compute work
	 * every frame, and a closure over destroyed buffers turns teardown into a
	 * validation error on the next frame, with nothing left to name the cause.
	 */
	destroy(): void {
		if (this.#registered) {
			this.#host.removeMorphWork(this.#label);
			this.#registered = false;
		}
		this.#ownClock?.stop();
		this.#ownClock = null;
		this.#restWaiter = null;
		this.#retireRemap();
		this.#retireGather();
		this.#destroyRetired();
		for (const channel of this.#channelList) this.#destroyChannel(channel);
		this.#channels.clear();
		this.#channelList = [];
	}

	/**
	 * Drop a pending remap that will not run (another rebin came first): its
	 * map and the sources it kept go, after this frame like any it read.
	 */
	#retireRemap(): void {
		if (this.#remap) this.#retired.push(this.#remap);
		this.#remap = null;
		for (const channel of this.#channelList) {
			if (channel.remapSource && channel.remapSource !== channel.resolved) {
				this.#retired.push(channel.remapSource);
			}
			channel.remapSource = null;
		}
	}

	#allocate(
		binding: number,
		required: number,
		previous: Channel | undefined,
		/** Keep the old `resolved`: a remap reads the old rows from it. */
		keepResolved = false
	): Channel {
		if (previous) {
			previous.from.destroy();
			previous.to.destroy();
			if (!keepResolved) previous.resolved.destroy();
		}

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
			current: new Float32Array(4),
			fromParams: new Float32Array(4),
			riding: false,
			segment: -1,
			f0: 0,
			tweenOn: false,
			tweenSegment: -1,
			tweenF: 0,
			target: new Float32Array(4),
			drawnSegment: -1,
			drawnF: 0,
			foldHere: false,
			landHere: false,
			settled: false,
			scale: null,
			kind: null,
			scaledBindGroup: null,
			scaledBindGroupKind: null,
			remapSource: null,
			gatherSource: null
		};
		// What was drawn describes the screen, not the buffers: a reallocated
		// channel keeps it, which a remap reads (most zoom-in rebins reallocate).
		if (previous) {
			channel.drawn.set(previous.drawn);
			channel.drawnSet = previous.drawnSet;
			channel.drawnSegment = previous.drawnSegment;
			channel.drawnF = previous.drawnF;
			channel.current.set(previous.current);
			channel.scale = previous.scale;
			channel.kind = previous.kind;
		}
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
