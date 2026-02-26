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
		try {
			await loadArrowIPCTable(coordinator, name, slice);
		} catch (err) {
			console.error(`[diveplot] failed to load table "${name}":`, err);
			throw err;
		}
	}

	const tableNames = manifest.map((m) => m.name).join(', ');
	console.log(`[diveplot] loaded ${manifest.length} table(s) [${tableNames}], rendering…`);
	console.log('[diveplot] spec:', JSON.stringify(spec, null, 2));
	console.log('[diveplot] el dimensions:', el.clientWidth, 'x', el.clientHeight, el);

	// Debug: verify table data is accessible
	for (const { name } of manifest) {
		try {
			const result = await coordinator.query(`SELECT * FROM "${name}" LIMIT 3`);
			const rows = Array.from(result);
			console.log(`[diveplot] table "${name}" sample (${rows.length} rows):`, rows);
			const colResult = await coordinator.query(
				`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${name}'`
			);
			console.log(`[diveplot] table "${name}" schema:`, Array.from(colResult));
		} catch (err) {
			console.error(`[diveplot] table "${name}" query failed:`, err);
		}
	}

	const handle = await divePlotRender(el, spec, { coordinator });
	console.log('[diveplot] render complete, el children:', el.children.length);

	// Debug: check el dimensions after render
	setTimeout(() => {
		console.log('[diveplot] post-render el dimensions:', el.clientWidth, 'x', el.clientHeight);
		const specPlot = el.querySelector('[class*="diveplot-spec-plot"]') as HTMLElement;
		if (specPlot) {
			console.log('[diveplot] spec-plot dimensions:', specPlot.clientWidth, 'x', specPlot.clientHeight);
		}
		const chartCell = el.querySelector('[class*="chart-cell"]') as HTMLElement;
		if (chartCell) {
			console.log('[diveplot] chart-cell dimensions:', chartCell.clientWidth, 'x', chartCell.clientHeight);
		}
		const canvas = el.querySelector('canvas') as HTMLCanvasElement;
		if (canvas) {
			console.log('[diveplot] canvas dimensions:', canvas.clientWidth, 'x', canvas.clientHeight, 'buffer:', canvas.width, 'x', canvas.height);
		}

		// Check shadow DOM
		console.log('[diveplot] el is in shadow DOM:', !!el.getRootNode()?.host);
		console.log('[diveplot] el root node:', el.getRootNode());
	}, 1000);

	return handle;
}

function render({ model, el }: RenderContext): () => void {
	let handle: { destroy(): void } | null = null;

	// Chain this render onto the global queue to prevent concurrent renders
	// (anywidget may call render() multiple times in quick succession)
	renderChain = renderChain
		.then(async () => {
			handle = await doRender(model, el);
		})
		.catch((err) => {
			console.error('[diveplot] render failed:', err);
		});

	model.on('change:spec', () => {
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
			});
	});

	return () => {
		if (handle) handle.destroy();
	};
}

export default { render };
