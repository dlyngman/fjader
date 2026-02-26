/**
 * anywidget ESM entry point.
 *
 * Exports { render } following the anywidget ESM protocol:
 *   render({ model, el }) → cleanup function
 */

import { render as divePlotRender } from '$lib/spec';
import { getOrCreateCoordinator } from '$lib/spec/LazyCoordinator';
import { loadArrowIPCTable } from './loadArrowIPC';
import '$lib/theme.css';

interface Manifest {
	name: string;
	hash: string;
	offset: number;
	length: number;
}

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

function showError(el: HTMLElement, err: unknown): void {
	el.innerHTML = '';
	const msg = err instanceof Error ? err.message : String(err);
	const div = document.createElement('div');
	div.style.cssText =
		'padding:12px;color:#dc2626;font:13px/1.5 monospace;' +
		'white-space:pre-wrap;border:1px solid #fca5a5;' +
		'border-radius:4px;background:#fef2f2;';
	div.textContent = `[diveplot] ${msg}`;
	el.appendChild(div);
	console.error('[diveplot] render failed:', err);
}

async function doRender(
	model: AnywidgetModel,
	el: HTMLElement
): Promise<{ destroy(): void }> {
	const spec = JSON.parse(model.get('spec'));
	const manifest: Manifest[] = JSON.parse(model.get('data_manifest'));
	const blobView = model.get('data_blob');

	// Copy blob immediately — anywidget may detach the underlying ArrayBuffer
	const blob = new Uint8Array(blobView.buffer, blobView.byteOffset, blobView.byteLength).slice();

	const coordinator = await getOrCreateCoordinator();

	// Load Arrow IPC tables (deduplicated by content hash + per-table locked)
	await Promise.all(
		manifest.map(({ name, hash, offset, length }) => {
			const slice = blob.slice(offset, offset + length);
			return loadArrowIPCTable(coordinator, name, slice, hash);
		})
	);

	return divePlotRender(el, spec, { coordinator });
}

const WATCHED_TRAITS = ['change:spec', 'change:data_manifest', 'change:data_blob'] as const;

function render({ model, el }: RenderContext): () => void {
	let handle: { destroy(): void } | null = null;
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
