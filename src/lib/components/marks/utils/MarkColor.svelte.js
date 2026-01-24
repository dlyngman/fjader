import { untrack } from 'svelte';
import { isColorConstant, parseColorToRGBA } from '$lib/scales/color-utils.js';
import { resolveChannel } from './channel-resolution.js';
import { isNode, isAggregateExpression } from '@uwdata/mosaic-sql';

export class MarkColor {
	#colorProp;
	#schemeProp;
	#tableProp;
	#setupState;
	#scaleRegistry;
	#chartContext;

	// Managed State
	scaleState = $state(null);
	#readyState = $state(true); // Start optimistically ready

	constructor(getColor, getScheme, getTable, getSetup, scaleRegistry, chartContext) {
		this.#colorProp = getColor;
		this.#schemeProp = getScheme;
		this.#tableProp = getTable;
		this.#setupState = getSetup;
		this.#scaleRegistry = scaleRegistry;
		this.#chartContext = chartContext;

		// 1. Lifecycle: Create/Destroy Scale (type-based key, NOT scheme)
		$effect(() => {
			// Track mode, field, and type separately (scheme is NOT part of the key)
			const mode = this.#mode;
			const field = this.#field;
			const type = this.config.scaleType;

			if (mode === 'field' && field && this.#scaleRegistry) {
				untrack(() => {
					// For aggregate nodes, use the SQL string as the scale key
					// This ensures each unique aggregate expression gets its own scale
					const scaleKey = isNode(field) ? field.toString() : field;

					// Pass type and scheme in config
					// Registry will use only 'type' for caching, 'scheme' for initialization/updates
					this.scaleState = this.#scaleRegistry.getOrCreateScale(
						scaleKey,
						'color',
						{
							type: type,
							scheme: this.config.scheme
						},
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

		// 2. Lifecycle: Update Scheme (Fast Path - no scale recreation)
		$effect(() => {
			// Read scheme outside conditional to ensure tracking
			const scheme = this.config.scheme;
			if (this.scaleState && scheme) {
				this.scaleState.setScheme(scheme);
			}
		});

		// 3. Lifecycle: Connect to Setup (Domain Discovery)
		$effect(() => {
			const setup = this.#setupState();
			if (setup && this.scaleState && this.#mode === 'field') {
				setup.setColorScale(this.scaleState);
			}
		});

		// 4. Lifecycle: Update Ready State (stable during scheme updates)
		$effect(() => {
			const isReady = this.#mode === 'constant' || (this.scaleState?.ready ?? false);

			// Only flip to false if we're truly unready (scale doesn't exist or mode changed)
			// Don't flip to false during fast-path scheme updates
			if (isReady) {
				// Always update when becoming ready
				this.#readyState = true;
			} else if (!this.scaleState && this.#mode === 'field') {
				// Scale doesn't exist yet - not ready
				this.#readyState = false;
			}
			// Otherwise keep current ready state (stable during updates)
		});
	}

	// --- Internal Logic ---

	/**
	 * Explicitly resolve the scale type based on the field definition.
	 * Priority:
	 * 1. Aggregates (avg, sum, count, etc.) -> 'sequential'
	 * 2. Bins (bin(), AutoBinNode) -> 'sequential'
	 * 3. Raw fields -> 'ordinal'
	 */
	#resolveScaleType(field) {
		if (isNode(field)) {
			// e.g. avg(delay), count(), sum(sales)
			if (isAggregateExpression(field)) return 'sequential';
			// e.g. bin(age) - technically ordinal bins, but usually treated sequentially in colormaps
			if (field.isAutoBinNode || field.type === 'Bin') return 'sequential';
		}
		// Default fallback for raw columns (strings/categories)
		return 'ordinal';
	}

	// --- Derived State ---

	config = $derived.by(() => {
		const c = this.#colorProp();
		const s = this.#schemeProp();

		// Case 1: Constant / Null
		if (c == null) {
			return { mode: 'constant', value: [0.2, 0.4, 0.8, 1.0], scaleType: null, scheme: null };
		}

		if (typeof c === 'string' && isColorConstant(c)) {
			return { mode: 'constant', value: parseColorToRGBA(c), scaleType: null, scheme: null };
		}

		// Case 2: Field / Expression
		let field = c;
		let explicitScheme = s;

		// Handle object wrapper format { field: "species", scheme: "dark2" }
		if (typeof c === 'object' && c.field && !isNode(c)) {
			field = c.field;
			explicitScheme = c.scheme || s;
		}

		// 1. Determine Type Explicitly from field semantics
		const scaleType = this.#resolveScaleType(field);

		// 2. Pass explicit scheme if provided, otherwise undefined (registry will apply default)
		return {
			mode: 'field',
			field,
			scaleType,
			scheme: explicitScheme // undefined if not specified
		};
	});

	// Separate derived for mode (independent of scheme to avoid unnecessary tracking)
	#mode = $derived.by(() => {
		const c = this.#colorProp();
		if (c == null) return 'constant';
		if (isNode(c)) return 'field'; // Aggregate/expression nodes
		if (typeof c === 'object' && c.field) return 'field';
		if (typeof c === 'string') {
			if (isColorConstant(c)) return 'constant';
			return 'field';
		}
		return 'constant';
	});

	// Separate derived for field (independent of scheme)
	#field = $derived.by(() => {
		const c = this.#colorProp();
		if (c == null) return null;
		if (isNode(c)) return c; // Return the entire node for aggregates
		if (typeof c === 'object' && c.field) return c.field;
		if (typeof c === 'string' && !isColorConstant(c)) return c;
		return null;
	});

	// Field/expression for BaseMarkSetup select (or null)
	// This can be a string (column name) or a SQL expression node (aggregate)
	selectField = $derived(this.#mode === 'field' ? this.#field : null);

	// Resolved Data for GPU
	data = $derived.by(() => {
		if (this.#mode !== 'field') return null;
		if (!this.scaleState?.ready) return null;

		const setup = this.#setupState();
		if (!setup?.data) return null;

		const raw = resolveChannel({
			value: this.#field,
			channel: 'color',
			dataAccessor: setup.data,
			instanceCount: setup.data.length
		});

		if (!raw) return null;
		return this.scaleState.processDataForGPU(raw);
	});

	// Individual derived properties for fine-grained reactivity
	colorMode = $derived(this.#mode === 'field' ? 1 : 0);

	colorScaleIndex = $derived(this.scaleState?.gpuIndex ?? 0);

	constantColor = $derived.by(() => {
		const mode = this.#mode;
		const value = mode === 'constant' ? this.config.value : [0, 0, 0, 1];
		// Return a new array to ensure reference changes
		return [...value];
	});

	// Use state instead of derived to avoid flickering during transitions
	ready = $derived(this.#readyState);
}
