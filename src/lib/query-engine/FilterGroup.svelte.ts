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

	// Augmenters produce schema metadata for UI display (filter pills)
	#augmenters = new Map<string, (value: unknown) => FilterSchema | null>();
	// Scale state accessors for active-value projection
	#scaleStateFns = new Map<string, () => ActiveValueScale[]>();
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
		const { sourceId, excludeMarkIds, augment, scaleStates } = opts;

		if (augment) this.#augmenters.set(sourceId, augment);
		if (scaleStates) this.#scaleStateFns.set(sourceId, scaleStates);

		return {
			update: (predicate: FilterExpr, value: unknown) => {
				this.selection.update(sourceId, {
					predicate,
					excludeMarkIds: excludeMarkIds(),
					value
				});
				this.#projectToScales();
			},
			clear: () => {
				this.selection.update(sourceId, null);
				this.#projectToScales();
			},
			destroy: () => {
				this.selection.update(sourceId, null);
				this.#augmenters.delete(sourceId);
				this.#scaleStateFns.delete(sourceId);
				this.#projectToScales();
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
		this.#projectToScales();
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
		this.#projectToScales();
	}

	removeManual(key: string): void {
		this.selection.update(`manual:${key}`, null);
		this.#projectToScales();
	}

	// -----------------------------------------------------------------
	// Clear
	// -----------------------------------------------------------------

	clearSource(sourceId: string): void {
		this.selection.update(sourceId, null);
		this.#projectToScales();
	}

	clearAll(): void {
		this.selection.clear();
		for (const toggle of this.#toggles.values()) {
			toggle.clear();
		}
		this.#clearAllScaleProjections();
	}

	// -----------------------------------------------------------------
	// Scale projection
	// -----------------------------------------------------------------

	/**
	 * Project active filter values onto scales (dim unselected categories).
	 * Called after every selection change.
	 */
	#projectToScales(): void {
		const activeByScale = new Map<ActiveValueScale, Set<unknown>>();

		for (const [sourceId, scalesFn] of this.#scaleStateFns) {
			if (!this.selection.isActive(sourceId)) continue;

			const clauses = this.selection.items;
			const clause = clauses.find((c) => c.sourceId === sourceId);
			if (!clause) continue;

			const tuples = clause.value as unknown[][] | undefined;
			if (!tuples?.length) continue;

			for (const scale of scalesFn()) {
				if (!activeByScale.has(scale)) {
					activeByScale.set(scale, new Set());
				}
				const set = activeByScale.get(scale)!;
				for (const t of tuples) set.add(t[0]);
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
