import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { BaseGPURenderer } from './BaseGPURenderer.svelte';
import { MorphedChannels } from '$lib/gpu/MorphedChannels';
import type { RebinDecision, RebinSource } from '$lib/gpu/bin-remap';

/**
 * A binned mark's rebin decision is taken once per data version, on that
 * version's FIRST write of any kind, and committed then. A mark writes each
 * channel from its own effect, in no order to rely on: the decision must not
 * depend on whether the bin edges or the morphed heights are written first.
 * The map goes to the version's first morphed write only.
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

afterEach(() => vi.restoreAllMocks());

function setup() {
	vi.spyOn(MorphedChannels, 'supported', 'get').mockReturnValue(true);
	const written: (Uint32Array | null)[] = [];
	vi.spyOn(MorphedChannels.prototype, 'write').mockImplementation(
		(_ids, _channels, _land, remap) => {
			written.push(remap ?? null);
			return false;
		}
	);

	const device = {
		createBuffer: () => ({ destroy() {} }),
		createBindGroup: () => ({}),
		queue: { writeBuffer: () => {} }
	};
	const coordinator = {
		acquirePipeline: async () => ({ pipeline: {}, dataLayout: {} }),
		releaseRenderer: () => {},
		rebuildRenderPlan: () => {},
		registerLayer: () => ({ remove: () => {} }),
		invalidateChart: () => {},
		registerComputeWork: () => {},
		removeComputeWork: () => {}
	};
	const renderer = new BaseGPURenderer(
		'rects',
		{ getDevice: () => device } as never,
		coordinator as never,
		{ chartId: 'chart-1', scaleTypes: {} } as never
	);

	let version = 1;
	const log: string[] = [];
	let next: RebinDecision = null;
	const source: RebinSource = {
		dataVersion: () => version,
		takeRebin: () => {
			log.push(`take ${version}`);
			return next;
		},
		commitLayout: () => log.push(`commit ${version}`)
	};
	return {
		renderer,
		source,
		log,
		written,
		setVersion: (v: number) => (version = v),
		setNext: (d: RebinDecision) => (next = d)
	};
}

const EDGES = new Float32Array([0, 1, 2]);
const HEIGHTS = new Float32Array([5, 6, 7]);

describe('the rebin decision, per data version', () => {
	it('is taken once, on the first write, whichever write that is', async () => {
		const { renderer, source, log, written, setVersion, setNext } = setup();
		await initialized(renderer);
		renderer.setBinning(source, 'interval');

		const map = new Uint32Array([1, 2, 3]);
		setNext({ kind: 'forward', map });
		// The static edges first, then the heights: the map still reaches the heights.
		renderer.writeAttribute(0, EDGES);
		renderer.writeMorphed('x', EDGES, [[2, HEIGHTS]]);
		renderer.updateInstanceCount(3);
		expect(log).toEqual(['take 1', 'commit 1']);
		expect(written).toEqual([map]);

		// A later morphed write of the same version (an Other split click) is aligned.
		renderer.writeMorphed('x', EDGES, [[2, HEIGHTS]]);
		expect(written).toEqual([map, null]);

		// The next version asks again, on its first write.
		setVersion(2);
		setNext(null);
		renderer.writeMorphed('x', EDGES, [[2, HEIGHTS]]);
		renderer.writeAttribute(0, EDGES);
		expect(log).toEqual(['take 1', 'commit 1', 'take 2', 'commit 2']);
		expect(written).toEqual([map, null, null]);
	});

	it('drops a map no morphed write of its version took', async () => {
		const { renderer, source, written, setVersion, setNext } = setup();
		await initialized(renderer);
		renderer.setBinning(source, 'interval');

		setNext({ kind: 'forward', map: new Uint32Array([9]) });
		renderer.writeAttribute(0, EDGES);
		setVersion(2);
		setNext(null);
		renderer.writeMorphed('x', EDGES, [[2, HEIGHTS]]);
		expect(written).toEqual([null]);
	});

	it('starts over for a new source (a rebuilt lifecycle)', async () => {
		const first = setup();
		await initialized(first.renderer);
		first.renderer.setBinning(first.source, 'interval');
		first.renderer.writeAttribute(0, EDGES);

		const log: string[] = [];
		const other: RebinSource = {
			dataVersion: () => 1,
			takeRebin: () => (log.push('take'), null),
			commitLayout: () => log.push('commit')
		};
		first.renderer.setBinning(other, 'interval');
		first.renderer.writeAttribute(0, EDGES);
		expect(log).toEqual(['take', 'commit']);
	});

	it('asks nothing without a binned source', async () => {
		const { renderer, log } = setup();
		await initialized(renderer);
		renderer.writeAttribute(0, EDGES);
		renderer.writeMorphed('x', EDGES, [[2, HEIGHTS]]);
		expect(log).toEqual([]);
	});
});

async function initialized(renderer: BaseGPURenderer): Promise<void> {
	await renderer.initialize({
		dataBindingConfig: [],
		markShaderCode: '',
		vertexBufferLayout: [],
		rendererDefinition: {}
	});
}
