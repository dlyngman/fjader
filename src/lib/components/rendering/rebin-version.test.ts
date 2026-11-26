import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { BaseGPURenderer } from './BaseGPURenderer.svelte';
import { MorphedChannels } from '$lib/gpu/MorphedChannels';
import {
	buildBinCut,
	buildBinRemap,
	oncePerVersion,
	type BinRemapSide,
	type RebinDecision,
	type RebinSource
} from '$lib/gpu/bin-remap';

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
	/** A cut's morphed write: its row ids and both maps. */
	const cuts: { rows: number[]; remap: Uint32Array; gather: Uint32Array }[] = [];
	vi.spyOn(MorphedChannels.prototype, 'write').mockImplementation(
		(ids, _channels, _land, remap, gather) => {
			if (gather && remap) cuts.push({ rows: Array.from(ids), remap, gather });
			else if (gather) gathered.push(gather);
			else written.push(remap ?? null);
			return false;
		}
	);
	vi.spyOn(MorphedChannels.prototype, 'has').mockReturnValue(true);
	let atRest: (() => void) | null = null;
	vi.spyOn(MorphedChannels.prototype, 'whenLanding').mockImplementation((fn) => {
		atRest = fn;
	});

	/** Static uploads, by buffer label (`rects-binding-N`, `rects-vertex-slot-N`). */
	const uploads: string[] = [];
	/** The seam fade's values as written (4-byte writes at an offset). */
	const fades: number[] = [];
	const clocks = new Set<{ finish(): void }>();
	const device = {
		createBuffer: ({ label }: { label: string }) => ({ label, size: 1 << 16, destroy() {} }),
		createBindGroup: () => ({}),
		queue: {
			writeBuffer: (b: { label: string }, offset: number, data: Float32Array) => {
				if (offset > 0 && data.length === 1) fades.push(data[0]);
				else uploads.push(b.label);
			}
		}
	};
	const coordinator = {
		acquirePipeline: async () => ({ pipeline: {}, dataLayout: {} }),
		releaseRenderer: () => {},
		rebuildRenderPlan: () => {},
		registerLayer: () => ({ remove: () => {} }),
		invalidateChart: () => {},
		registerComputeWork: () => {},
		removeComputeWork: () => {},
		addAnimatedSource: (c: { finish(): void }) => clocks.add(c),
		removeAnimatedSource: (c: { finish(): void }) => clocks.delete(c)
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
		commitLayout: () => log.push(`commit ${version}`),
		layout: () => ({ kind: 'runs' })
	};
	return {
		renderer,
		source,
		log,
		written,
		gathered,
		cuts,
		uploads,
		fades,
		/** Finish every running clock (the seam fade), and the microtask after. */
		settleClocks: async () => {
			for (const c of [...clocks]) c.finish();
			await Promise.resolve();
			await Promise.resolve();
		},
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
		renderer.setBinning(source, { geometry: 'interval', edges: [0, 1] });

		const map = new Uint32Array([1, 2, 3]);
		setNext({ kind: 'forward', map, why: 'split' });
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
		renderer.setBinning(source, { geometry: 'interval', edges: [0, 1] });

		setNext({ kind: 'forward', map: new Uint32Array([9]), why: 'split' });
		renderer.writeAttribute(0, EDGES);
		setVersion(2);
		setNext(null);
		renderer.writeMorphed('x', EDGES, [[2, HEIGHTS]]);
		expect(written).toEqual([null]);
	});

	it('starts over for a new source (a rebuilt lifecycle)', async () => {
		const first = setup();
		await initialized(first.renderer);
		first.renderer.setBinning(first.source, { geometry: 'interval' });
		first.renderer.writeAttribute(0, EDGES);

		const log: string[] = [];
		const other: RebinSource = {
			dataVersion: () => 1,
			takeRebin: () => (log.push('take'), null),
			layout: () => ({ kind: 'runs' }),
			commitLayout: () => log.push('commit')
		};
		first.renderer.setBinning(other, { geometry: 'interval' });
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
	t.renderer.setBinning(t.source, { geometry: 'interval', edges: [0, 1] });
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

	it('defers the uniforms too, so a layout they describe stays the held one until the swap', async () => {
		const t = await drawn();
		t.setVersion(2);
		t.setNext({ kind: 'hold', map: HOLD });
		writeAll(t.renderer, MERGED, MERGED_HEIGHTS);
		// A path writes its grid (bins per series, series) into its uniform.
		t.renderer.writeUniform(5, new Uint8Array(16));
		expect(t.uploads.some((label) => label.includes('uniform'))).toBe(false);

		t.setNext({ kind: 'forward', map: FORWARD, why: 'not nested' });
		await t.land();
		expect(t.uploads).toContain('rects-uniform-5');
	});

	it('writes the new layout when the rows land, through a forward map, and commits', async () => {
		const t = await drawn();
		t.setVersion(2);
		t.setNext({ kind: 'hold', map: HOLD });
		writeAll(t.renderer, MERGED, MERGED_HEIGHTS);

		t.setNext({ kind: 'forward', map: FORWARD, why: 'not nested' });
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
		t.setNext({ kind: 'forward', map: FORWARD, why: 'not nested' });
		t.renderer.writeMorphed('x', MERGED, [[2, MERGED_HEIGHTS]]);
		expect(t.log).toEqual(['take 2 canHold', 'take 3 canHold', 'commit 3']);
		expect(t.uploads).toEqual(['rects-binding-0', 'rects-binding-5']);
		expect(t.renderer.instanceCount).toBe(2);
		expect(t.written).toEqual([FORWARD]);

		// The landing of the hold that ended does nothing.
		await t.land();
		expect(t.log).toEqual(['take 2 canHold', 'take 3 canHold', 'commit 3']);
	});

	it('holds for a point geometry without edge bindings: a held point needs no cut', async () => {
		const t = setup();
		await initialized(t.renderer);
		t.renderer.setBinning(t.source, { geometry: 'point' });
		writeAll(t.renderer, EDGES, HEIGHTS);
		t.setVersion(2);
		writeAll(t.renderer, MERGED, MERGED_HEIGHTS);
		// With rows drawn, the source is told this renderer can hold.
		expect(t.log).toEqual(['take 1', 'commit 1', 'take 2 canHold', 'commit 2']);
	});

	it('ends the hold when the lifecycle is rebuilt', async () => {
		const t = await drawn();
		t.setVersion(2);
		t.setNext({ kind: 'hold', map: HOLD });
		writeAll(t.renderer, MERGED, MERGED_HEIGHTS);
		t.renderer.setBinning(null, { geometry: 'interval' });
		expect(t.uploads).toEqual(['rects-binding-0']);
		expect(t.renderer.instanceCount).toBe(2);
	});
});

describe('a merge that does not nest: the cut', () => {
	it('writes the pieces at once, from the held rows, and holds them', async () => {
		const t = await drawn();
		const colour = new Float32Array([1, 2, 3]);
		t.renderer.writeAttribute(4, colour);
		t.uploads.length = 0;

		// Held bins [0,1], [1,2], [2,3]; a new edge at 1.5 cuts the middle one.
		const held = side([0, 1, 2, 3]);
		const next = side([0, 1.5, 3]);
		const cut = buildBinCut(held, next)!;
		t.setVersion(2);
		t.setNext({ kind: 'cut', cut });
		writeAll(t.renderer, MERGED, MERGED_HEIGHTS);

		expect(t.log).toEqual(['take 2 canHold', 'commit 2']);
		// The pieces' edges and the colour run-copied: written now, not deferred.
		expect(t.uploads).toEqual(['rects-binding-0', 'rects-binding-4']);
		expect(t.renderer.instanceCount).toBe(4);
		expect(t.cuts).toEqual([{ rows: [0, 1, 1.5, 2], remap: cut.fromHeld, gather: cut.fromNew }]);

		// A later morphed write of the same version gathers into the pieces.
		t.renderer.writeMorphed('x', MERGED, [[2, MERGED_HEIGHTS]]);
		expect(t.gathered).toEqual([cut.fromNew]);

		// Landing: the new layout goes up through the forward map.
		t.setNext({ kind: 'forward', map: FORWARD, why: 'renderer cannot hold' });
		await t.land();
		expect(t.renderer.instanceCount).toBe(2);
		expect(t.written).toEqual([FORWARD]);
	});
});

describe('the seam fade', () => {
	const FADE = { binding: 6, offset: 52 };
	async function withFade() {
		const t = setup();
		await initialized(t.renderer);
		t.renderer.setBinning(t.source, {
			geometry: 'interval',
			edges: [0, 1],
			seams: 9,
			seamFade: FADE
		});
		t.renderer.writeUniform(6, new Float32Array(16));
		writeAll(t.renderer, new Float32Array([0, 1, 2, 3]), new Float32Array([1, 2, 3, 4]));
		t.uploads.length = 0;
		t.fades.length = 0;
		t.written.length = 0;
		return t;
	}

	it('closes the siblings’ gaps once a hold lands, and swaps only then', async () => {
		const t = await withFade();
		// Four held bins, pairs into two parents.
		const map = buildBinRemap(side([0, 2, 4]), side([0, 1, 2, 3, 4]), 1e-3)!;
		t.setVersion(2);
		t.setNext({ kind: 'hold', map });
		writeAll(t.renderer, MERGED, MERGED_HEIGHTS);
		expect(t.uploads).toContain('rects-vertex-slot-9');
		expect(t.fades).toEqual([1]);

		t.setNext({ kind: 'forward', map: FORWARD, why: 'renderer cannot hold' });
		await t.land();
		// Closing: no swap yet.
		expect(t.fades).toEqual([1, 1]);
		expect(t.written).toEqual([]);

		await t.settleClocks();
		expect(t.fades.at(-1)).toBe(0);
		expect(t.written).toEqual([FORWARD]);
		expect(t.renderer.getVertexBuffer(9)).toBeUndefined();
	});

	it('opens a split’s gaps from closed, then drops its seams', async () => {
		const t = await withFade();
		const map = buildBinRemap(side([0, 2, 4]), side([0, 1, 2, 3, 4]))!;
		t.setVersion(2);
		t.setNext({ kind: 'forward', map, why: 'split' });
		writeAll(t.renderer, new Float32Array([0, 1, 2, 3]), new Float32Array([1, 1, 2, 2]));
		expect(t.uploads).toContain('rects-vertex-slot-9');
		expect(t.fades).toEqual([0]);

		await t.settleClocks();
		expect(t.renderer.getVertexBuffer(9)).toBeUndefined();
	});

	it('writes no seams for a forward map with no siblings (a moved window)', async () => {
		const t = await withFade();
		const map = buildBinRemap(side([0, 1, 2, 3]), side([1, 2, 3, 4]))!;
		t.setVersion(2);
		t.setNext({ kind: 'forward', map, why: 'window' });
		writeAll(t.renderer, new Float32Array([1, 2, 3]), MERGED_HEIGHTS);
		expect(t.uploads).not.toContain('rects-vertex-slot-9');
		expect(t.fades).toEqual([]);
	});
});

describe('a cut’s seams', () => {
	it('go to the declared slot with the cut, and leave with its hold', async () => {
		const t = setup();
		await initialized(t.renderer);
		t.renderer.setBinning(t.source, { geometry: 'interval', edges: [0, 1], seams: 9 });
		writeAll(t.renderer, EDGES, HEIGHTS);
		t.uploads.length = 0;

		const cut = buildBinCut(side([0, 1, 2, 3]), side([0, 1.5, 3]))!;
		t.setVersion(2);
		t.setNext({ kind: 'cut', cut });
		writeAll(t.renderer, MERGED, MERGED_HEIGHTS);
		expect(t.uploads).toContain('rects-vertex-slot-9');
		expect(t.renderer.getVertexBuffer(9)).toBeDefined();

		t.setNext({ kind: 'forward', map: FORWARD, why: 'renderer cannot hold' });
		await t.land();
		expect(t.renderer.getVertexBuffer(9)).toBeUndefined();
	});
});

function side(edges: number[]): BinRemapSide {
	const lower = Float32Array.from(edges.slice(0, -1));
	const upper = Float32Array.from(edges.slice(1));
	return {
		lower,
		upper,
		layout: { series: 1, bins: lower.length, facets: 1 },
		ids: []
	};
}

describe('one decision for every renderer of a mark', () => {
	it('gives the second renderer of a version the decision the first took, after it committed', () => {
		// A source as the lifecycle's: a decision compares the result with the
		// layout last committed, and the first renderer commits on its write.
		let version = 1;
		let committed = 'coarse';
		const current = () => (version === 1 ? 'coarse' : 'fine');
		const map = new Uint32Array([1, 2, 3]);
		const fresh = (): RebinDecision =>
			committed === current() ? null : { kind: 'forward', map, why: 'split' };
		const take = oncePerVersion(() => version, fresh);
		const commit = () => (committed = current());

		version = 2;
		const fill = take(false);
		commit();
		const outline = take(false);
		expect(fill).toEqual({ kind: 'forward', map, why: 'split' });
		expect(outline).toBe(fill);
		// Taken afresh, the outline would have found nothing and snapped.
		expect(fresh()).toBeNull();
		// The next version decides again.
		version = 3;
		expect(take(false)).toBeNull();
	});
	it('a hold’s end asks for its own version without holding, and gets a forward map, not the hold', () => {
		const version = 1;
		const hold: RebinDecision = { kind: 'hold', map: new Uint32Array([1]) };
		const forward: RebinDecision = { kind: 'forward', map: new Uint32Array([2]), why: 'split' };
		const take = oncePerVersion(
			() => version,
			(canHold) => (canHold ? hold : forward)
		);
		// The fill and the outline both hold…
		expect(take(true)).toBe(hold);
		expect(take(true)).toBe(hold);
		// …and at the landing each swaps through the same forward map.
		expect(take(false)).toBe(forward);
		expect(take(false)).toBe(forward);
	});
});
