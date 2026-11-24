/**
 * anywidget ESM entry point.
 *
 * Exports { render } following the anywidget ESM protocol:
 *   render({ model, el }) → cleanup function
 */

import { renderFromData, showError, type FjaderHandle, type ManifestEntry } from './core';
import '$lib/theme.css';

interface AnywidgetModel {
	get(key: 'spec'): string;
	get(key: 'data_manifest'): string;
	get(key: 'data_blob'): DataView;
	on(event: string, callback: () => void): void;
	off(event: string, callback: () => void): void;
}

interface RenderContext {
	model: AnywidgetModel;
	el: HTMLElement;
}

async function doRender(model: AnywidgetModel, el: HTMLElement): Promise<FjaderHandle> {
	const blobView: DataView = model.get('data_blob');
	const manifestJson = model.get('data_manifest');

	// Copy each table out of the blob now, before any await: anywidget may
	// detach the blob's ArrayBuffer later. Each copy owns its buffer, which
	// DuckDB-WASM's insert transfers to its worker without a further copy.
	//
	// Memory: the blob belongs to the model and stays for the widget's lifetime
	// (a re-render reads it again), so a load holds the data twice on the main
	// thread until the inserts transfer the copies. Copying each table just
	// before its insert would lower the peak to blob + largest table, but only
	// if anywidget doesn't detach the blob meanwhile (unverified). After loading,
	// the blob and DuckDB's table still hold the data twice; freeing the blob
	// would need the Python side to clear `data_blob`.
	const tables = new Map<string, Uint8Array>();
	for (const entry of JSON.parse(manifestJson) as (ManifestEntry & {
		offset: number;
		length: number;
	})[]) {
		const start = blobView.byteOffset + entry.offset;
		tables.set(entry.name, new Uint8Array(blobView.buffer.slice(start, start + entry.length)));
	}

	// Size the container to the exact height computed by the Python wrapper.
	// Marimo / Jupyter constrain el's height; setting an explicit pixel value
	// before mount ensures vconcat layouts aren't clipped.
	const specJson = model.get('spec');
	const spec = JSON.parse(specJson);
	if (typeof spec._containerHeight === 'number' && spec._containerHeight > 0) {
		el.style.height = `${spec._containerHeight}px`;
		el.style.overflow = 'visible';
	}

	const handle = await renderFromData(el, specJson, manifestJson, (entry: ManifestEntry) => {
		const bytes = tables.get(entry.name);
		if (!bytes) throw new Error(`No data for table "${entry.name}" in the widget blob`);
		return bytes;
	});

	return handle;
}

const WATCHED_TRAITS = ['change:spec', 'change:data_manifest', 'change:data_blob'] as const;

function render({ model, el }: RenderContext): () => void {
	let handle: FjaderHandle | null = null;
	let renderPromise: Promise<void> = Promise.resolve();
	let pendingRender = false;

	const scheduleRender = () => {
		// Debounce — anywidget may deliver binary buffers and JSON traitlets
		// in separate messages. queueMicrotask coalesces updates that arrive
		// in the same event loop tick into a single render.
		if (pendingRender) return;
		pendingRender = true;
		queueMicrotask(() => {
			pendingRender = false;
			renderPromise = renderPromise
				.then(async () => {
					if (handle) {
						handle.destroy();
						handle = null;
					}
					el.innerHTML = '';
					handle = await doRender(model, el);
				})
				.catch((err) => {
					showError(el, err);
					handle = null;
				});
		});
	};

	// Initial render
	renderPromise = doRender(model, el)
		.then((h) => {
			handle = h;
		})
		.catch((err) => showError(el, err));

	for (const trait of WATCHED_TRAITS) model.on(trait, scheduleRender);

	return () => {
		for (const trait of WATCHED_TRAITS) model.off(trait, scheduleRender);
		if (handle) handle.destroy();
		handle = null;
	};
}

export default { render };
