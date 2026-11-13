import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tableFromIPC, tableToIPC, tableFromArrays } from '@uwdata/flechette';
import { PendingQueryLane, _resetSliceWarning, type PendingQueryBindings } from './sliced-lane';
import { QueryEngine, type DuckDBConnection } from './QueryEngine';

/**
 * Fake pending-query bindings, one connection. A statement takes `slices`
 * polls before its header, then returns `chunks`. A test can hold a poll open
 * (`gate`) to act while the statement runs, and sees every call in `calls`.
 */
function fakeBindings(
	plan: Record<string, { slices?: number; chunks?: Uint8Array[]; fail?: Error }> = {}
) {
	const calls: string[] = [];
	let current: { sql: string; left: number; chunks: Uint8Array[]; fail?: Error } | null = null;
	let canceled = false;
	let gate: Promise<void> | null = null;
	/** What cancelPendingQuery returns: false when the query already finished. */
	let cancelResult = true;
	/** Return the header on the next poll even after a cancel (the race). */
	let finishDespiteCancel = false;

	const header = (sql: string) => new TextEncoder().encode(`header:${sql}`);
	const step = async (): Promise<Uint8Array | null> => {
		if (gate) await gate;
		const q = current!;
		if (canceled && !finishDespiteCancel) {
			canceled = false;
			throw new Error('query was canceled');
		}
		if (q.fail) throw q.fail;
		if (q.left > 0 && !finishDespiteCancel) {
			q.left--;
			return null;
		}
		return header(q.sql);
	};

	const bindings: PendingQueryBindings = {
		async startPendingQuery(_conn, sql) {
			calls.push(`start ${sql}`);
			const p = plan[sql] ?? {};
			canceled = false;
			current = { sql, left: p.slices ?? 0, chunks: [...(p.chunks ?? [])], fail: p.fail };
			return step();
		},
		async pollPendingQuery() {
			calls.push(`poll ${current!.sql}`);
			return step();
		},
		async cancelPendingQuery() {
			calls.push(`cancel ${current?.sql}`);
			canceled = true;
			return cancelResult;
		},
		async fetchQueryResults() {
			calls.push(`fetch ${current!.sql}`);
			if (gate) await gate;
			return current!.chunks.shift() ?? null;
		}
	};
	return {
		bindings,
		calls,
		hold() {
			let open!: () => void;
			gate = new Promise((r) => (open = r));
			return () => {
				gate = null;
				open();
			};
		},
		set cancelResult(v: boolean) {
			cancelResult = v;
		},
		set finishDespiteCancel(v: boolean) {
			finishDespiteCancel = v;
		}
	};
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

function lane(fake: ReturnType<typeof fakeBindings>, onClose = vi.fn(async () => {})) {
	return { lane: new PendingQueryLane(fake.bindings, 1, onClose), onClose };
}

describe('PendingQueryLane', () => {
	beforeEach(() => _resetSliceWarning());

	it('returns [header, ...chunks] and the polls it took', async () => {
		const c1 = new Uint8Array([1]);
		const c2 = new Uint8Array([2]);
		const fake = fakeBindings({ q: { slices: 2, chunks: [c1, c2] } });
		const { lane: l } = lane(fake);
		const { ipc, polls } = await l.query('q');
		expect(polls).toBe(2);
		expect(new TextDecoder().decode(ipc[0])).toBe('header:q');
		expect(ipc.slice(1)).toEqual([c1, c2]);
	});

	it('runs one statement at a time, first in first out', async () => {
		const fake = fakeBindings({ a: { slices: 2 }, b: { slices: 1 } });
		const { lane: l } = lane(fake);
		await Promise.all([l.exec('a'), l.exec('b')]);
		expect(fake.calls).toEqual(['start a', 'poll a', 'poll a', 'start b', 'poll b']);
	});

	it('drops a statement aborted while queued, and runs the rest', async () => {
		const fake = fakeBindings({ a: { slices: 1 } });
		const { lane: l } = lane(fake);
		const release = fake.hold();
		const a = l.exec('a');
		const ctl = new AbortController();
		const b = l.exec('b', ctl.signal);
		const c = l.exec('c');
		ctl.abort();
		await expect(b).rejects.toSatisfy(isAbort);
		release();
		await Promise.all([a, c]);
		expect(fake.calls.some((x) => x.includes(' b'))).toBe(false);
	});

	it('rejects at once on a signal already aborted', async () => {
		const { lane: l } = lane(fakeBindings());
		const ctl = new AbortController();
		ctl.abort();
		await expect(l.query('q', ctl.signal)).rejects.toSatisfy(isAbort);
	});

	it('cancels a running statement before its header, as AbortError, and moves on', async () => {
		const fake = fakeBindings({ slow: { slices: 100 } });
		const { lane: l } = lane(fake);
		const ctl = new AbortController();
		const release = fake.hold();
		const slow = l.query('slow', ctl.signal);
		const next = l.query('next');
		await tick();
		ctl.abort();
		release();
		await expect(slow).rejects.toSatisfy(isAbort);
		expect(fake.calls).toContain('cancel slow');
		await expect(next).resolves.toBeTruthy();
	});

	it('passes an error it did not cause through unchanged', async () => {
		const boom = new Error('Binder Error: no such table');
		const fake = fakeBindings({ bad: { slices: 1, fail: boom } });
		const { lane: l } = lane(fake);
		await expect(l.query('bad')).rejects.toBe(boom);
		await expect(l.query('ok')).resolves.toBeTruthy();
	});

	it('after the header: stops fetching, cancels nothing, rejects', async () => {
		const fake = fakeBindings({ q: { chunks: [new Uint8Array([1]), new Uint8Array([2])] } });
		const { lane: l } = lane(fake);
		const ctl = new AbortController();
		const p = l.query('q', ctl.signal);
		// Let start return the header and the first fetch begin, held open.
		const release = fake.hold();
		await tick();
		ctl.abort();
		release();
		await expect(p).rejects.toSatisfy(isAbort);
		expect(fake.calls.filter((x) => x.startsWith('cancel'))).toEqual([]);
		expect(fake.calls.filter((x) => x.startsWith('fetch')).length).toBe(1);
	});

	it('treats a cancel that loses the race (the query finished) as aborted', async () => {
		const fake = fakeBindings({ q: { slices: 5 } });
		fake.cancelResult = false;
		const { lane: l } = lane(fake);
		const ctl = new AbortController();
		const release = fake.hold();
		const p = l.query('q', ctl.signal);
		await tick();
		ctl.abort();
		fake.finishDespiteCancel = true;
		release();
		await expect(p).rejects.toSatisfy(isAbort);
	});

	it('close: rejects the queue, cancels the running one, then closes the connection', async () => {
		const fake = fakeBindings({ slow: { slices: 100 } });
		const onClose = vi.fn(async () => {});
		const { lane: l } = lane(fake, onClose);
		const release = fake.hold();
		const running = l.query('slow');
		const queued = l.query('queued');
		await tick();
		const closing = l.close();
		release();
		await expect(queued).rejects.toSatisfy(isAbort);
		await expect(running).rejects.toSatisfy(isAbort);
		await closing;
		expect(fake.calls).toContain('cancel slow');
		expect(onClose).toHaveBeenCalledTimes(1);
		await expect(l.query('later')).rejects.toSatisfy(isAbort);
	});

	describe('slice warning', () => {
		let warn: ReturnType<typeof vi.spyOn>;
		let now = 0;
		beforeEach(() => {
			warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			vi.spyOn(performance, 'now').mockImplementation(() => now);
		});
		afterEach(() => vi.restoreAllMocks());

		function timed(sliceMs: number) {
			const fake = fakeBindings({ q: { slices: 4 } });
			const poll = fake.bindings.pollPendingQuery;
			fake.bindings.pollPendingQuery = async (c) => {
				now += sliceMs;
				return poll(c);
			};
			return lane(fake).lane;
		}

		it('warns once per page when slices run long', async () => {
			await timed(100).exec('q');
			await timed(100).exec('q');
			expect(warn).toHaveBeenCalledTimes(1);
		});

		it('says nothing at short slices', async () => {
			await timed(5).exec('q');
			expect(warn).not.toHaveBeenCalled();
		});
	});
});

describe('flechette reads a lane result as a stream', () => {
	it('decodes [header, ...batches] given as separate buffers', () => {
		// A stream split at message boundaries, as the worker returns it.
		const t = tableFromArrays({ x: new Float32Array([1, 2, 3]) });
		const bytes = tableToIPC(t, { format: 'stream' })!;
		const decoded = tableFromIPC([bytes]);
		expect(Array.from(decoded.getChild('x')!.toArray() as Float32Array)).toEqual([1, 2, 3]);
	});
});

describe('QueryEngine.openSlicedLane', () => {
	const base = {
		query: vi.fn(),
		close: vi.fn(async () => {})
	} as unknown as DuckDBConnection;

	it('is null for a connection that cannot open one', async () => {
		const engine = new QueryEngine({ ...base });
		expect(await engine.openSlicedLane()).toBeNull();
	});

	it('closes its lanes on destroy', async () => {
		const close = vi.fn(async () => {});
		const conn = {
			...base,
			exec: vi.fn(async () => {}),
			openSlicedLane: async () => ({ query: vi.fn(), exec: vi.fn(), close })
		} as unknown as DuckDBConnection;
		const engine = new QueryEngine(conn);
		const lane = await engine.openSlicedLane();
		expect(lane).not.toBeNull();
		await engine.destroy();
		expect(close).toHaveBeenCalledTimes(1);
	});
});
