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
	/** Morphed writes during a hold: the gather map each carried. */
	const gathered: Uint32Array[] = [];
	vi.spyOn(MorphedChannels.prototype, 'write').mockImplementation(
		(_ids, _channels, _land, remap, gather) => {
			if (gather) gathered.push(gather);
			else written.push(remap ?? null);
			return false;
		}
	);
	vi.spyOn(MorphedChannels.prototype, 'has').mockReturnValue(true);
	let atRest: (() => void) | null = null;
	vi.spyOn(MorphedChannels.prototype, 'whenAtRest').mockImplementation((fn) => {
		atRest = fn;
	});

	/** Static uploads, by buffer label (`rects-binding-N`, `rects-vertex-slot-N`). */
	const uploads: string[] = [];
	const device = {
		createBuffer: ({ label }: { label: string }) => ({ label, size: 1 << 16, destroy() {} }),
		createBindGroup: () => ({}),
		queue: { writeBuffer: (b: { label: string }) => uploads.push(b.label) }
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
		takeRebin: (canHold) => {
			log.push(`take ${version}${canHold ? ' canHold' : ''}`);
			return next;
		},
		commitLayout: () => log.push(`commit ${version}`)
	};
	return {
		renderer,
		source,
		log,
		written,
		gathered,
		uploads,
		/** The landing, as an encode reports it, and the microtask the swap runs in. */
		land: async () => {
			atRest?.();
			await Promise.resolve();
		},
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
		// With rows drawn, a hold is possible: the source is told so.
		expect(log).toEqual(['take 1', 'commit 1', 'take 2 canHold', 'commit 2']);
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

const HOLD = new Uint32Array([7]);
const FORWARD = new Uint32Array([8]);
const MERGED = new Float32Array([0, 2]);
const MERGED_HEIGHTS = new Float32Array([11, 13]);

/** A renderer that has drawn version 1 (so it has morphing rows to hold). */
async function drawn() {
	const t = setup();
	await initialized(t.renderer);
	t.renderer.setBinning(t.source, 'interval');
	writeAll(t.renderer, EDGES, HEIGHTS);
	t.log.length = 0;
	t.uploads.length = 0;
	t.written.length = 0;
	return t;
}

/** What Rects writes per result: edges, heights (morphed), count. */
function writeAll(r: BaseGPURenderer, edges: Float32Array, heights: Float32Array) {
	r.writeAttribute(0, edges);
	r.writeMorphed('x', edges, [[2, heights]]);
	r.updateInstanceCount(edges.length);
}

describe('a merge that holds the drawn layout', () => {
	it('defers the static writes and the count, gathers the heights, commits nothing', async () => {
		const t = await drawn();
		t.setVersion(2);
		t.setNext({ kind: 'hold', map: HOLD });
		writeAll(t.renderer, MERGED, MERGED_HEIGHTS);

		expect(t.log).toEqual(['take 2 canHold']);
		expect(t.uploads).toEqual([]);
		expect(t.renderer.instanceCount).toBe(3);
		expect(t.gathered).toEqual([HOLD]);
		expect(t.written).toEqual([]);
	});

	it('writes the new layout when the rows land, through a forward map, and commits', async () => {
		const t = await drawn();
		t.setVersion(2);
		t.setNext({ kind: 'hold', map: HOLD });
		writeAll(t.renderer, MERGED, MERGED_HEIGHTS);

		t.setNext({ kind: 'forward', map: FORWARD });
		await t.land();
		expect(t.log).toEqual(['take 2 canHold', 'take 2', 'commit 2']);
		expect(t.uploads).toContain('rects-binding-0');
		expect(t.renderer.instanceCount).toBe(2);
		expect(t.written).toEqual([FORWARD]);
	});

	it('gathers again for a filter result during the hold, still holding', async () => {
		const t = await drawn();
		t.setVersion(2);
		t.setNext({ kind: 'hold', map: HOLD });
		writeAll(t.renderer, MERGED, MERGED_HEIGHTS);

		const again = new Uint32Array([9]);
		t.setVersion(3);
		t.setNext({ kind: 'hold', map: again });
		writeAll(t.renderer, MERGED, new Float32Array([12, 14]));
		expect(t.log).toEqual(['take 2 canHold', 'take 3 canHold']);
		expect(t.gathered).toEqual([HOLD, again]);
		expect(t.uploads).toEqual([]);
	});

	it('ends on a result that does not hold, flushing every deferred write', async () => {
		const t = await drawn();
		t.setVersion(2);
		t.setNext({ kind: 'hold', map: HOLD });
		writeAll(t.renderer, MERGED, MERGED_HEIGHTS);
		// A slot only the held version wrote: a mark rewrites only what changed.
		t.renderer.writeAttribute(5, new Float32Array([1, 1]));

		t.setVersion(3);
		t.setNext({ kind: 'forward', map: FORWARD });
		t.renderer.writeMorphed('x', MERGED, [[2, MERGED_HEIGHTS]]);
		expect(t.log).toEqual(['take 2 canHold', 'take 3 canHold', 'commit 3']);
		expect(t.uploads).toEqual(['rects-binding-0', 'rects-binding-5']);
		expect(t.renderer.instanceCount).toBe(2);
		expect(t.written).toEqual([FORWARD]);

		// The landing of the hold that ended does nothing.
		await t.land();
		expect(t.log).toEqual(['take 2 canHold', 'take 3 canHold', 'commit 3']);
	});

	it('does not hold for a point geometry: merges go forward until points can ride', async () => {
		const t = setup();
		await initialized(t.renderer);
		t.renderer.setBinning(t.source, 'point');
		writeAll(t.renderer, EDGES, HEIGHTS);
		t.setVersion(2);
		writeAll(t.renderer, MERGED, MERGED_HEIGHTS);
		expect(t.log).toEqual(['take 1', 'commit 1', 'take 2', 'commit 2']);
	});

	it('ends the hold when the lifecycle is rebuilt', async () => {
		const t = await drawn();
		t.setVersion(2);
		t.setNext({ kind: 'hold', map: HOLD });
		writeAll(t.renderer, MERGED, MERGED_HEIGHTS);
		t.renderer.setBinning(null, 'interval');
		expect(t.uploads).toEqual(['rects-binding-0']);
		expect(t.renderer.instanceCount).toBe(2);
	});
});
