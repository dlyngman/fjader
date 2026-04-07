/**
 * FilterGroup — visual concerns layer on top of CrossfilterSelection.
 *
 * Manages the interactor API (createBrush, getOrCreateToggle), schema
 * augmentation for UI filter pills, and scale projection (dimming
 * unselected categories in legends/axes).
 *
 * Replaces SelectionGroup from SelectionRegistry. No Mosaic Selection
 * objects, no event listeners, no refcounting.
 */

import { CrossfilterSelection } from './CrossfilterSelection.svelte';
import type { FilterExpr, FilterSchema, Clause, ClauseEntry } from './CrossfilterSelection.svelte';
import type { QueryEngine } from './QueryEngine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Narrow protocol for scale states that support active-value projection.
 * Implemented by ColorScaleState and BandScaleState.
 */
export interface ActiveValueScale {
	setActiveValues(values: Set<unknown>): void;
	clearActiveValues(): void;
}

export interface FilterItem {
	sourceId: string;
	predicate: FilterExpr;
	value: unknown;
	schema?: FilterSchema;
}

export interface BrushOpts {
	sourceId: string;
	/** Getter for mark IDs to exclude from this filter (chart-level cross-filtering).
	 *  A getter rather than a static Set so it stays current if marks are added/removed. */
	excludeMarkIds: () => Set<string>;
	augment?: (value: unknown) => FilterSchema | null;
	scaleStates?: () => ActiveValueScale[];
	/** Extract values to project onto scales from the clause value.
	 *  Required when scaleStates is provided — FilterGroup does not assume value shape. */
	extractProjectionValues?: (value: unknown) => Set<unknown> | null;
}

export interface BrushHandle {
	update(predicate: FilterExpr, value: unknown): void;
	clear(): void;
	destroy(): void;
}

export interface ToggleOpts {
	excludeMarkIds: Set<string>;
	scaleStates?: () => ActiveValueScale[];
}

// ---------------------------------------------------------------------------
// ToggleState
// ---------------------------------------------------------------------------

/**
 * Shared reactive toggle state for a categorical field.
 * Multiple consumers (legend, axis click) share the same instance via
 * FilterGroup.getOrCreateToggle(). No refcounting — Svelte handles sharing.
 */
export class ToggleState {
	field: string;
	values: Set<unknown> = $state(new Set());

	constructor(field: string) {
		this.field = field;
	}

	toggle(value: unknown, multi: boolean): void {
		if (multi) {
			const next = new Set(this.values);
			if (next.has(value)) {
				next.delete(value);
			} else {
				next.add(value);
			}
			this.values = next;
		} else {
			// Single-select: if already the only selected, clear; otherwise select only this
			if (this.values.size === 1 && this.values.has(value)) {
				this.values = new Set();
			} else {
				this.values = new Set([value]);
			}
		}
	}

	select(value: unknown): void {
		this.values = new Set([value]);
	}

	clear(): void {
		this.values = new Set();
	}

	get active(): boolean {
		return this.values.size > 0;
	}
}

// ---------------------------------------------------------------------------
// FilterGroup
// ---------------------------------------------------------------------------

export class FilterGroup {
	readonly selection = new CrossfilterSelection();
	#engine: QueryEngine | null = null;

	setEngine(engine: QueryEngine): void {
		this.#engine = engine;
	}

	// Augmenters produce schema metadata for UI display (filter pills)
	#augmenters = new Map<string, (value: unknown) => FilterSchema | null>();
	// Scale state accessors for active-value projection
	#scaleStateFns = new Map<string, () => ActiveValueScale[]>();
	// Value extractors for scale projection — caller owns the shape
	#valueExtractors = new Map<string, (value: unknown) => Set<unknown> | null>();
	// Toggle instances, shared by field name
	#toggles = new Map<string, ToggleState>();
	// Track which scales we projected to, so we can clear them
	#projectedScales = new Set<ActiveValueScale>();

	/** Active filter items with schema metadata, for UI consumption. */
	get items(): FilterItem[] {
		const clauses = this.selection.items;
		const result: FilterItem[] = [];
		for (const entry of clauses) {
			const augmenter = this.#augmenters.get(entry.sourceId);
			const schema = augmenter ? augmenter(entry.value) ?? entry.schema : entry.schema;
			result.push({
				sourceId: entry.sourceId,
				predicate: entry.predicate,
				value: entry.value,
				schema
			});
		}
		return result;
	}

	/** Number of active filters. */
	get activeCount(): number {
		return this.selection.activeCount;
	}

	// -----------------------------------------------------------------
	// Brush API (for interval interactors)
	// -----------------------------------------------------------------

	createBrush(opts: BrushOpts): BrushHandle {
		const { sourceId, excludeMarkIds, augment, scaleStates, extractProjectionValues } = opts;

		if (augment) this.#augmenters.set(sourceId, augment);
		if (scaleStates) this.#scaleStateFns.set(sourceId, scaleStates);
		if (extractProjectionValues) this.#valueExtractors.set(sourceId, extractProjectionValues);

		return {
			update: (predicate: FilterExpr, value: unknown) => {
				this.selection.update(sourceId, {
					predicate,
					excludeMarkIds: excludeMarkIds(),
					value
				});
				this.#afterUpdate();
			},
			clear: () => {
				this.selection.update(sourceId, null);
				this.#afterUpdate();
			},
			destroy: () => {
				this.selection.update(sourceId, null);
				this.#augmenters.delete(sourceId);
				this.#scaleStateFns.delete(sourceId);
				this.#valueExtractors.delete(sourceId);
				this.#afterUpdate();
			}
		};
	}

	// -----------------------------------------------------------------
	// Toggle API (for legend/axis categorical selection)
	// -----------------------------------------------------------------

	getOrCreateToggle(field: string): ToggleState {
		let toggle = this.#toggles.get(field);
		if (!toggle) {
			toggle = new ToggleState(field);
			this.#toggles.set(field, toggle);
		}
		return toggle;
	}

	/**
	 * Sync a toggle's current values into the selection as a clause.
	 * Call this from an $effect that watches toggle.values.
	 */
	syncToggle(
		field: string,
		predicate: FilterExpr | null,
		value: unknown,
		excludeMarkIds: () => Set<string>
	): void {
		const sourceId = `toggle-${field}`;
		if (predicate) {
			this.selection.update(sourceId, {
				predicate,
				excludeMarkIds: excludeMarkIds(),
				value,
				schema: { kind: 'toggle', column: field, label: field }
			});
		} else {
			this.selection.update(sourceId, null);
		}
		this.#afterUpdate();
	}

	// -----------------------------------------------------------------
	// Manual entries (for DerivedInterval1D relay, programmatic filters)
	// -----------------------------------------------------------------

	upsertManual(
		key: string,
		predicate: FilterExpr,
		value: unknown,
		excludeMarkIds: Set<string> | (() => Set<string>),
		schema?: FilterSchema
	): void {
		const resolved = typeof excludeMarkIds === 'function' ? excludeMarkIds() : excludeMarkIds;
		this.selection.update(`manual:${key}`, {
			predicate,
			excludeMarkIds: resolved,
			value,
			schema
		});
		this.#afterUpdate();
	}

	removeManual(key: string): void {
		this.selection.update(`manual:${key}`, null);
		this.#afterUpdate();
	}

	// -----------------------------------------------------------------
	// Clear
	// -----------------------------------------------------------------

	clearSource(sourceId: string): void {
		this.selection.update(sourceId, null);
		this.#afterUpdate();
	}

	clearAll(): void {
		this.selection.clear();
		for (const toggle of this.#toggles.values()) {
			toggle.clear();
		}
		this.#clearAllScaleProjections();
		this.#engine?.onFilterChange(this);
	}

	// -----------------------------------------------------------------
	// Scale projection
	// -----------------------------------------------------------------

	/**
	 * After any filter update: project to scales (visual dimming) and notify
	 * the engine to re-query affected marks.
	 */
	#afterUpdate(): void {
		this.#projectToScales();
		this.#engine?.onFilterChange(this);
	}

	/**
	 * Project active filter values onto scales (dim unselected categories).
	 */
	#projectToScales(): void {
		const activeByScale = new Map<ActiveValueScale, Set<unknown>>();

		for (const [sourceId, scalesFn] of this.#scaleStateFns) {
			const clause = this.selection.get(sourceId);
			if (!clause) continue;

			const extractor = this.#valueExtractors.get(sourceId);
			if (!extractor) continue;

			const values = extractor(clause.value);
			if (!values?.size) continue;

			for (const scale of scalesFn()) {
				const existing = activeByScale.get(scale);
				if (existing) {
					for (const v of values) existing.add(v);
				} else {
					activeByScale.set(scale, new Set(values));
				}
			}
		}

		// Set active values on scales that have them
		for (const [scale, values] of activeByScale) {
			scale.setActiveValues(values);
		}
		// Clear scales that are no longer active
		for (const scale of this.#projectedScales) {
			if (!activeByScale.has(scale)) {
				scale.clearActiveValues();
			}
		}
		this.#projectedScales = new Set(activeByScale.keys());
	}

	#clearAllScaleProjections(): void {
		for (const scale of this.#projectedScales) {
			scale.clearActiveValues();
		}
		this.#projectedScales.clear();
	}
}
