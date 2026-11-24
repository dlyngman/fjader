/**
 * Shared rendering core for anywidget and Streamlit entry points.
 *
 * Provides framework-agnostic functions for loading data into DuckDB
 * and rendering a Fjader spec into a DOM element.
 */

import { render as fjaderRender } from '$lib/spec';
import { getOrCreateQueryEngine } from '$lib/spec/LazyQueryEngine';
import { isLoaded, loadArrowIPCTable } from './loadArrowIPC';

export interface ManifestEntry {
	name: string;
	hash: string;
	[key: string]: unknown;
}

export interface FjaderHandle {
	destroy(): void;
}

/**
 * Render a Fjader spec, loading Arrow IPC tables via the provided callback.
 *
 * A table this page already holds with the same content (name and hash) is not
 * asked for. The `getTableIPC` callback abstracts the data source:
 * - anywidget: a copy out of the widget's blob, or the bytes Python sends back
 *   when asked (widget/tables.ts); null when another widget loaded it meanwhile
 * - Streamlit: serializes ArrowTable instances
 */
export async function renderFromData(
	el: HTMLElement,
	specJson: string,
	manifestJson: string,
	getTableIPC: (entry: ManifestEntry) => Uint8Array | null | Promise<Uint8Array | null>
): Promise<FjaderHandle> {
	const spec = JSON.parse(specJson);
	const manifest: ManifestEntry[] = JSON.parse(manifestJson);

	const queryEngine = await getOrCreateQueryEngine();

	if (manifest.length > 0) {
		await Promise.all(
			manifest.map(async (entry) => {
				if (isLoaded(entry.name, entry.hash)) return;
				const ipcBytes = await getTableIPC(entry);
				if (ipcBytes === null) return;
				await loadArrowIPCTable(queryEngine, entry.name, ipcBytes, entry.hash);
			})
		);
	}

	return fjaderRender(el, spec, { queryEngine });
}

/** Display a styled error message inline in the target element. */
export function showError(el: HTMLElement, err: unknown): void {
	el.innerHTML = '';
	const msg = err instanceof Error ? err.message : String(err);
	const div = document.createElement('div');
	div.style.cssText =
		'padding:12px;color:#dc2626;font:13px/1.5 monospace;' +
		'white-space:pre-wrap;border:1px solid #fca5a5;' +
		'border-radius:4px;background:#fef2f2;';
	div.textContent = `[fjader] ${msg}`;
	el.appendChild(div);
	console.error('[fjader] render failed:', err);
}
