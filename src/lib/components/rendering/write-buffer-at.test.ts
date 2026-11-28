import { describe, it, expect, beforeAll } from 'vitest';
import { BaseGPURenderer } from './BaseGPURenderer.svelte';

/**
 * A writer other than the component that owns a buffer (an LOD rung's radius,
 * one axis's ticks) writes part of it through the renderer, by binding. It
 * never holds the buffer: the renderer replaces one its contents outgrow.
 */

beforeAll(() => {
	(globalThis as Record<string, unknown>).GPUBufferUsage ??= {
		COPY_SRC: 4,
		COPY_DST: 8,
		UNIFORM: 64,
		VERTEX: 32,
		STORAGE: 128
	};
	(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 };
});

async function setup() {
	const writes: { buffer: number; offset: number; dataOffset?: number; size?: number }[] = [];
	let made = 0;
	const device = {
		createBuffer: ({ size }: { size: number }) => ({ id: ++made, size, destroy() {} }),
		createBindGroup: () => ({}),
		queue: {
			writeBuffer: (
				b: { id: number },
				offset: number,
				_data: unknown,
				dataOffset?: number,
				size?: number
			) => writes.push({ buffer: b.id, offset, dataOffset, size })
		}
	};
	const coordinator = {
		acquirePipeline: async () => ({ pipeline: {}, dataLayout: {} }),
		releaseRenderer: () => {},
		rebuildRenderPlan: () => {},
		registerLayer: () => ({ remove: () => {} }),
		invalidateChart: () => {},
		registerMorphWork: () => {},
		removeMorphWork: () => {},
		retire: (buffer: { destroy(): void }) => buffer.destroy(),
		addAnimatedSource: () => {},
		removeAnimatedSource: () => {}
	};
	const renderer = new BaseGPURenderer(
		'lines',
		{ getDevice: () => device } as never,
		coordinator as never,
		{ chartId: 'chart-1', scaleTypes: {} } as never
	);
	await renderer.initialize({
		dataBindingConfig: [],
		markShaderCode: '',
		vertexBufferLayout: [],
		rendererDefinition: {}
	});
	return { renderer, writes };
}

const RADIUS = new Float32Array([4]);

describe('writeBufferAt', () => {
	it('writes nothing, and says so, while the binding has no buffer', async () => {
		const { renderer, writes } = await setup();
		expect(renderer.writeBufferAt(4, 32, RADIUS)).toBe(false);
		expect(writes).toEqual([]);
	});

	it("writes into the binding's buffer at the offset", async () => {
		const { renderer, writes } = await setup();
		renderer.writeUniform(4, new Uint8Array(80));
		writes.length = 0;
		expect(renderer.writeBufferAt(4, 32, RADIUS)).toBe(true);
		expect(writes).toEqual([{ buffer: 1, offset: 32, dataOffset: 0, size: undefined }]);
	});

	it('passes a range of the data on, in its elements', async () => {
		const { renderer, writes } = await setup();
		renderer.writeAttribute(0, new Float32Array(64));
		writes.length = 0;
		// One axis's region of a table of ticks.
		renderer.writeBufferAt(0, 16 * 4, new Float32Array(64), 16, 16);
		expect(writes).toEqual([{ buffer: 1, offset: 64, dataOffset: 16, size: 16 }]);
	});

	it('follows the binding to the buffer that replaced one it outgrew', async () => {
		const { renderer, writes } = await setup();
		renderer.writeUniform(4, new Uint8Array(80));
		renderer.writeBufferAt(4, 32, RADIUS);
		// The component writes more than the buffer holds: a new one.
		renderer.writeUniform(4, new Uint8Array(160));
		writes.length = 0;
		renderer.writeBufferAt(4, 32, RADIUS);
		expect(writes).toEqual([{ buffer: 2, offset: 32, dataOffset: 0, size: undefined }]);
	});
});
