import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	requestTables,
	tablesFromKernel,
	takeTables,
	type TableMessaging,
	type WidgetTableEntry
} from './tables';

/** A model whose kernel answers each request with `reply(request)`, or not at all. */
function fakeModel(
	reply?: (request: { id: string; tables: { name: string; hash: string }[] }) => {
		content: unknown;
		buffers: Uint8Array[];
	}
) {
	const listeners = new Set<(content: unknown, buffers: DataView[]) => void>();
	const sent: unknown[] = [];
	const model: TableMessaging = {
		send(content) {
			sent.push(content);
			const request = content as {
				type: string;
				id: string;
				tables: { name: string; hash: string }[];
			};
			if (request.type !== 'fjader:need' || !reply) return;
			const { content: answer, buffers } = reply(request);
			const views = buffers.map((b) => new DataView(b.buffer, b.byteOffset, b.byteLength));
			// Another message first, as other traffic on the model would be.
			queueMicrotask(() => {
				for (const l of [...listeners]) l({ type: 'fjader:tables', id: 'someone-else' }, []);
				for (const l of [...listeners]) l(answer, views);
			});
		},
		on(_event, callback) {
			listeners.add(callback);
		},
		off(_event, callback) {
			listeners.delete(callback);
		}
	};
	return { model, sent, listeners };
}

const A: WidgetTableEntry = { name: '_df_aaaa', hash: 'aaaa' };
const B: WidgetTableEntry = { name: '_df_bbbb', hash: 'bbbb' };

describe('takeTables', () => {
	const blob = new DataView(new Uint8Array([1, 2, 3, 4, 5]).buffer);

	it('copies the tables in the blob and lists the rest as missing', () => {
		const { copies, missing } = takeTables(
			[{ ...A, offset: 0, length: 2 }, B, { name: '_df_cccc', hash: 'cccc', offset: 2, length: 3 }],
			blob,
			() => false
		);
		expect(Array.from(copies.get(A.name)!)).toEqual([1, 2]);
		expect(Array.from(copies.get('_df_cccc')!)).toEqual([3, 4, 5]);
		expect(copies.get(A.name)!.buffer).not.toBe(blob.buffer);
		expect(missing).toEqual([B]);
	});

	it('neither copies nor asks for a table loaded with the same content', () => {
		const loaded = (name: string, hash: string) => name === A.name && hash === A.hash;
		const { copies, missing } = takeTables([{ ...A, offset: 0, length: 2 }, B], blob, loaded);
		expect(copies.size).toBe(0);
		expect(missing).toEqual([B]);
	});
});

describe('requestTables', () => {
	afterEach(() => vi.useRealTimers());

	it('resolves with the bytes Python sends for exactly the tables asked for', async () => {
		const { model, sent, listeners } = fakeModel((request) => ({
			content: { type: 'fjader:tables', id: request.id, tables: [B, A], missing: [] },
			buffers: [new Uint8Array([9, 9]), new Uint8Array([7])]
		}));
		const bytes = await requestTables(model, [A, B]);
		expect(Array.from(bytes.get(A.name)!)).toEqual([7]);
		expect(Array.from(bytes.get(B.name)!)).toEqual([9, 9]);
		expect(sent[0]).toMatchObject({ type: 'fjader:need', tables: [A, B] });
		expect(listeners.size).toBe(0);
	});

	it('rejects a reply carrying other content under the name', async () => {
		const { model, listeners } = fakeModel((request) => ({
			content: {
				type: 'fjader:tables',
				id: request.id,
				tables: [{ name: A.name, hash: 'different' }],
				missing: []
			},
			buffers: [new Uint8Array([1])]
		}));
		await expect(requestTables(model, [A])).rejects.toThrow(/could not send table "_df_aaaa"/);
		expect(listeners.size).toBe(0);
	});

	it('rejects when Python lacks a table', async () => {
		const { model } = fakeModel((request) => ({
			content: { type: 'fjader:tables', id: request.id, tables: [], missing: [A.name] },
			buffers: []
		}));
		await expect(requestTables(model, [A])).rejects.toThrow(/could not send/);
	});

	it('rejects when no answer comes (no kernel)', async () => {
		vi.useFakeTimers();
		const { model, listeners } = fakeModel();
		const pending = requestTables(model, [A], 1000);
		const check = expect(pending).rejects.toThrow(/the kernel did not send it/);
		await vi.advanceTimersByTimeAsync(1000);
		await check;
		expect(listeners.size).toBe(0);
	});
});

describe('tablesFromKernel', () => {
	const never = () => new Promise<void>(() => {});
	const model = fakeModel().model;
	let n = 0;
	// Each test its own table, so the page-level bookkeeping of one cannot reach another.
	const table = (): WidgetTableEntry => {
		const hash = `t${n++}`;
		return { name: `_df_${hash}`, hash };
	};

	it('asks once per page: a second widget waits on the first one’s request', async () => {
		const t = table();
		let release!: (bytes: Map<string, Uint8Array>) => void;
		const request = vi.fn(() => new Promise<Map<string, Uint8Array>>((r) => (release = r)));

		const first = tablesFromKernel(model, [t], never, request);
		const second = tablesFromKernel(model, [t], never, request);
		expect(request).toHaveBeenCalledTimes(1);

		const bytes = new Uint8Array([4, 2]);
		const got = Promise.all([first(t), second(t)]);
		release(new Map([[t.name, bytes]]));
		expect(await got).toEqual([bytes, bytes]);
	});

	it('a waiter gives up its wait when the table loads', async () => {
		const t = table();
		const request = vi.fn(() => new Promise<Map<string, Uint8Array>>(() => {}));
		tablesFromKernel(model, [t], never, request);
		const second = tablesFromKernel(model, [t], () => Promise.resolve(), request);
		expect(await second(t)).toBeNull();
		expect(request).toHaveBeenCalledTimes(1);
	});

	it('a waiter asks for itself when the shared request fails', async () => {
		const t = table();
		const bytes = new Uint8Array([7]);
		const request = vi
			.fn()
			.mockImplementationOnce(() => Promise.reject(new Error('first widget gone')))
			.mockImplementationOnce(() => Promise.resolve(new Map([[t.name, bytes]])));

		const first = tablesFromKernel(model, [t], never, request);
		const second = tablesFromKernel(model, [t], never, request);
		await expect(first(t)).rejects.toThrow('first widget gone');
		expect(await second(t)).toBe(bytes);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('asks again once a request has settled', async () => {
		const t = table();
		const request = vi.fn(() => Promise.resolve(new Map([[t.name, new Uint8Array([1])]])));
		await tablesFromKernel(model, [t], never, request)(t);
		await tablesFromKernel(model, [t], never, request)(t);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it('a failed request nobody waits on is handled', async () => {
		const t = table();
		const request = vi.fn(() => Promise.reject(new Error('no kernel')));
		// Its table loaded meanwhile: nothing asks for the bytes.
		tablesFromKernel(model, [t], never, request);
		await new Promise((r) => setTimeout(r, 0));
		// An unhandled rejection would fail this test file.
		expect(request).toHaveBeenCalledTimes(1);
	});
});
