import { untrack } from 'svelte';
import { resolveChannel } from './channel-resolution';
import type { SizeScaleState } from '$lib/scales/SizeScaleState.svelte';

export class MarkSize {
	#sizeProp: () => number | string | ((point: { x: number; y: number }) => number) | null;
	#rangeProp: () => [number, number];
	#tableProp: () => string | null;
	#setupState: () => any;
	#scaleRegistry: any;
	#chartContext: any;

	// Managed State
	scaleState: SizeScaleState | null = $state(null);

	constructor(
		getSize: () => number | string | ((point: { x: number; y: number }) => number) | null,
		getRange: () => [number, number],
		getTable: () => string | null,
		getSetup: () => any,
		scaleRegistry: any,
		chartContext: any
	) {
		this.#sizeProp = getSize;
		this.#rangeProp = getRange;
		this.#tableProp = getTable;
		this.#setupState = getSetup;
		this.#scaleRegistry = scaleRegistry;
		this.#chartContext = chartContext;

		// 1. Lifecycle: Create/Destroy Scale
		$effect(() => {
			const mode = this.#mode;
			const field = this.#field;

			if (mode === 'field' && field && this.#scaleRegistry) {
				untrack(() => {
					this.scaleState = this.#scaleRegistry.getOrCreateScale(
						field,
						'size',
						{ range: this.#rangeProp() },
						this.#chartContext.chartId
					);
				});
			} else {
				this.scaleState = null;
			}
		});

		// 2. Lifecycle: Update Range
		$effect(() => {
			const range = this.#rangeProp();
			if (this.scaleState && range) {
				this.scaleState.setRange(range);
			}
		});

		// 3. Lifecycle: Connect to Setup (Domain Discovery)
		$effect(() => {
			const setup = this.#setupState();
			if (setup && this.scaleState && this.#mode === 'field') {
				setup.setSizeScale(this.scaleState);
			}
		});
	}

	// --- Internal Logic ---

	#mode: 'constant' | 'field' = $derived.by(() => {
		const s = this.#sizeProp();
		if (s == null) return 'constant';
		if (typeof s === 'number') return 'constant';
		if (typeof s === 'function') return 'constant';
		if (typeof s === 'string') return 'field';
		return 'constant';
	});

	#field: string | null = $derived.by(() => {
		const s = this.#sizeProp();
		if (typeof s === 'string') return s;
		return null;
	});

	// Field/expression for BaseMarkSetup select (or null)
	selectField: string | null = $derived(this.#mode === 'field' ? this.#field : null);

	// Resolved Data for GPU
	data: Float32Array | null = $derived.by(() => {
		if (this.#mode !== 'field') return null;
		if (!this.scaleState?.ready) return null;

		const setup = this.#setupState();
		if (!setup?.data) return null;

		const raw = resolveChannel({
			value: this.#field,
			channel: 'radius',
			dataAccessor: setup.data,
			instanceCount: setup.data.length
		});

		if (!raw) return null;
		return this.scaleState.processDataForGPU(raw);
	});

	sizeMode: number = $derived(this.#mode === 'field' ? 1 : 0);

	sizeScaleIndex: number = $derived(this.scaleState?.gpuIndex ?? 0);

	ready: boolean = $derived(this.#mode === 'constant' || (this.scaleState?.ready ?? false));
}
