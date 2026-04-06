/**
 * Streamlit custom component entry point.
 *
 * Receives spec + DataFrames via Streamlit's component args protocol.
 * DataFrames arrive as ArrowTable instances (native Arrow IPC serialization).
 */

import { Streamlit, type RenderData } from 'streamlit-component-lib';
import type { ArrowTable } from 'streamlit-component-lib';
import { renderFromData, showError, type DivePlotHandle, type ManifestEntry } from '../widget/core';
import { configureForceServer } from '$lib/spec/LazyQueryEngine';
import '$lib/theme.css';

const root = document.getElementById('root')!;
let handle: DivePlotHandle | null = null;
let generation = 0;

function onRender(event: Event): void {
	const gen = ++generation;
	const { args } = (event as CustomEvent<RenderData>).detail;

	// Configure server-side DuckDB if requested
	configureForceServer(!!args.server_duckdb);

	// Destroy previous render
	if (handle) {
		handle.destroy();
		handle = null;
	}
	root.innerHTML = '';

	renderFromData(
		root,
		args.spec as string,
		args.data_manifest as string,
		(entry: ManifestEntry) => {
			const arrowTable = args[entry.arg as string] as ArrowTable;
			// .serialize().data returns the Arrow IPC bytes for the data table
			return arrowTable.serialize().data;
		}
	)
		.then((h) => {
			if (gen !== generation) {
				h.destroy();
				return;
			}
			handle = h;
		})
		.catch((err) => {
			if (gen !== generation) return;
			showError(root, err);
		});
}

/**
 * Register the Streamlit render listener and signal readiness.
 * Exported so entry-bundled.ts can defer this until after inline WASM is configured.
 * (With inlineDynamicImports, top-level code runs at bundle load — before async
 * WASM decompression finishes — so the bundled entry must control the timing.)
 */
export function init(): void {
	Streamlit.events.addEventListener(Streamlit.RENDER_EVENT, onRender);
	Streamlit.setComponentReady();
}
