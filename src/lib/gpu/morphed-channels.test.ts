import { describe, it, expect, beforeAll } from 'vitest';
import { MorphedChannels, type MorphHost } from './MorphedChannels';
import { TransitionClock } from '$lib/animation/TransitionClock';

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
		createComputePipeline: () => ({}),
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
				setPipeline() {},
				setBindGroup() {},
				setImmediates(_offset: number, data: ArrayBuffer) {
					const view = new DataView(data);
					log.push(`imm count=${view.getUint32(0, true)} t=${view.getFloat32(4, true)}`);
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

	// A band scale's clock, adopted. On the same fake loop, as a real one is.
	const scale = {
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

	return { device, host, log, scale, sources, frame, hasWork: () => computeWork !== null };
}

const ids = new Float32Array([0, 1, 2]);
const values = (...v: number[]) => new Float32Array(v);

function morphed(f: ReturnType<typeof fakes>, withScale = true) {
	return new MorphedChannels({
		device: f.device,
		host: f.host,
		label: 'm',
		scaleFor: (axis) => (withScale && axis === 'x' ? f.scale : null),
		affectedCharts: () => ['chart-1']
	});
}

const update = (m: MorphedChannels, y0: Float32Array, y1: Float32Array, bandIds = ids) =>
	m.write('x', bandIds, [
		[2, y0],
		[3, y1]
	]);

describe('MorphedChannels', () => {
	it('snaps the first write: nothing was on screen to travel from', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));

		expect(f.scale.starts).toBe(0);
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
		expect(f.scale.starts).toBe(1);
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

	it('joins a restart it has not folded yet, instead of issuing a second one', () => {
		// The reorder a result causes restarts the clock first; the mark's own
		// write lands right behind it. A second restart would repeat the scale's
		// O(dim) slot fold and slot-table upload for nothing.
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();

		f.scale.startTransition(); // the layout's restart
		update(m, values(2, 3, 4), values(5, 6, 7));
		expect(f.scale.starts).toBe(1);

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
		f.scale.startTransition();
		f.frame(); // folded

		update(m, values(2, 3, 4), values(5, 6, 7));
		expect(f.scale.starts).toBe(2);
	});

	it('folds when a SIBLING restarts the shared clock, with no data of its own', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();

		f.scale.startTransition(); // another mark on the axis, or another facet cell
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

		f.scale.clock.step();
		f.scale.clock.updateRenderState(0);
		expect(f.frame().some((c) => c.startsWith('dispatch'))).toBe(true);

		f.scale.clock.settle();
		expect(f.frame().some((c) => c.startsWith('dispatch'))).toBe(true);
		expect(f.frame()).toEqual([]);
	});

	it('snaps rather than travels when the rows are not the ones being animated', () => {
		const f = fakes();
		const m = morphed(f);
		update(m, values(1, 2, 3), values(4, 5, 6));
		f.frame();

		update(m, values(2, 3, 4), values(5, 6, 7), new Float32Array([0, 2, 1]));
		expect(f.scale.starts).toBe(0);
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
		m.write('x', ids, [[2, values(1, 2, 3)]]);
		f.frame();

		const reallocated = update(m, values(2, 3, 4), values(5, 6, 7));
		expect(reallocated).toBe(true);
		const issued = f.frame();
		expect(issued).toContain('copy m-3-to -> m-3-from');
		expect(issued).not.toContain('copy m-3-resolved -> m-3-from');
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
		m.write('x', ids, [
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

		f.scale.clock.step();
		f.scale.clock.updateRenderState(0);
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
