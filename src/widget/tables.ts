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

/** How long a request waits for Python's answer: a large table takes seconds to arrive. */
export const REQUEST_TIMEOUT_MS = 120_000;

let requestCount = 0;

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
						new Error(
							`No answer from the kernel for table${wanted.length > 1 ? 's' : ''} ` +
								`${wanted.map((t) => `"${t.name}"`).join(', ')}. Is the kernel running? ` +
								'Re-run the cell to send the data again.'
						)
					)
				),
			timeoutMs
		);
		model.on('msg:custom', onMessage);
		model.send({ type: 'fjader:need', id, tables: wanted });
	});
}
