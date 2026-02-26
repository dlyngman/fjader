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
	off?(event: string, callback: () => void): void;
}

interface RenderContext {
	model: AnywidgetModel;
	el: HTMLElement;
}

// Serialize all renders through a single promise chain to prevent races
let renderChain: Promise<void> = Promise.resolve();

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

	// Load Arrow IPC tables
	for (const { name, offset, length } of manifest) {
		const slice = blob.slice(offset, offset + length);
		await loadArrowIPCTable(coordinator, name, slice);
	}

	return divePlotRender(el, spec, { coordinator });
}

function render({ model, el }: RenderContext): () => void {
	let handle: { destroy(): void } | null = null;

	const onSpecChange = () => {
		renderChain = renderChain
			.then(async () => {
				if (handle) {
					handle.destroy();
					handle = null;
				}
				el.innerHTML = '';
				handle = await doRender(model, el);
			})
			.catch((err) => {
				console.error('[diveplot] re-render failed:', err);
				el.innerHTML = '';
				handle = null;
			});
	};

	// Initial render — chain onto global queue to prevent concurrent renders
	renderChain = renderChain
		.then(async () => {
			handle = await doRender(model, el);
		})
		.catch((err) => {
			console.error('[diveplot] render failed:', err);
			el.innerHTML = '';
			handle = null;
		});

	model.on('change:spec', onSpecChange);

	return () => {
		model.off?.('change:spec', onSpecChange);
		if (handle) handle.destroy();
		handle = null;
	};
}

export default { render };
