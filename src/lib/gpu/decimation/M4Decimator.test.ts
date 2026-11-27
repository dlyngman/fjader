import { describe, it, expect, beforeAll } from 'vitest';
import { M4Decimator } from './M4Decimator.svelte';

// A fake device that records the passes and dispatches an encode issues: the
// claims below are about commands, not about the decimator's own flags.

beforeAll(() => {
	const g = globalThis as Record<string, unknown>;
	g.GPUBufferUsage ??= { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 };
	g.GPUShaderStage ??= { COMPUTE: 4 };
});

function setup() {
	const log: string[] = [];
	const destroyed: string[] = [];
	const buffer = (label = '') =>
		({ label, destroy: () => destroyed.push(label) }) as unknown as GPUBuffer;
	const device = {
		createBuffer: ({ label }: { label?: string }) => buffer(label),
		createShaderModule: () => ({}),
		createBindGroupLayout: () => ({}),
		createPipelineLayout: () => ({}),
		createComputePipeline: ({ label }: { label?: string }) => ({ label }),
		createBindGroup: () => ({}),
		queue: { writeBuffer() {} }
	} as unknown as GPUDevice;
	const encoder = {
		beginComputePass({ label }: { label?: string }) {
			log.push(`pass ${label}`);
			return {
				setPipeline: ({ label: name }: { label?: string }) => log.push(`pipeline ${name}`),
				setBindGroup() {},
				setImmediates: () => log.push('immediates'),
				dispatchWorkgroups: () => log.push('dispatch'),
				end: () => log.push('end')
			};
		}
	} as unknown as GPUCommandEncoder;

	const retired: GPUBuffer[] = [];
	/** The x scale as the coordinator would write it; a test moves it. */
	const scale = [0, 100, 0.01, 0];
	const m4 = new M4Decimator(device, {
		writeScaleParams(_id, view, offset) {
			view.set(scale, offset);
			return true;
		},
		retire: (old) => retired.push(old)
	});
	m4.configure(800, 3, 'x');
	const inputs = { x: buffer('x'), y: buffer('y'), series: buffer('s'), color: buffer('c') };
	/** One frame's encode, and what it issued. */
	const frame = (points = 5000, version = 1, buffers = inputs) => {
		log.length = 0;
		m4.encode(encoder, buffers, points, version);
		return [...log];
	};
	return { m4, scale, inputs, buffer, frame, retired, destroyed };
}

describe('M4Decimator.encode', () => {
	it('is one pass of seven dispatches', () => {
		const { frame } = setup();
		const issued = frame();
		expect(issued.filter((c) => c.startsWith('pass'))).toEqual(['pass m4']);
		expect(issued.filter((c) => c === 'dispatch')).toHaveLength(7);
		expect(issued.at(-1)).toBe('end');
	});

	it('pushes the x scale for each of the two dispatches that read it, after its pipeline', () => {
		const { frame } = setup();
		const issued = frame();
		for (const name of ['m4-bin-points', 'm4-find-minmax']) {
			const at = issued.indexOf(`pipeline ${name}`);
			expect(at).toBeGreaterThan(-1);
			const next = issued.findIndex((c, i) => i > at && c === 'dispatch');
			expect(issued.slice(at, next)).toContain('immediates');
		}
		expect(issued.filter((c) => c === 'immediates')).toHaveLength(2);
	});

	it('encodes nothing for a frame that would write what the last one did', () => {
		const { frame } = setup();
		expect(frame()).not.toEqual([]);
		// A hover, a dim: the chart redraws, x has not moved, the rows are the same.
		expect(frame()).toEqual([]);
		expect(frame()).toEqual([]);
	});

	describe('runs again when', () => {
		const settled = () => {
			const s = setup();
			s.frame();
			expect(s.frame()).toEqual([]);
			return s;
		};

		it('the x scale moves', () => {
			const s = settled();
			s.scale[0] = 10;
			expect(s.frame()).toContain('pass m4');
			expect(s.frame()).toEqual([]);
		});

		it("the input's contents change in the same buffers", () => {
			const s = settled();
			// The renderer overwrote its buffers in place: same objects, new rows.
			expect(s.frame(5000, 2)).toContain('pass m4');
			expect(s.frame(5000, 2)).toEqual([]);
		});

		it('an input buffer is another one', () => {
			const s = settled();
			const moved = { ...s.inputs, y: s.buffer('y2') };
			expect(s.frame(5000, 1, moved)).toContain('pass m4');
		});

		it('the row count changes', () => {
			const s = settled();
			expect(s.frame(6000)).toContain('pass m4');
		});

		it('the mode changes', () => {
			const s = settled();
			s.m4.setDecimationMode('passthrough');
			expect(s.frame()).toContain('pass m4');
			// The same mode again is no change.
			s.m4.setDecimationMode('passthrough');
			expect(s.frame()).toEqual([]);
		});

		it('it is configured for other dimensions, or another scale', () => {
			const s = settled();
			s.m4.configure(900, 3, 'x');
			expect(s.frame()).toContain('pass m4');
			s.m4.configure(900, 3, 'y');
			expect(s.frame()).toContain('pass m4');
			// Configured as it is: nothing changed.
			s.m4.configure(900, 3, 'y');
			expect(s.frame()).toEqual([]);
		});

		it('the vertex count is set', () => {
			const s = settled();
			s.m4.setVertexCount(12);
			expect(s.frame()).toContain('pass m4');
		});
	});

	it('retires the buffers it replaces: the coming frame may still hold them', () => {
		const { m4, frame, retired, destroyed } = setup();
		frame();
		// Other dimensions, from an effect: new bins and new outputs.
		m4.configure(900, 3, 'x');
		expect(retired.map((b) => b.label).sort()).toEqual([
			'm4-bins',
			'm4-output-color',
			'm4-output-series',
			'm4-output-x',
			'm4-output-y'
		]);
		// More rows than the outputs hold, found inside an encode.
		retired.length = 0;
		frame(20_000);
		expect(retired.map((b) => b.label).sort()).toEqual([
			'm4-output-color',
			'm4-output-series',
			'm4-output-x',
			'm4-output-y'
		]);
		expect(destroyed).toEqual([]);
	});

	it('skips no frame when the input has no version', () => {
		const { m4, inputs, frame } = setup();
		frame();
		const log: string[] = [];
		const encoder = {
			beginComputePass: () => {
				log.push('pass');
				return {
					setPipeline() {},
					setBindGroup() {},
					setImmediates() {},
					dispatchWorkgroups() {},
					end() {}
				};
			}
		} as unknown as GPUCommandEncoder;
		m4.encode(encoder, inputs, 5000);
		m4.encode(encoder, inputs, 5000);
		expect(log).toEqual(['pass', 'pass']);
	});
});
