import { describe, it, expect, vi, afterEach } from 'vitest';
import { requestTables, takeTables, type TableMessaging, type WidgetTableEntry } from './tables';

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
		const check = expect(pending).rejects.toThrow(/No answer from the kernel/);
		await vi.advanceTimersByTimeAsync(1000);
		await check;
		expect(listeners.size).toBe(0);
	});
});
