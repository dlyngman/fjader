import { describe, it, expect, beforeAll } from 'vitest';
import { MorphedChannels, alignmentKey, type ClockHost, type MorphHost } from './MorphedChannels';
import { TransitionClock } from '$lib/animation/TransitionClock';
import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
import { scaledResolveReference } from './ResolveShader';

// A fake device that records what reaches the GPU, so the claims below are
// about commands issued rather than about internal flags.

beforeAll(() => {
	(globalThis as Record<string, unknown>).GPUBufferUsage ??= {
		COPY_SRC: 4,
		COPY_DST: 8,
		UNIFORM: 64,
		STORAGE: 128
	};
	(globalThis as Record<string, unknown>).GPUShaderStage ??= { COMPUTE: 4 };
});

interface FakeBuffer {
	label: string;
	size: number;
	destroyed: boolean;
	destroy(): void;
}

function fakes() {
	const log: string[] = [];
	const device = {
		createBuffer({ label, size }: { label: string; size: number }): FakeBuffer {
			const buffer: FakeBuffer = {
				label,
				size,
				destroyed: false,
				destroy() {
					this.destroyed = true;
					log.push(`destroy ${label}`);
				}
			};
			return buffer;
		},
		createShaderModule: () => ({}),
		createBindGroupLayout: () => ({}),
		createPipelineLayout: () => ({}),
		createComputePipeline: ({ label }: { label: string }) => ({ label }),
		createBindGroup: () => ({}),
		queue: {
			writeBuffer(buffer: FakeBuffer) {
				log.push(`write ${buffer.label}`);
			}
		}
	} as unknown as GPUDevice;

	const encoder = {
		copyBufferToBuffer(src: FakeBuffer, _a: number, dst: FakeBuffer) {
			log.push(`copy ${src.label} -> ${dst.label}`);
		},
		beginComputePass() {
			log.push('pass');
			return {
				// Pixel-space resolve and remap pipelines only: the plain resolve's
				// would change every exact list below.
				setPipeline(pipeline: { label?: string }) {
					const label = pipeline.label ?? '';
					if (label.startsWith('resolve-') || label.startsWith('remap') || label === 'gather') {
						log.push(`pipeline ${label}`);
					}
				},
				setBindGroup() {},
				setImmediates(_offset: number, data: ArrayBuffer) {
					const view = new DataView(data);
					const head = `imm count=${view.getUint32(0, true)} t=${view.getFloat32(4, true)}`;
					// 64 B (pixel-space resolve): `land`, then fromP, toP and now; their
					// domain mins tell them apart. `to` shown only when it is not `now`
					// (a ride's target). 48 B (remap): drawn and now.
					let params = '';
					if (data.byteLength === 64) {
						const from = view.getFloat32(16, true);
						const to = view.getFloat32(32, true);
						const now = view.getFloat32(48, true);
						params = ` from=${from} now=${now}`;
						if (to !== now) params += ` to=${to}`;
						if (view.getUint32(12, true) !== 0) params += ' land';
					} else if (data.byteLength === 48) {
						params = ` from=${view.getFloat32(16, true)} now=${view.getFloat32(32, true)}`;
					}
					log.push(head + params);
				},
				dispatchWorkgroups(n: number) {
					log.push(`dispatch ${n}`);
				},
				end() {}
			};
		}
	} as unknown as GPUCommandEncoder;

	const sources: TransitionClock[] = [];
	let computeWork: ((e: GPUCommandEncoder) => void) | null = null;
	const host: MorphHost = {
		registerComputeWork: (_key, fn) => {
			computeWork = fn;
			log.push('register');
		},
		removeComputeWork: () => {
			computeWork = null;
			log.push('unregister');
		},
		addAnimatedSource: (s) => {
			if (!sources.includes(s)) sources.push(s);
		},
		removeAnimatedSource: (s) => {
			sources.splice(sources.indexOf(s), 1);
		}
	};

	// A band scale's slots, whose clock is adopted. On the same fake loop, as a
	// real one is.
	const slots = {
		clock: new TransitionClock({ loop: host }),
		starts: 0,
		startTransition() {
			this.starts++;
			this.clock.restart();
		}
	};

	/** Run one frame's compute work and return what it issued. */
	const frame = () => {
		log.length = 0;
		computeWork?.(encoder);
		return [...log];
	};

	return { device, host, log, slots, sources, frame, hasWork: () => computeWork !== null };
}

const ids = new Float32Array([0, 1, 2]);
const values = (...v: number[]) => new Float32Array(v);

function morphed(f: ReturnType<typeof fakes>, withScale = true) {
	return new MorphedChannels({
		device: f.device,
		host: f.host,
		label: 'm',
		clockHost: () => (withScale ? f.slots : null),
		affectedCharts: () => ['chart-1']
	});
}

const update = (m: MorphedChannels, y0: Float32Array, y1: Float32Array, bandIds = ids) =>
	m.write(bandIds, [
		[2, y0],
		[3, y1]
	]);

describe('MorphedChannels', () => {
	it('snaps the first write: nothing was on screen to travel from', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));

		expect(f.slots.starts).toBe(0);
		const issued = f.frame();
		expect(issued).toContain('copy m-2-to -> m-2-from');
		expect(issued).toContain('copy m-3-to -> m-3-from');
		expect(issued.filter((c) => c.startsWith('dispatch'))).toHaveLength(2);
		const imm = issued.filter((c) => c.startsWith('imm'));
		expect(imm).toHaveLength(2);
		expect(imm.every((c) => c.endsWith('t=1'))).toBe(true);
	});

	it('issues nothing at all on a frame where nothing changed', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();

		// Hover and pan render frames too; at rest those must cost no GPU work.
		expect(f.frame()).toEqual([]);
		expect(f.frame()).toEqual([]);
	});

	it('uses one compute pass for all channels', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		expect(f.frame().filter((c) => c === 'pass')).toHaveLength(1);
	});

	it('starts ONE transition per update, however many channels it carries', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();

		update(m, values(2, 3, 4), values(5, 6, 7));
		expect(f.slots.starts).toBe(1);
	});

	it('folds from what is on screen when its own update restarts the clock', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();

		update(m, values(2, 3, 4), values(5, 6, 7));
		const issued = f.frame();
		expect(issued).toContain('copy m-2-resolved -> m-2-from');
		expect(issued).not.toContain('copy m-2-to -> m-2-from');
		expect(issued).toContain('imm count=3 t=0');
	});

	it('lands a channel it is told to, while the others in the same write travel', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();

		// Channel 3 lands at once (an Other split leaving a flat state); 2 travels.
		m.write(
			ids,
			[
				[2, values(2, 3, 4)],
				[3, values(5, 6, 7)]
			],
			[3]
		);
		expect(f.slots.starts).toBe(1);
		const issued = f.frame();
		expect(issued).toContain('copy m-2-resolved -> m-2-from');
		expect(issued).toContain('copy m-3-to -> m-3-from');
		expect(issued).not.toContain('copy m-3-resolved -> m-3-from');

		// Landing is per write: the next update travels again.
		m.write(ids, [
			[2, values(3, 4, 5)],
			[3, values(6, 7, 8)]
		]);
		const next = f.frame();
		expect(next).toContain('copy m-3-resolved -> m-3-from');
	});

	it('joins a restart it has not folded yet, instead of issuing a second one', () => {
		// The reorder a result causes restarts the clock first; the mark's own
		// write lands right behind it. A second restart would repeat the scale's
		// O(dim) slot fold and slot-table upload for nothing.
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();

		f.slots.startTransition(); // the layout's restart
		update(m, values(2, 3, 4), values(5, 6, 7));
		expect(f.slots.starts).toBe(1);

		// And the fold still happens, carrying the new values with it.
		const issued = f.frame();
		expect(issued).toContain('copy m-2-resolved -> m-2-from');
		expect(issued).toContain('imm count=3 t=0');
	});

	it('still starts its own transition once the last restart has been folded', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();
		f.slots.startTransition();
		f.frame(); // folded

		update(m, values(2, 3, 4), values(5, 6, 7));
		expect(f.slots.starts).toBe(2);
	});

	it('folds when a SIBLING restarts the shared clock, with no data of its own', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();

		f.slots.startTransition(); // another mark on the axis, or another facet cell
		const issued = f.frame();
		expect(issued).toContain('copy m-2-resolved -> m-2-from');
	});

	it('keeps dispatching while t moves, once more when it lands, then stops', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();
		update(m, values(2, 3, 4), values(5, 6, 7));
		f.frame();

		f.slots.clock.step();
		f.slots.clock.updateRenderState(0);
		expect(f.frame().some((c) => c.startsWith('dispatch'))).toBe(true);

		f.slots.clock.settle();
		expect(f.frame().some((c) => c.startsWith('dispatch'))).toBe(true);
		expect(f.frame()).toEqual([]);
	});

	it('snaps rather than travels when the rows are not the ones being animated', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();

		update(m, values(2, 3, 4), values(5, 6, 7), new Float32Array([0, 2, 1]));
		expect(f.slots.starts).toBe(0);
		const issued = f.frame();
		expect(issued).toContain('copy m-2-to -> m-2-from');
		expect(issued).not.toContain('copy m-2-resolved -> m-2-from');
	});

	it('snaps when a buffer is new, since a fresh buffer was never on screen', () => {
		// The same rows, so alignment alone would let this travel — and fold from
		// a resolved buffer that holds nothing. A row count that grows changes the
		// band ids too, so a channel joining an existing set is the case only
		// this rule catches.
		const f = fakes();
		const m = morphed(f);
		m.write(ids, [[2, values(1, 2, 3)]]);
		f.frame();

		const reallocated = update(m, values(2, 3, 4), values(5, 6, 7));
		expect(reallocated).toBe(true);
		const issued = f.frame();
		expect(issued).toContain('copy m-3-to -> m-3-from');
		expect(issued).not.toContain('copy m-3-resolved -> m-3-from');
	});

	it('stops its own clock and folds when a scale arrives to adopt', () => {
		// A scale can appear after the first data. The mark must not keep a
		// second clock running, and must continue from what is on screen rather
		// than jump to wherever the adopted clock's t happens to be.
		const f = fakes();
		let adopted: ClockHost | null = null;
		const m = new MorphedChannels({
			device: f.device,
			host: f.host,
			label: 'm',
			clockHost: () => adopted,
			affectedCharts: () => ['chart-1']
		});
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();
		update(m, values(2, 3, 4), values(5, 6, 7));
		f.frame();
		const own = f.sources[0];
		expect(own.running).toBe(true);

		adopted = f.slots;
		const issued = f.frame();
		expect(own.running).toBe(false);
		expect(f.sources).not.toContain(own);
		expect(issued).toContain('copy m-2-resolved -> m-2-from');
	});

	it('restarts the adopted clock when new data lands in the same tick as the switch', () => {
		// The pending-fold shortcut skips a restart when the clock has moved on
		// since this mark last read it. A clock it has never read has not "moved
		// on" — skipping there would fold onto whatever t the new clock is at,
		// and the update would land without animating.
		const f = fakes();
		let adopted: ClockHost | null = null;
		const m = new MorphedChannels({
			device: f.device,
			host: f.host,
			label: 'm',
			clockHost: () => adopted,
			affectedCharts: () => ['chart-1']
		});
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();
		update(m, values(2, 3, 4), values(5, 6, 7));
		f.frame();

		adopted = f.slots;
		update(m, values(3, 4, 5), values(6, 7, 8));
		expect(f.slots.starts).toBe(1);
		expect(f.frame()).toContain('imm count=3 t=0');
	});

	it('folds when its clock is replaced by one that happens to be on the same version', () => {
		// A version is a counter on ONE clock. Compared across two, an equal
		// number reads as "nothing happened" and the mark skips the fold.
		const f = fakes();
		const hostFor = () => {
			const clock = new TransitionClock({ loop: f.host });
			return { clock, startTransition: () => clock.restart() };
		};
		const a = hostFor();
		const b = hostFor();
		let adopted: ClockHost = a;
		const m = new MorphedChannels({
			device: f.device,
			host: f.host,
			label: 'm',
			clockHost: () => adopted,
			affectedCharts: () => ['chart-1']
		});
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();

		b.startTransition();
		expect(b.clock.version).toBe(a.clock.version + 1);
		a.startTransition();
		f.frame();
		expect(b.clock.version).toBe(a.clock.version);

		adopted = b;
		expect(f.frame()).toContain('copy m-2-resolved -> m-2-from');
	});

	it('owns a clock when the band axis has no scale to adopt, and joins the loop', () => {
		const f = fakes();
		const m = morphed(f, false);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();

		update(m, values(2, 3, 4), values(5, 6, 7));
		expect(f.sources).toHaveLength(1);
		expect(f.sources[0]._affectedChartsArray).toEqual(['chart-1']);
		expect(f.sources[0].t).toBe(0);
	});

	it('gives each dispatch its own count and t, set immediately before it', () => {
		// Why immediates rather than a shared uniform: queue writes land before
		// any command in the submit, so a buffer rewritten between dispatches
		// would give every dispatch the last channel's values. Two channels of
		// different lengths make a wrong count visible.
		const f = fakes();
		const m = morphed(f);
		m.write(ids, [
			[2, values(1, 2, 3)],
			[3, new Float32Array(100)]
		]);
		const issued = f.frame().filter((c) => c.startsWith('imm') || c.startsWith('dispatch'));
		expect(issued).toEqual(['imm count=3 t=1', 'dispatch 1', 'imm count=100 t=1', 'dispatch 2']);
	});

	it('writes no buffer while animating: t travels in the command stream', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();
		update(m, values(2, 3, 4), values(5, 6, 7));
		f.frame();

		f.slots.clock.step();
		f.slots.clock.updateRenderState(0);
		const issued = f.frame();
		expect(issued.some((c) => c.startsWith('dispatch'))).toBe(true);
		expect(issued.filter((c) => c.startsWith('write'))).toEqual([]);
	});

	it('unregisters its compute work before destroying the buffers it reads', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.log.length = 0;

		m.destroy();
		expect(f.log[0]).toBe('unregister');
		expect(f.log.filter((c) => c.startsWith('destroy'))).toHaveLength(6);
		expect(f.hasWork()).toBe(false);
	});

	it('drop releases a channel and leaves the others morphing', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));

		expect(m.drop(2)).toBe(true);
		expect(m.drop(2)).toBe(false);
		expect(m.resolved(2)).toBeUndefined();
		expect(m.resolved(3)).toBeDefined();
	});
});

describe('MorphedChannels resolving in pixel space', () => {
	/** A value-axis scale as a resolve reads it: its params as drawn. */
	function scale(min: number, max: number) {
		return {
			scaleType: 'linear',
			gpuState: { domainMin: min, domainMax: max, domainScale: 1 / (max - min), p4: 0 },
			/** A frame of the domain moving (a tween, a spring). */
			moveTo(lo: number, hi: number) {
				this.gpuState = { domainMin: lo, domainMax: hi, domainScale: 1 / (hi - lo), p4: 0 };
			}
		};
	}

	/** Channels 2 and 3 on the value axis; 4 is an Other share, on no scale. */
	function folding(f: ReturnType<typeof fakes>, y: ReturnType<typeof scale>) {
		return new MorphedChannels({
			device: f.device,
			host: f.host,
			label: 'm',
			clockHost: () => null,
			affectedCharts: () => ['chart-1'],
			scaleFor: (binding) => (binding === 2 || binding === 3 ? y : null)
		});
	}

	const write = (m: MorphedChannels, a: number[], b: number[], share?: number[]) =>
		m.write(ids, [
			[2, values(...a)],
			[3, values(...b)],
			...(share ? ([[4, values(...share)]] as const) : [])
		]);

	/** A mark at rest under the domain [0, 100]. */
	function atRest(f: ReturnType<typeof fakes>, y: ReturnType<typeof scale>) {
		const m = folding(f, y);
		write(m, [0, 0, 0], [10, 20, 30]);
		f.frame();
		f.frame();
		return m;
	}

	it('resolves a scaled channel in pixel space; a snap takes this frame’s params', () => {
		const f = fakes();
		const y = scale(5, 100);
		const m = folding(f, y);
		write(m, [0, 0, 0], [10, 20, 30]);
		const issued = f.frame();
		// Both value channels through the pixel-space resolve, from = now: a snap.
		expect(issued.filter((c) => c === 'pipeline resolve-linear')).toHaveLength(2);
		expect(issued.filter((c) => c === 'imm count=3 t=1 from=5 now=5 land')).toHaveLength(2);
	});

	it('takes the previous frame’s params on a fold: what resolved was drawn under', () => {
		const f = fakes();
		const y = scale(0, 100);
		const m = atRest(f, y);

		// The domain moves (a tween's frame), then new data folds from the screen.
		y.moveTo(10, 60);
		f.frame();
		y.moveTo(20, 50);
		write(m, [0, 0, 0], [5, 6, 7]);
		const issued = f.frame();
		expect(issued).toContain('copy m-2-resolved -> m-2-from');
		// `from` holds values under last frame's params (min 10), `to` under now's (20).
		expect(issued.filter((c) => c === 'imm count=3 t=0 from=10 now=20')).toHaveLength(2);
	});

	it('costs nothing at rest while the domain moves: a finished value is `to`', () => {
		const f = fakes();
		const y = scale(0, 100);
		atRest(f, y);
		y.moveTo(0, 80);
		expect(f.frame()).toEqual([]);
		y.moveTo(0, 60);
		expect(f.frame()).toEqual([]);
	});

	it('resolves a binding on no scale as a plain mix (an Other share)', () => {
		const f = fakes();
		const y = scale(0, 100);
		const m = folding(f, y);
		write(m, [0, 0, 0], [10, 20, 30], [1, 1, 1]);
		const issued = f.frame();
		// Three channels: two pixel-space, one plain (12 B of immediates, no params).
		expect(issued.filter((c) => c === 'pipeline resolve-linear')).toHaveLength(2);
		expect(issued.filter((c) => c === 'imm count=3 t=1')).toHaveLength(1);
	});

	it('restarts carry each channel’s params with its `from`, whatever moved between', () => {
		const f = fakes();
		const y = scale(0, 100);
		const m = atRest(f, y);
		write(m, [0, 0, 0], [5, 6, 7]);
		f.frame(); // the transition starts under min 0
		y.moveTo(30, 90);
		f.frame(); // drawn under min 30
		y.moveTo(40, 90);
		write(m, [0, 0, 0], [8, 9, 1]); // a restart mid-way: from = resolved, under 30
		const issued = f.frame();
		expect(issued.filter((c) => c.includes('from=30 now=40'))).toHaveLength(2);
	});
});

describe('MorphedChannels remapping a rebin', () => {
	const y = {
		snapCount: 0,
		scaleType: 'linear',
		gpuState: { domainMin: 0, domainMax: 100, domainScale: 0.01, p4: 0 }
	};
	/** Channels 2 and 3 on the value axis; 4 an Other share. */
	function remapping(f: ReturnType<typeof fakes>) {
		return new MorphedChannels({
			device: f.device,
			host: f.host,
			label: 'm',
			clockHost: () => null,
			affectedCharts: () => ['chart-1'],
			scaleFor: (binding) => (binding === 2 || binding === 3 ? y : null)
		});
	}
	// A map's words; its contents are the kernel's business (remap.test.ts).
	const MAP = new Uint32Array(16);
	const oldIds = new Float32Array([0, 10]);
	const newIds = new Float32Array([0, 5, 10, 15]);

	/** Two bins on screen, at rest. */
	function onScreen(f: ReturnType<typeof fakes>) {
		const m = remapping(f);
		m.write(oldIds, [
			[2, values(0, 0)],
			[3, values(8, 4)]
		]);
		f.frame();
		f.frame();
		return m;
	}
	const rebin = (m: MorphedChannels, map: Uint32Array | null = MAP, share = false) =>
		m.write(
			newIds,
			[
				[2, values(0, 0, 0, 0)],
				[3, values(3, 5, 1, 3)],
				...(share ? ([[4, values(1, 1, 1, 1)]] as const) : [])
			],
			undefined,
			map
		);

	it('remaps a rebin instead of snapping: before the resolves, from t = 0', () => {
		const f = fakes();
		const m = onScreen(f);
		rebin(m);
		const issued = f.frame();
		expect(issued.filter((c) => c === 'pipeline remap-linear')).toHaveLength(2);
		expect(issued).not.toContain('copy m-2-to -> m-2-from');
		expect(issued).not.toContain('copy m-3-to -> m-3-from');
		expect(issued.some((c) => c.startsWith('imm count=4 t=0'))).toBe(true);
		expect(f.sources.length).toBe(1);
	});

	it('keeps the old resolved through a reallocation until the frame after it was read', () => {
		const f = fakes();
		const m = onScreen(f);
		// Two rows to four, in buffers of 256 B: no reallocation needed for this
		// size, so grow past it to force one.
		const big = (n: number) => new Float32Array(n);
		m.write(
			new Float32Array(Array.from({ length: 200 }, (_, i) => i)),
			[
				[2, big(200)],
				[3, big(200)]
			],
			undefined,
			MAP
		);
		const writeLog = [...f.log];
		expect(writeLog).toContain('destroy m-2-from');
		expect(writeLog).not.toContain('destroy m-2-resolved');
		const remapFrame = f.frame();
		expect(remapFrame.filter((c) => c === 'pipeline remap-linear')).toHaveLength(2);
		expect(remapFrame).not.toContain('destroy m-2-resolved');
		const next = f.frame();
		expect(next).toContain('destroy m-2-resolved');
		expect(next).toContain('destroy m-remap');
	});

	it('takes an aligned write along while a remap is pending: no fold, one transition', () => {
		const f = fakes();
		const m = onScreen(f);
		rebin(m);
		const starts = f.sources.length;
		rebin(m, null); // the same new rows, other values
		const issued = f.frame();
		expect(issued.filter((c) => c === 'pipeline remap-linear')).toHaveLength(2);
		expect(issued).not.toContain('copy m-2-resolved -> m-2-from');
		expect(f.sources.length).toBe(starts);
	});

	it('snaps a second rebin before the first ran: its map is from a layout never drawn', () => {
		const f = fakes();
		const m = onScreen(f);
		rebin(m);
		m.write(
			new Float32Array([0, 2, 4, 6, 8, 10, 12, 14]),
			[
				[2, values(0, 0, 0, 0, 0, 0, 0, 0)],
				[3, values(1, 1, 1, 1, 1, 1, 1, 1)]
			],
			undefined,
			MAP
		);
		const issued = f.frame();
		expect(issued.filter((c) => c.startsWith('pipeline remap'))).toHaveLength(0);
		expect(issued).toContain('copy m-2-to -> m-2-from');
		// Never recorded in a command buffer, so it goes at the next encode.
		expect(issued).toContain('destroy m-remap');
	});

	it('remaps a binding on no scale untransformed, and snaps a channel with no old rows', () => {
		const f = fakes();
		const m = onScreen(f);
		rebin(m, MAP, true); // the share (4) is new: nothing of it on screen
		const issued = f.frame();
		expect(issued.filter((c) => c === 'pipeline remap-linear')).toHaveLength(2);
		expect(issued).toContain('copy m-4-to -> m-4-from');
	});

	it('snaps a rebin with no map, as before', () => {
		const f = fakes();
		const m = onScreen(f);
		rebin(m, null);
		const issued = f.frame();
		expect(issued.filter((c) => c.startsWith('pipeline remap'))).toHaveLength(0);
		expect(issued).toContain('copy m-2-to -> m-2-from');
	});
});

describe('alignmentKey', () => {
	it('tells bin edges apart by their fractions, which a sum would truncate', () => {
		// A re-bin keeps the row count but moves every edge by half a bin.
		const before = new Float32Array([1.25, 2.25]);
		const after = new Float32Array([1.5, 2.5]);
		expect(alignmentKey(before)).not.toBe(alignmentKey(after));
		expect(alignmentKey(new Float32Array([1.25, 2.25]))).toBe(alignmentKey(before));
	});

	it('reads a view at an offset, as an Arrow column can be', () => {
		const buffer = new Float32Array([9, 1.5, 2.5]);
		const view = new Float32Array(buffer.buffer, 4, 2);
		expect(alignmentKey(view)).toBe(alignmentKey(new Float32Array([1.5, 2.5])));
	});
});

describe('MorphedChannels riding a scale’s tween', () => {
	const params = (lo: number, hi: number) => ({
		domainMin: lo,
		domainMax: hi,
		domainScale: 1 / (hi - lo),
		p4: 0
	});

	/** A value-axis scale whose unit-change tween the test drives. */
	function tweening(lo: number, hi: number) {
		return {
			scaleType: 'linear',
			gpuState: params(lo, hi),
			tween: null as null | { segment: number; f: number; targetParams: GpuParams },
			/** A frame: the domain drawn now, and the tween's progress if one runs. */
			at(a: number, b: number, f?: number) {
				this.gpuState = params(a, b);
				if (this.tween && f !== undefined) this.tween.f = f;
			},
			start(segment: number, a: number, b: number) {
				this.tween = { segment, f: 0, targetParams: params(a, b) };
			},
			end(a: number, b: number) {
				this.tween = null;
				this.gpuState = params(a, b);
			}
		};
	}
	type GpuParams = ReturnType<typeof params>;

	function riding(f: ReturnType<typeof fakes>, y: ReturnType<typeof tweening>) {
		return new MorphedChannels({
			device: f.device,
			host: f.host,
			label: 'm',
			clockHost: () => null,
			affectedCharts: () => ['chart-1'],
			scaleFor: (binding) => (binding === 2 ? y : null)
		});
	}
	const write = (m: MorphedChannels, v: number[]) => m.write(ids, [[2, values(...v)]]);
	/** The scaled resolves' immediates, as the fake logs them. */
	const imms = (issued: string[]) => issued.filter((c) => c.startsWith('imm count=3 '));
	/** The `t` the first scaled resolve was dispatched with. */
	const t = (issued: string[]) => Number(/ t=(\S+)/.exec(imms(issued)[0])![1]);

	/** A mark on screen at rest under [0, 100]. */
	function atRest(f: ReturnType<typeof fakes>, y: ReturnType<typeof tweening>) {
		const m = riding(f, y);
		write(m, [10, 20, 30]);
		f.frame();
		f.frame();
		return m;
	}

	it('costs nothing at rest while a tween runs: drawn under the moving domain, `to` is on the static path', () => {
		const f = fakes();
		const y = tweening(0, 100);
		atRest(f, y);
		y.start(1, 5, 25);
		y.at(2, 80, 0.3);
		expect(f.frame()).toEqual([]);
	});

	it('rides from the f last drawn: data mid-segment mixes by g, `to` under the target', () => {
		const f = fakes();
		const y = tweening(0, 100);
		const m = atRest(f, y);
		y.start(1, 5, 25);
		y.at(4, 30, 0.95);
		f.frame(); // drawn at f = 0.95, under min 4
		write(m, [1, 2, 3]);
		y.at(4.5, 29, 0.96);
		const issued = f.frame();
		expect(issued).toContain('copy m-2-resolved -> m-2-from');
		// from: last frame's params; to: the target's; mixed by g, not landed.
		expect(imms(issued)[0]).toMatch(/ from=4 now=4\.5 to=5$/);
		// g = (0.96 − 0.95) / (1 − 0.95): no jump, a fifth of what is left.
		expect(t(issued)).toBeCloseTo(0.2, 5);
		y.at(5, 25, 1);
		expect(t(f.frame())).toBeCloseTo(1, 6);
	});

	it('folds during an overshoot (f0 > 1) and still runs g from 0 to 1', () => {
		const f = fakes();
		const y = tweening(0, 100);
		const m = atRest(f, y);
		y.start(1, 5, 25);
		y.at(5.1, 24, 1.03);
		f.frame(); // drawn at f = 1.03
		write(m, [1, 2, 3]);
		y.at(5.05, 24.5, 1.02);
		expect(t(f.frame())).toBeCloseTo(1 / 3, 5);
		y.at(5, 25, 1);
		expect(t(f.frame())).toBeCloseTo(1, 6);
	});

	it('lands instead of riding when f0 is at 1: g would divide by nothing', () => {
		const f = fakes();
		const y = tweening(0, 100);
		const m = atRest(f, y);
		y.start(1, 5, 25);
		y.at(5, 25, 1.00001);
		f.frame();
		write(m, [1, 2, 3]);
		const issued = f.frame();
		expect(issued).toContain('copy m-2-to -> m-2-from');
		expect(issued).not.toContain('copy m-2-resolved -> m-2-from');
	});

	it('re-anchors on a new segment from the screen, with f0 = 0', () => {
		const f = fakes();
		const y = tweening(0, 100);
		const m = atRest(f, y);
		y.start(1, 5, 25);
		y.at(1, 80, 0.2);
		f.frame();
		write(m, [1, 2, 3]);
		y.at(1.5, 70, 0.3);
		f.frame(); // riding segment 1
		y.start(2, 10, 50); // a retarget: a new segment
		y.at(1.6, 69, 0.01);
		const issued = f.frame();
		expect(issued).toContain('copy m-2-resolved -> m-2-from');
		expect(imms(issued)[0]).toMatch(/ from=1\.5 now=1\.6\d* to=10$/);
		expect(t(issued)).toBeCloseTo(0.01, 6);
	});

	it('lands when the tween ends: `to` exactly, whatever its own clock says', () => {
		const f = fakes();
		const y = tweening(0, 100);
		const m = atRest(f, y);
		y.start(1, 5, 25);
		y.at(1, 80, 0.2);
		f.frame();
		write(m, [1, 2, 3]); // starts its own clock too
		y.at(1.5, 70, 0.3);
		f.frame();
		y.end(5, 25);
		const issued = f.frame();
		expect(issued).toContain('copy m-2-to -> m-2-from');
		expect(imms(issued)[0]).toMatch(/ land$/);
	});

	it('joins a tween mid-way through its own transition, from the screen', () => {
		const f = fakes();
		const y = tweening(0, 100);
		const m = atRest(f, y);
		write(m, [1, 2, 3]); // its own transition; the fake loop never advances t
		f.frame();
		y.start(1, 5, 25);
		y.at(0.5, 90, 0.05);
		const issued = f.frame();
		expect(issued).toContain('copy m-2-resolved -> m-2-from');
		expect(t(issued)).toBeCloseTo(0.05, 6);
	});
});

describe('the pixel-space resolve on a real tween (reference)', () => {
	/** A bar's height as a share of the plot, every frame of a k× change of the y unit. */
	function heights(k: number, from: number, to: number) {
		const s = new LinearScaleState('y');
		s.entered = true;
		s.domain.set([0, 700], { instant: true });
		const start = [0, 700, 1 / 700, 0];
		s.discrete(() => s.domain.set([0, 700 / k], { instant: true }));
		const out = new Float32Array(1);
		const rows: { f: number; height: number }[] = [];
		for (let i = 0; i < 2000; i++) {
			s.step();
			s.updateRenderState(0.001);
			const tween = s.tween;
			if (!tween) break;
			const p = tween.targetParams;
			const now = s.gpuState;
			scaledResolveReference(
				'linear',
				[from],
				[to],
				tween.f,
				start,
				[p.domainMin, p.domainMax, p.domainScale, p.p4],
				[now.domainMin, now.domainMax, now.domainScale, now.p4],
				out
			);
			rows.push({ f: tween.f, height: out[0] / (now.domainMax - now.domainMin) });
		}
		return rows;
	}

	it('holds a bar’s height through a pure change of unit, at every f', () => {
		for (const k of [2, 7, 24]) {
			const rows = heights(k, 630, 630 / k);
			expect(rows.length).toBeGreaterThan(10);
			for (const { height } of rows) expect(height).toBeCloseTo(0.9, 5);
		}
	});

	it('moves a change of detail linearly in pixels', () => {
		const rows = heights(7, 630, 50);
		expect(rows.length).toBeGreaterThan(10);
		for (const { f, height } of rows) expect(height).toBeCloseTo((1 - f) * 0.9 + f * 0.5, 5);
	});
});

describe('MorphedChannels: a merge’s gather', () => {
	// The held layout: three rows. The new result: two (merged) rows, and a map
	// that is opaque here (the kernel is tested against its reference).
	const MAP = new Uint32Array(16);
	const gatherWrite = (m: MorphedChannels, y0: Float32Array, y1: Float32Array) =>
		m.write(
			values(9, 9),
			[
				[2, y0],
				[3, y1]
			],
			undefined,
			null,
			MAP
		);

	it('keeps the held rows, folds from the screen, gathers into `to` before resolving', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();

		gatherWrite(m, values(7, 8), values(9, 10));
		expect(f.slots.starts).toBe(1);
		const issued = f.frame();
		// No snap: `from` is the screen, not `to`.
		expect(issued).toContain('copy m-2-resolved -> m-2-from');
		expect(issued).not.toContain('copy m-2-to -> m-2-from');
		// The gathers come first in the pass, then the resolves, over the HELD rows.
		expect(issued.indexOf('pipeline gather')).toBeGreaterThan(issued.indexOf('pass'));
		const dispatches = issued.flatMap((c, i) => (c.startsWith('dispatch') ? [i] : []));
		expect(dispatches).toHaveLength(4);
		// Both gathers (one pipeline set per channel) dispatch before either resolve.
		expect(issued.filter((c) => c === 'pipeline gather')).toHaveLength(2);
		expect(issued.lastIndexOf('pipeline gather')).toBeLessThan(dispatches[2]);
		expect(issued.filter((c) => c === 'imm count=3 t=0').length).toBeGreaterThanOrEqual(2);
	});

	it('does not touch the held rows’ ids: a later aligned write still folds', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();
		gatherWrite(m, values(7, 8), values(9, 10));
		f.frame();

		update(m, values(2, 3, 4), values(5, 6, 7));
		const issued = f.frame();
		expect(issued).toContain('copy m-2-resolved -> m-2-from');
		expect(issued).not.toContain('pipeline gather');
	});

	it('drops a pending gather when another write replaces `to`', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();
		gatherWrite(m, values(7, 8), values(9, 10));
		update(m, values(2, 3, 4), values(5, 6, 7));
		expect(f.frame()).not.toContain('pipeline gather');
	});

	it('tells its waiter once, when the transition has landed', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();
		let rested = 0;
		gatherWrite(m, values(7, 8), values(9, 10));
		m.whenLanding(() => rested++);

		f.frame();
		f.slots.clock.step();
		f.slots.clock.updateRenderState(0);
		f.frame();
		expect(rested).toBe(0);

		f.slots.clock.settle();
		f.frame();
		expect(rested).toBe(1);
		f.frame();
		expect(rested).toBe(1);
	});

	it('arrives by its lead: rows written with lead 0.5 have landed once the clock passes 0.5', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();
		const at: number[] = [];
		m.write(
			values(9, 9),
			[
				[2, values(7, 8)],
				[3, values(9, 10)]
			],
			undefined,
			null,
			new Uint32Array(16),
			0.5
		);
		m.whenLanding(() => at.push(f.slots.clock.t));
		f.frame();
		let tAtHalf: string[] = [];
		for (let i = 0; i < 1000 && at.length === 0; i++) {
			f.slots.clock.step();
			f.slots.clock.updateRenderState(0);
			tAtHalf = f.frame().filter((c) => c.startsWith('imm count=3'));
		}
		expect(at).toHaveLength(1);
		expect(at[0]).toBeGreaterThanOrEqual(0.5);
		expect(at[0]).toBeLessThan(1);
		// The rows are drawn at their end by then: t pushed as 1.
		expect(tAtHalf.every((c) => c.includes('t=1'))).toBe(true);
	});

	it('forgets its waiter when told to', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();
		let rested = 0;
		gatherWrite(m, values(7, 8), values(9, 10));
		m.whenLanding(() => rested++);
		m.whenLanding(null);
		f.frame();
		f.slots.clock.settle();
		f.frame();
		expect(rested).toBe(0);
	});
});

describe('MorphedChannels: a merge’s cut', () => {
	const REMAP = new Uint32Array(16);
	const GATHER = new Uint32Array(16);

	it('takes the pieces as its rows: `from` by the remap, `to` by the gather, then travels', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();

		// Four pieces from three held rows, two new rows.
		const pieces = values(0, 1, 1.5, 2);
		m.write(
			pieces,
			[
				[2, values(7, 8)],
				[3, values(9, 10)]
			],
			undefined,
			REMAP,
			GATHER
		);
		expect(f.slots.starts).toBe(1);
		const issued = f.frame();
		// No fold and no snap: the remap builds `from`.
		expect(issued.some((c) => c.startsWith('copy'))).toBe(false);
		const remaps = issued.indexOf('pipeline remap-none');
		const gathers = issued.indexOf('pipeline gather');
		expect(remaps).toBeGreaterThan(-1);
		expect(gathers).toBeGreaterThan(remaps);
		// Over the pieces: remap, gather and resolve for each of two channels.
		expect(issued.filter((c) => c.startsWith('imm count=4'))).toHaveLength(6);

		// Later writes over the pieces are aligned: they fold.
		update(m, values(1, 1, 1, 1), values(2, 2, 2, 2), pieces);
		expect(f.frame()).toContain('copy m-2-resolved -> m-2-from');
	});
});
