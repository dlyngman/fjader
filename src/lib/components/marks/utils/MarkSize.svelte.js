import { untrack } from 'svelte';
import { resolveChannel } from './channel-resolution.js';

export class MarkSize {
	#sizeProp;
	#rangeProp;
	#tableProp;
	#setupState;
	#scaleRegistry;
	#chartContext;

	// Managed State
	scaleState = $state(null);

	constructor(getSize, getRange, getTable, getSetup, scaleRegistry, chartContext) {
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

	#mode = $derived.by(() => {
		const s = this.#sizeProp();
		if (s == null) return 'constant';
		if (typeof s === 'number') return 'constant';
		if (typeof s === 'function') return 'constant';
		if (typeof s === 'string') return 'field';
		return 'constant';
	});

	#field = $derived.by(() => {
		const s = this.#sizeProp();
		if (typeof s === 'string') return s;
		return null;
	});

	// Field/expression for BaseMarkSetup select (or null)
	selectField = $derived(this.#mode === 'field' ? this.#field : null);

	// Resolved Data for GPU
	data = $derived.by(() => {
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

	sizeMode = $derived(this.#mode === 'field' ? 1 : 0);

	sizeScaleIndex = $derived(this.scaleState?.gpuIndex ?? 0);

	ready = $derived(this.#mode === 'constant' || (this.scaleState?.ready ?? false));
}
