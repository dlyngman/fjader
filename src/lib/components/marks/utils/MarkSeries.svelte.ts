import { untrack } from 'svelte';
import { resolveChannel } from './channel-resolution';
import { isNode } from '@uwdata/mosaic-sql';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';

/**
 * MarkSeries - Handles series grouping for connected topology marks (Lines, Areas)
 *
 * Registers an ordinal color scale for the stroke field via the scale registry.
 * When stroke and color reference the same field, the registry deduplicates
 * and they share the same scale (same domain, same indices, same legend).
 */
export class MarkSeries {
	#seriesProp: () => string | object | null;
	#tableProp: () => string | null;
	#setupState: () => any;
	#scaleRegistry: any;
	#chartContext: any;

	scaleState: ColorScaleState | null = $state(null);

	constructor(
		getSeries: () => string | object | null,
		getTable: () => string | null,
		getSetup: () => any,
		scaleRegistry: any,
		chartContext: any
	) {
		this.#seriesProp = getSeries;
		this.#tableProp = getTable;
		this.#setupState = getSetup;
		this.#scaleRegistry = scaleRegistry;
		this.#chartContext = chartContext;

		// Lifecycle: Create/Destroy Scale
		// Series grouping is always ordinal
		$effect(() => {
			const field = this.#field;
			if (field && this.#scaleRegistry) {
				untrack(() => {
					// Use raw field name - registry deduplicates automatically
					// when stroke and color share the same field
					const scaleName = isNode(field) ? field.toString() : field;

					this.scaleState = this.#scaleRegistry.getOrCreateScale(
						scaleName,
						'color',
						{ type: 'ordinal' },
						this.#chartContext.chartId
					);

					const table = this.#tableProp();
					if (this.scaleState && table) {
						this.scaleState.registerTable(table);
					}
				});
			} else {
				this.scaleState = null;
			}
		});

		// Lifecycle: Connect to Setup (Domain Discovery)
		$effect(() => {
			const setup = this.#setupState();
			if (setup && this.scaleState && this.#field) {
				setup.setSeriesScale(this.scaleState);
			}
		});
	}

	// The series field (null if not set)
	#field: string | object | null = $derived.by(() => {
		const s = this.#seriesProp();
		if (s == null) return null;
		if (isNode(s)) return s;
		if (typeof s === 'string') return s;
		return null;
	});

	// Field for BaseMarkSetup select
	selectField: string | object | null = $derived(this.#field);

	// Resolved Data for GPU - Float32Array of series indices
	data: Float32Array | null = $derived.by(() => {
		const field = this.#field;
		const setup = this.#setupState();

		// No series field - return zeros (single series)
		if (!field) {
			if (!setup?.data?.length) return null;
			return new Float32Array(setup.data.length);
		}

		// Wait for scale and data
		if (!this.scaleState?.ready) return null;
		if (!setup?.data) return null;

		const raw = resolveChannel({
			value: field,
			channel: 'stroke',
			dataAccessor: setup.data,
			instanceCount: setup.data.length
		});

		if (!raw) {
			return new Float32Array(setup.data.length);
		}

		return this.scaleState.processDataForGPU(raw);
	});

	// Ready when: no field (single series) or scale is ready
	ready: boolean = $derived(!this.#field || (this.scaleState?.ready ?? false));
}
