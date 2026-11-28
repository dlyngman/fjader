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
	/** Every call that reaches the GPU's buffers and bind groups, by what it touched. */
	const gpu: string[] = [];
	const device = {
		createBuffer: ({ label }: { label?: string }) => {
			gpu.push(`create ${label}`);
			return buffer(label);
		},
		createShaderModule: () => ({}),
		createBindGroupLayout: () => ({}),
		createPipelineLayout: () => ({}),
		createComputePipeline: ({ label }: { label?: string }) => ({ label }),
		createBindGroup: ({ label }: { label?: string }) => {
			gpu.push(`bind ${label}`);
			return { label };
		},
		queue: { writeBuffer: (b: { label: string }) => gpu.push(`write ${b.label}`) }
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
	return { m4, scale, inputs, buffer, frame, retired, destroyed, gpu };
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
		// Other dimensions, from an effect: new bins and new outputs, at the
		// next encode.
		m4.configure(900, 3, 'x');
		expect(retired).toEqual([]);
		frame();
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

	it('touches the GPU only in an encode: what an effect asks for is kept until then', () => {
		const { m4, frame, gpu } = setup();
		frame();
		gpu.length = 0;
		// As the mark's effects call them, between frames.
		m4.configure(900, 4, 'x');
		m4.setVertexCount(12);
		m4.setDecimationMode('passthrough');
		expect(gpu).toEqual([]);
		// And they answer for what was asked, at once: effects read them.
		expect(m4.configured).toBe(true);
		expect(m4.outputSize).toBe(4 * 902 * 4);

		frame();
		expect(gpu).toContain('write m4-control');
		expect(gpu).toContain('create m4-bins');
		expect(gpu).toContain('create m4-output-x');
		// The config once, with everything that changed in it.
		expect(gpu.filter((c) => c === 'write m4-config')).toHaveLength(1);
		gpu.length = 0;
		frame();
		expect(gpu).toEqual([]);
	});

	it('allocates its outputs once on a first encode with more rows than its bins hold', () => {
		const { frame, gpu, retired } = setup();
		// 800 bins of 3 series hold 9 624 points; the line has 100 000.
		frame(100_000);
		expect(gpu.filter((c) => c === 'create m4-output-x')).toHaveLength(1);
		expect(retired).toEqual([]);
	});

	describe('bindForRender', () => {
		const layout = {} as GPUBindGroupLayout;
		const render = (gpu: string[]) => gpu.filter((c) => c === 'bind m4-render-bind-group');

		it('makes the render bind group once the outputs exist, and not again for the same', () => {
			const { m4, frame, buffer, gpu } = setup();
			const constants = buffer('constants');
			// Before the first encode there are no outputs to bind.
			m4.bindForRender(layout, constants);
			expect(m4.renderBindGroup).toBeNull();
			frame();
			expect(render(gpu)).toHaveLength(1);
			expect(m4.renderBindGroup).not.toBeNull();
			// Every frame calls it; the same two objects make nothing.
			m4.bindForRender(layout, constants);
			frame();
			expect(render(gpu)).toHaveLength(1);
		});

		it('makes it again for another constants buffer, another layout, or other outputs', () => {
			const { m4, frame, buffer, gpu } = setup();
			const constants = buffer('constants');
			m4.bindForRender(layout, constants);
			frame();
			// The renderer replaced its constants buffer.
			m4.bindForRender(layout, buffer('constants-2'));
			expect(render(gpu)).toHaveLength(2);
			// The pipeline was rebuilt for other scale types.
			m4.bindForRender({} as GPUBindGroupLayout, constants);
			expect(render(gpu)).toHaveLength(3);
			// More rows than the outputs hold: new outputs, inside the encode.
			frame(50_000);
			expect(render(gpu)).toHaveLength(4);
		});
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
