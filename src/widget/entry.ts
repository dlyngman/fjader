/**
 * anywidget ESM entry point.
 *
 * Exports { render } following the anywidget ESM protocol:
 *   render({ model, el }) → cleanup function
 */

import { renderFromData, showError, type FjaderHandle, type ManifestEntry } from './core';
import { followHostScheme } from './hostScheme';
import { isLoaded, whenLoaded } from './loadArrowIPC';
import { tablesFromKernel, takeTables, type TableMessaging, type WidgetTableEntry } from './tables';
import '$lib/theme.css';

interface AnywidgetModel extends TableMessaging {
	get(key: 'spec'): string;
	get(key: 'data_manifest'): string;
	get(key: 'data_blob'): DataView;
	on(event: string, callback: (...args: never[]) => void): void;
	off(event: string, callback: (...args: never[]) => void): void;
}

interface RenderContext {
	model: AnywidgetModel;
	el: HTMLElement;
}

async function doRender(model: AnywidgetModel, el: HTMLElement): Promise<FjaderHandle> {
	const manifestJson = model.get('data_manifest');
	const manifest = JSON.parse(manifestJson) as WidgetTableEntry[];

	// Before any await: the tables in the blob are copied out now (see takeTables).
	const { copies, missing } = takeTables(manifest, model.get('data_blob'), isLoaded);
	// The tables the blob left out: asked of the kernel, once per page.
	const fromKernel = missing.length > 0 ? tablesFromKernel(model, missing, whenLoaded) : null;

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
		const copy = copies.get(entry.name);
		if (copy) return copy;
		if (!fromKernel) throw new Error(`No data for table "${entry.name}" in the widget`);
		return fromKernel(entry);
	});

	// Tell Python which tables this page holds: later widgets leave them out.
	const loaded = manifest.filter((e) => isLoaded(e.name, e.hash)).map((e) => e.hash);
	if (loaded.length > 0) model.send({ type: 'fjader:loaded', hashes: loaded });

	return handle;
}

const WATCHED_TRAITS = ['change:spec', 'change:data_manifest', 'change:data_blob'] as const;

function render({ model, el }: RenderContext): () => void {
	// Light or dark as the notebook is, not the system (see hostScheme).
	const stopFollowingScheme = followHostScheme(el);
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
		stopFollowingScheme();
		for (const trait of WATCHED_TRAITS) model.off(trait, scheduleRender);
		if (handle) handle.destroy();
		handle = null;
	};
}

export default { render };
