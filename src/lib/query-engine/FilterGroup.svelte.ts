/**
 * FilterGroup — visual concerns layer on top of CrossfilterSelection.
 *
 * Manages the interactor API (register, getOrCreateToggle), schema
 * augmentation for UI filter pills, and scale projection (dimming
 * unselected categories in legends/axes).
 *
 * Replaces SelectionGroup from SelectionRegistry. No Mosaic Selection
 * objects, no event listeners, no refcounting.
 */

import {
	and as sqlAnd,
	column,
	isIn,
	isNotDistinct,
	literal,
	or,
	sql as sqlTag,
	type ExprNode
} from '@uwdata/mosaic-sql';
import { CrossfilterSelection } from './CrossfilterSelection.svelte';
import type { FilterExpr, FilterSchema } from './CrossfilterSelection.svelte';
import type { ActiveDim, QueryEngine } from './QueryEngine';

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

/** One registration of a selection source: a brush, a legend, a Toggle. */
export interface SourceOpts {
	/** Getter for mark IDs this registration's writes exclude (chart-level cross-filtering).
	 *  A getter rather than a static Set so it stays current if marks are added/removed. */
	excludeMarkIds: () => Set<string>;
	/** How the source selects, read at hover time for preagg activation. */
	activeDims?: () => ActiveDim[];
	/** Schema metadata for UI filter pills, derived from the clause value. */
	augment?: (value: unknown) => FilterSchema | null;
	/** Schema written with every clause, for sources whose metadata does not depend on the value. */
	schema?: FilterSchema;
	scaleStates?: () => ActiveValueScale[];
	/** Extract values to project onto scales from the clause value.
	 *  Required when scaleStates is provided — FilterGroup does not assume value shape. */
	extractProjectionValues?: (value: unknown) => Set<unknown> | null;
}

export interface SourceHandle {
	/** Write the clause, excluding this registration's marks. */
	update(predicate: FilterExpr, value: unknown): void;
	clear(): void;
	/** Prepare preagg tables for this source, ahead of its first use. */
	activate(): void;
	/**
	 * Remove this registration. The last one under an id also removes the clause
	 * (and a toggle's selection with it): a selection lives exactly as long as
	 * some control for it does.
	 */
	destroy(): void;
}

/** A consumer's handle on a shared toggle. Each change writes values and clause together. */
export interface ToggleHandle extends Omit<SourceHandle, 'update'> {
	/**
	 * Toggle one tuple. Single-select replaces the selection, or clears it if the
	 * tuple was the only one selected; multi-select adds or removes it. With
	 * `total`, a multi-select that would select all `total` values clears instead.
	 */
	toggle(tuple: unknown[], multi: boolean, total?: number): void;
	/** Select exactly these tuples; empty clears. */
	set(tuples: unknown[][]): void;
}

// ---------------------------------------------------------------------------
// ToggleState
// ---------------------------------------------------------------------------

/**
 * A key for a tuple that a Set can hold. A single field's value is its own key,
 * so legends can test `values.has(value)`. A tuple joins type-tagged parts, so
 * `1` and `'1'` stay apart and BIGINT values do not throw as JSON would.
 */
function tupleKey(tuple: unknown[]): unknown {
	if (tuple.length === 1) return tuple[0];
	return tuple.map((v) => `${v === null ? 'null' : typeof v}:${String(v)}`).join('\u001f');
}

/** The clause id of a toggle on `fields`. */
function toggleSourceId(fields: string[]): string {
	return fields.length === 1 ? `toggle-${fields[0]}` : `toggle-${JSON.stringify(fields)}`;
}

/**
 * Shared reactive toggle state for a categorical field or field tuple.
 *
 * Owns the source's clause: consumers (a legend, a Toggle's marks or band axis
 * labels) register on it with their own exclusions and scales, and each change
 * through a handle updates the values and writes the clause once, excluding the
 * marks of the consumer that made it. The selection lasts as long as some
 * consumer is registered: when the last one goes, so do the clause and values.
 */
export class ToggleState {
	readonly fields: string[];
	readonly sourceId: string;
	/** Selected tuple keys (see tupleKey). */
	values: Set<unknown> = $state(new Set());

	#group: FilterGroup;
	#tuples = new Map<unknown, unknown[]>();

	constructor(group: FilterGroup, fields: string[]) {
		this.#group = group;
		this.fields = fields;
		this.sourceId = toggleSourceId(fields);
	}

	get active(): boolean {
		return this.values.size > 0;
	}

	register(opts: {
		excludeMarkIds: () => Set<string>;
		scaleStates?: () => ActiveValueScale[];
	}): ToggleHandle {
		const single = this.fields.length === 1;
		const source = this.#group.register(this.sourceId, {
			excludeMarkIds: opts.excludeMarkIds,
			activeDims: () => this.fields.map((field) => ({ kind: 'value' as const, field })),
			schema: { kind: 'toggle', column: this.fields[0], label: this.fields.join(', ') },
			// Projection only makes sense for single-field toggles.
			...(single &&
				opts.scaleStates && {
					scaleStates: opts.scaleStates,
					extractProjectionValues: (value) => new Set((value as unknown[][]).map((t) => t[0]))
				})
		});

		const write = (tuples: unknown[][]) => {
			this.#tuples = new Map(tuples.map((t) => [tupleKey(t), t]));
			this.values = new Set(this.#tuples.keys());
			if (tuples.length === 0) source.clear();
			else source.update(this.#predicate(), tuples);
		};

		return {
			toggle: (tuple, multi, total) => {
				const key = tupleKey(tuple);
				const next = new Map(this.#tuples);
				if (!multi) {
					const onlyThis = next.size === 1 && next.has(key);
					next.clear();
					if (!onlyThis) next.set(key, tuple);
				} else if (next.has(key)) {
					next.delete(key);
				} else {
					next.set(key, tuple);
					if (total != null && next.size >= total) next.clear();
				}
				write([...next.values()]);
			},
			set: (tuples) => write(tuples),
			clear: () => write([]),
			activate: source.activate,
			destroy: source.destroy
		};
	}

	/** Forget the selection without writing a clause (its clause is already gone). */
	reset(): void {
		this.#tuples = new Map();
		this.values = new Set();
	}

	/**
	 * The clause for the current tuples: `IN` for one field, an `OR` of
	 * `IS NOT DISTINCT FROM` tuples for several. Each field is the SQL its
	 * identity records (an expression keeps its own text), or the column of
	 * that name when no mark has registered it.
	 */
	#predicate(): ExprNode {
		const exprs = this.fields.map((field) => {
			const text = this.#group.fieldSql(field);
			return text ? sqlTag([text] as unknown as TemplateStringsArray) : column(field);
		});
		const tuples = [...this.#tuples.values()];
		if (exprs.length === 1) {
			return isIn(
				exprs[0],
				tuples.map((t) => literal(t[0]))
			);
		}
		const clauses = tuples.map((t) => sqlAnd(t.map((v, i) => isNotDistinct(exprs[i], literal(v)))));
		return clauses.length === 1 ? clauses[0] : or(clauses);
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

	/** Registrations per source id. Several under one id are one source. */
	#sources = new Map<string, Set<SourceOpts>>();
	// Toggle instances by clause id, shared by field list
	#toggles = new Map<string, ToggleState>();
	// Track which scales we projected to, so we can clear them
	#projectedScales = new Set<ActiveValueScale>();

	/** Active filter items with schema metadata, for UI consumption. */
	get items(): FilterItem[] {
		const clauses = this.selection.items;
		const result: FilterItem[] = [];
		for (const entry of clauses) {
			let schema = entry.schema;
			for (const opts of this.#sources.get(entry.sourceId) ?? []) {
				if (!opts.augment) continue;
				schema = opts.augment(entry.value) ?? entry.schema;
				break;
			}
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

	/** SQL for a field as its categorical identity records it, or null if none. */
	fieldSql(field: string): string | null {
		return this.#engine?.identitySqlFor(field) ?? null;
	}

	// -----------------------------------------------------------------
	// Sources (brushes, legends, toggles)
	// -----------------------------------------------------------------

	/**
	 * Register a selection source. Several registrations under one id are one
	 * source: each writes the clause with its own exclusions, and the scales the
	 * source dims are the union of theirs.
	 */
	register(sourceId: string, opts: SourceOpts): SourceHandle {
		let registrations = this.#sources.get(sourceId);
		if (!registrations) {
			registrations = new Set();
			this.#sources.set(sourceId, registrations);
		}
		registrations.add(opts);

		return {
			update: (predicate: FilterExpr, value: unknown) => {
				this.selection.update(sourceId, {
					predicate,
					excludeMarkIds: opts.excludeMarkIds(),
					value,
					schema: opts.schema
				});
				this.#afterUpdate();
			},
			clear: () => this.clearSource(sourceId),
			activate: () => this.#activate(sourceId),
			destroy: () => {
				registrations.delete(opts);
				if (registrations.size > 0) return;
				this.#sources.delete(sourceId);
				this.clearSource(sourceId);
			}
		};
	}

	/**
	 * Hand the engine a snapshot of the source. It activates every mark some
	 * registration filters: a table for the source is correct for a mark whether
	 * or not the clause currently excludes it, so only marks that every
	 * registration excludes are left out.
	 */
	#activate(sourceId: string): void {
		const registrations = this.#sources.get(sourceId);
		if (!this.#engine || !registrations?.size) return;

		let excludedByAll: Set<string> | null = null;
		let dims: ActiveDim[] = [];
		for (const opts of registrations) {
			const excluded = opts.excludeMarkIds();
			excludedByAll = excludedByAll
				? new Set([...excludedByAll].filter((id) => excluded.has(id)))
				: excluded;
			if (opts.activeDims && dims.length === 0) dims = opts.activeDims();
		}
		this.#engine.activate(this, { sourceId, excludedByAll: excludedByAll!, dims });
	}

	// -----------------------------------------------------------------
	// Toggle API (for legend/axis categorical selection)
	// -----------------------------------------------------------------

	/** The shared toggle for a field or field tuple, keyed by the full field list. */
	getOrCreateToggle(fields: string | string[]): ToggleState {
		const list = Array.isArray(fields) ? fields : [fields];
		const sourceId = toggleSourceId(list);
		let toggle = this.#toggles.get(sourceId);
		if (!toggle) {
			toggle = new ToggleState(this, list);
			this.#toggles.set(sourceId, toggle);
		}
		return toggle;
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

	/** Remove a source's clause. A toggle's selection goes with it, so its controls agree. */
	clearSource(sourceId: string): void {
		this.selection.update(sourceId, null);
		this.#toggles.get(sourceId)?.reset();
		this.#afterUpdate();
	}

	clearAll(): void {
		this.selection.clear();
		for (const toggle of this.#toggles.values()) {
			toggle.reset();
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

		for (const [sourceId, registrations] of this.#sources) {
			const clause = this.selection.get(sourceId);
			if (!clause) continue;

			for (const opts of registrations) {
				if (!opts.scaleStates || !opts.extractProjectionValues) continue;

				const values = opts.extractProjectionValues(clause.value);
				if (!values?.size) continue;

				for (const scale of opts.scaleStates()) {
					const existing = activeByScale.get(scale);
					if (existing) {
						for (const v of values) existing.add(v);
					} else {
						activeByScale.set(scale, new Set(values));
					}
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
