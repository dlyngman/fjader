/**
 * anywidget ESM entry point.
 *
 * Exports { render } following the anywidget ESM protocol:
 *   render({ model, el }) → cleanup function
 */

import { renderFromData, showError, type DivePlotHandle, type ManifestEntry } from './core';
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

async function doRender(model: AnywidgetModel, el: HTMLElement): Promise<DivePlotHandle> {
	const blobView = model.get('data_blob');

	// Copy blob immediately — anywidget may detach the underlying ArrayBuffer
	const blob = new Uint8Array(blobView.buffer, blobView.byteOffset, blobView.byteLength).slice();

	// Size the container to the exact height computed by the Python wrapper.
	// Marimo / Jupyter constrain el's height; setting an explicit pixel value
	// before mount ensures vconcat layouts aren't clipped.
	const specJson = model.get('spec');
	const spec = JSON.parse(specJson);
	if (typeof spec._containerHeight === 'number' && spec._containerHeight > 0) {
		el.style.height = `${spec._containerHeight}px`;
		el.style.overflow = 'visible';
	}

	const handle = await renderFromData(
		el,
		specJson,
		model.get('data_manifest'),
		(entry: ManifestEntry) => {
			const { offset, length } = entry as ManifestEntry & { offset: number; length: number };
			return new Uint8Array(blob.buffer, blob.byteOffset + offset, length);
		}
	);

	return handle;
}

const WATCHED_TRAITS = ['change:spec', 'change:data_manifest', 'change:data_blob'] as const;

function render({ model, el }: RenderContext): () => void {
	let handle: DivePlotHandle | null = null;
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
