import { untrack } from 'svelte';
import { isColorConstant, parseColorToRGBA } from '$lib/scales/color-utils';
import { resolveChannel } from './channel-resolution';
import { isNode, isAggregateExpression } from '@uwdata/mosaic-sql';
import { tableSchemaService } from '$lib/data/TableSchemaService.svelte';
import { inferScaleType } from '$lib/scales/scale-inference';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
import type { ColorProp, ChartContext } from '$lib/types';
import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';

interface ColorConfig {
	mode: 'constant' | 'field';
	value?: number[];
	field?: string | object;
	scaleType: string | null;
	scheme: string | null | undefined;
}

export class MarkColor {
	#colorProp: () => ColorProp;
	#schemeProp: () => string | null | undefined;
	#tableProp: () => string | null;
	#setupState: () => any;
	#scaleRegistry: ScaleRegistry;
	#chartContext: ChartContext;

	// Managed State
	scaleState: ColorScaleState | null = $state(null);
	#readyState: boolean = $state(true); // Start optimistically ready

	constructor(
		getColor: () => ColorProp,
		getScheme: () => string | null | undefined,
		getTable: () => string | null,
		getSetup: () => any,
		scaleRegistry: ScaleRegistry,
		chartContext: ChartContext
	) {
		this.#colorProp = getColor;
		this.#schemeProp = getScheme;
		this.#tableProp = getTable;
		this.#setupState = getSetup;
		this.#scaleRegistry = scaleRegistry;
		this.#chartContext = chartContext;

		// 1. Lifecycle: Create/Destroy Scale (type-based key, NOT scheme)
		// Blocks scale creation until type is determined (schema ready)
		$effect(() => {
			// Track mode, field, and type separately (scheme is NOT part of the key)
			const mode = this.#mode;
			const field = this.#field;
			const type = this.config.scaleType;
			// Only create scale when type is known (not null)
			if (mode === 'field' && field && this.#scaleRegistry && type !== null) {
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
			} else if (type === null && mode === 'field') {
				// Schema not ready yet - trigger fetch but don't create scale
				const table = this.#tableProp();
				if (table) {
					tableSchemaService.getSchema(table); // Trigger fetch
				}
				this.scaleState = null;
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
	 * Resolve the color scale type based on the field definition.
	 * Delegates to the shared inferScaleType() for schema-based inference.
	 *
	 * For SQL nodes that aren't aggregates/bins, falls back to 'ordinal' (safe for color).
	 * Returns null if schema info is needed but not yet available (blocking).
	 */
	#resolveScaleType(field: string | object): string | null {
		// SQL expression nodes: aggregates and bins are always sequential
		if (isNode(field)) {
			if (isAggregateExpression(field)) return 'sequential';
			if ('isAutoBinNode' in field || ('type' in field && field.type === 'Bin')) return 'sequential';
			// Other SQL expression nodes (e.g., SIGN(...), arithmetic) produce computed values.
			// Default to sequential since most expressions return continuous numeric results.
			// TODO: ordinal + expression node breaks ViewManager (uses expression string as
			// column name for __dplot_*_idx). If we ever need ordinal for expressions, fix
			// ViewManager.colorIndexColumn / bandIndexColumn to sanitize expression fields.
			return 'sequential';
		}

		// Raw column names: use shared inference with 'visual' context
		if (typeof field === 'string') {
			const table = this.#tableProp();
			if (table) {
				const colType = tableSchemaService.getColumnType(table, field);
				if (!colType) return null; // Schema not ready — block
				return inferScaleType({ field, schemaType: colType, context: 'visual' });
			}
		}

		// Default fallback (no table context or unknown field type)
		return 'ordinal';
	}

	// --- Derived State ---

	config: ColorConfig = $derived.by(() => {
		const c = this.#colorProp();
		const s = this.#schemeProp();

		// Track schema service version to trigger recomputation when schema arrives
		const _schemaVersion = tableSchemaService.version;

		// Case 1: Constant / Null
		if (c == null) {
			return { mode: 'constant', value: [0.2, 0.4, 0.8, 1.0], scaleType: null, scheme: null };
		}

		if (typeof c === 'string' && isColorConstant(c)) {
			return { mode: 'constant', value: parseColorToRGBA(c), scaleType: null, scheme: null };
		}

		// Case 2: Field / Expression
		let field: string | object = c as string | object;
		let explicitScheme = s;

		// Handle object wrapper format { field: "species", scheme: "dark2" }
		if (typeof c === 'object' && 'field' in c && !isNode(c)) {
			field = (c as { field: string; scheme?: string }).field;
			explicitScheme = (c as { field: string; scheme?: string }).scheme || s;
		}

		// 1. Determine Type from field semantics + schema (may return null if waiting for schema)
		const scaleType = this.#resolveScaleType(field);

		// 2. Pass explicit scheme if provided, otherwise undefined (registry will apply default)
		return {
			mode: 'field',
			field,
			scaleType, // Can be null if waiting for schema
			scheme: explicitScheme // undefined if not specified
		};
	});

	// Separate derived for mode (independent of scheme to avoid unnecessary tracking)
	#mode: 'constant' | 'field' = $derived.by(() => {
		const c = this.#colorProp();
		if (c == null) return 'constant';
		if (isNode(c)) return 'field'; // Aggregate/expression nodes
		if (typeof c === 'object' && 'field' in c) return 'field';
		if (typeof c === 'string') {
			if (isColorConstant(c)) return 'constant';
			return 'field';
		}
		return 'constant';
	});

	// Separate derived for field (independent of scheme)
	#field: string | object | null = $derived.by(() => {
		const c = this.#colorProp();
		if (c == null) return null;
		if (isNode(c)) return c; // Return the entire node for aggregates
		if (typeof c === 'object' && 'field' in c) return (c as { field: string }).field;
		if (typeof c === 'string' && !isColorConstant(c)) return c;
		return null;
	});

	// Field/expression for BaseMarkSetup select (or null)
	// This can be a string (column name) or a SQL expression node (aggregate)
	selectField: string | object | null = $derived(this.#mode === 'field' ? this.#field : null);

	// Resolved Data for GPU
	data: Float32Array | null = $derived.by(() => {
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
	colorMode: number = $derived(this.#mode === 'field' ? 1 : 0);

	colorScaleIndex: number = $derived(this.scaleState?.gpuIndex ?? 0);

	constantColor: number[] = $derived.by(() => {
		const mode = this.#mode;
		const value = mode === 'constant' ? this.config.value! : [0, 0, 0, 1];
		// Return a new array to ensure reference changes
		return [...value];
	});

	// Use state instead of derived to avoid flickering during transitions
	ready: boolean = $derived(this.#readyState);
}
