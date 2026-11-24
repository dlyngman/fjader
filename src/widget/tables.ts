/**
 * A widget's tables: taken out of its blob, or asked of Python when the blob
 * left them out.
 *
 * Python leaves a table out of a widget's blob once a browser has confirmed it
 * loaded it (python/fjader/_display.py), so a chart shown again over the same
 * DataFrame does not send it again. The manifest still names every table, by
 * its content: `_df_<hash>`. A table this page holds with that exact name and
 * hash is used as is. One it does not hold (a reloaded page, another tab) is
 * asked for ("fjader:need"), and Python answers from the widget's own snapshot.
 * A reply is loaded only if it carries exactly the name and hash asked for: what
 * cannot be had fails the widget with an error, never shows other rows.
 */

import type { ManifestEntry } from './core';

/** A manifest entry: every table has a name and hash; one in the blob also its place there. */
export interface WidgetTableEntry extends ManifestEntry {
	offset?: number;
	length?: number;
}

/** What tables.ts needs of an anywidget model (Jupyter's and marimo's both). */
export interface TableMessaging {
	send(content: unknown, callbacks?: unknown, buffers?: ArrayBuffer[]): void;
	on(event: 'msg:custom', callback: (content: unknown, buffers: DataView[]) => void): void;
	off(event: 'msg:custom', callback: (content: unknown, buffers: DataView[]) => void): void;
}

/** The bytes of the tables in the blob, and the tables to ask Python for. */
export interface TakenTables {
	copies: Map<string, Uint8Array>;
	missing: WidgetTableEntry[];
}

/**
 * Copy the tables this page lacks out of the blob, now: anywidget may detach
 * the blob's ArrayBuffer once the caller awaits. A table already loaded with the
 * same content is neither copied nor asked for. Each copy owns its buffer,
 * which DuckDB-WASM's insert transfers to its worker without a further copy.
 *
 * Memory: the blob belongs to the model and stays for the widget's lifetime (a
 * re-render reads it again), so a load holds a table twice on the main thread
 * until the insert transfers the copy.
 */
export function takeTables(
	manifest: WidgetTableEntry[],
	blob: DataView,
	isLoaded: (name: string, hash: string) => boolean
): TakenTables {
	const copies = new Map<string, Uint8Array>();
	const missing: WidgetTableEntry[] = [];
	for (const entry of manifest) {
		if (isLoaded(entry.name, entry.hash)) continue;
		if (typeof entry.offset === 'number' && typeof entry.length === 'number') {
			const start = blob.byteOffset + entry.offset;
			copies.set(entry.name, new Uint8Array(blob.buffer.slice(start, start + entry.length)));
		} else {
			missing.push(entry);
		}
	}
	return { copies, missing };
}

/**
 * How long a request waits for the kernel's answer. A large table takes a few
 * seconds to arrive (60 MB: about 3 s in marimo); without a kernel (a notebook
 * saved from a live session) no answer comes, and marimo cannot say so, so the
 * wait is what ends it. A kernel busy running a long cell can answer later than
 * this: the error says to re-run the cell.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

let requestCount = 0;

/** No answer came within REQUEST_TIMEOUT_MS: no kernel, or one too busy to answer. */
export class NoAnswerError extends Error {
	override name = 'NoAnswerError';
}

/**
 * Ask Python for tables the blob left out. Resolves with each table's bytes, by
 * name, once the reply arrives; rejects if the reply lacks one, carries other
 * content under a name, or does not come (no kernel: a saved notebook).
 */
export function requestTables(
	model: TableMessaging,
	entries: WidgetTableEntry[],
	timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Map<string, Uint8Array>> {
	const id = `fjader-${Date.now().toString(36)}-${(requestCount++).toString(36)}`;
	const wanted = entries.map(({ name, hash }) => ({ name, hash }));
	return new Promise((resolve, reject) => {
		const done = (settle: () => void) => {
			clearTimeout(timer);
			model.off('msg:custom', onMessage);
			settle();
		};
		const onMessage = (content: unknown, buffers: DataView[]) => {
			const msg = content as {
				type?: string;
				id?: string;
				tables?: { name: string; hash: string }[];
				missing?: string[];
			};
			if (msg?.type !== 'fjader:tables' || msg.id !== id) return;
			const sent = msg.tables ?? [];
			const bytes = new Map<string, Uint8Array>();
			for (const { name, hash } of wanted) {
				const at = sent.findIndex((t) => t.name === name && t.hash === hash);
				const view = at >= 0 ? buffers?.[at] : undefined;
				if (!view) {
					done(() =>
						reject(new Error(`The kernel could not send table "${name}": its data is not there.`))
					);
					return;
				}
				// An owned copy: DuckDB-WASM's insert transfers (detaches) its buffer.
				bytes.set(
					name,
					new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
				);
			}
			done(() => resolve(bytes));
		};
		const timer = setTimeout(
			() =>
				done(() =>
					reject(
						new NoAnswerError(
							`This chart's data is not in the page, and the kernel did not send it ` +
								`(table${wanted.length > 1 ? 's' : ''} ${wanted.map((t) => `"${t.name}"`).join(', ')}). ` +
								'With a kernel running, re-run the cell. In a saved notebook, the chart was ' +
								'shown again over data the page already had: export the notebook with ' +
								'`marimo export html` or `jupyter nbconvert --execute` to keep every chart’s data.'
						)
					)
				),
			timeoutMs
		);
		model.on('msg:custom', onMessage);
		model.send({ type: 'fjader:need', id, tables: wanted });
	});
}

/** The tables being asked for on this page, by `name\u0000hash`: the request asking. */
const asking = new Map<string, Promise<Map<string, Uint8Array>>>();

const keyOf = (entry: { name: string; hash: string }) => `${entry.name}\u0000${entry.hash}`;

/**
 * A widget's source for the tables its blob left out: each one's bytes, or null
 * when another widget on the page loads it first.
 *
 * One request per table per page. On a reload every widget renders at once, and
 * every widget over the same DataFrame lacks the same table: the first asks, the
 * rest wait on its request (or on the table loading). A waiter whose request
 * fails asks for itself rather than fail with it, unless it failed for want of an
 * answer: asking the same silence again would only double the wait. Every
 * request is settled here,
 * so one nobody else waits on (its tables loaded meanwhile) cannot go unhandled.
 *
 * A waiter may get the very bytes the asker loads. Only one insert uses them:
 * loadArrowIPCTable holds a per-table lock and re-checks after it, so the second
 * load of a table returns before touching its bytes (which the first insert's
 * transfer to DuckDB's worker detaches).
 */
export function tablesFromKernel(
	model: TableMessaging,
	missing: WidgetTableEntry[],
	whenLoaded: (name: string, hash: string) => Promise<void>,
	request: typeof requestTables = requestTables
): (entry: ManifestEntry) => Promise<Uint8Array | null> {
	const theirs = new Map<string, Promise<Map<string, Uint8Array>>>();
	const mine: WidgetTableEntry[] = [];
	for (const entry of missing) {
		const inFlight = asking.get(keyOf(entry));
		if (inFlight) theirs.set(keyOf(entry), inFlight);
		else mine.push(entry);
	}
	const own = mine.length > 0 ? request(model, mine) : null;
	if (own) {
		for (const entry of mine) asking.set(keyOf(entry), own);
		// Settled: no longer in flight, so a widget that still lacks it asks again.
		const settle = () => {
			for (const entry of mine) if (asking.get(keyOf(entry)) === own) asking.delete(keyOf(entry));
		};
		own.then(settle, settle);
	}

	return (entry) => {
		const pick = (bytes: Map<string, Uint8Array>) => bytes.get(entry.name) ?? null;
		const loaded = whenLoaded(entry.name, entry.hash).then(() => null);
		const shared = theirs.get(keyOf(entry));
		const fetched = shared
			? shared.then(pick, (error: unknown) => {
					if (error instanceof NoAnswerError) throw error;
					return request(model, [entry]).then(pick);
				})
			: own
				? own.then(pick)
				: Promise.reject(new Error(`No data for table "${entry.name}" in the widget`));
		return Promise.race([fetched, loaded]);
	};
}
