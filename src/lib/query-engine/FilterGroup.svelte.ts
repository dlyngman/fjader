/**
 * FilterGroup — visual concerns layer on top of CrossfilterSelection.
 *
 * Manages the interactor API (register, registerToggle), schema augmentation
 * for UI filter pills, and scale projection (dimming unselected categories in
 * legends/axes).
 *
 * Owns clauses: a clause lives while at least one registration for its id
 * exists. Components own their registrations through their own lifecycle.
 *
 * Replaces SelectionGroup from SelectionRegistry. No Mosaic Selection
 * objects, no event listeners.
 */

import { column, sql as sqlTag, type ExprNode } from '@uwdata/mosaic-sql';
import { CrossfilterSelection } from './CrossfilterSelection.svelte';
import type { Clause, FilterExpr, FilterSchema } from './CrossfilterSelection.svelte';
import type { ActiveDim, QueryEngine } from './QueryEngine';
import { togglePredicate } from './toggle-predicate';

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
	/**
	 * A bin source's current view, `[d0, d1, pixel extent]` per bin dim, written
	 * into `out` without allocating: read on every query to keep a table only
	 * while its bins are as fine as the pixels.
	 */
	view?: (out: Float64Array) => void;
	/** Schema metadata for UI filter pills, derived from the clause value. */
	augment?: (value: unknown) => FilterSchema | null;
	/** The scales to dim, and the values to dim them by, taken from the clause value. */
	projection?: {
		scales: () => ActiveValueScale[];
		values: (value: unknown) => Set<unknown> | null;
	};
}

export interface SourceHandle {
	/** Write the clause, excluding this registration's marks. */
	update(predicate: FilterExpr, value: unknown): void;
	clear(): void;
	/** Prepare preagg tables for this source, ahead of its first use. */
	activate(): void;
	/**
	 * Remove this registration. The last one under an id also removes the clause:
	 * a selection lives exactly as long as some control for it does.
	 */
	destroy(): void;
}

/**
 * A consumer's toggle on a field or field tuple. Its selection is read from
 * the clause, so every toggle on the same fields sees the same selection.
 */
export interface ToggleHandle extends Omit<SourceHandle, 'update'> {
	/** Selected tuple keys (see tupleKey). Read-only: the clause is the state. */
	readonly values: ReadonlySet<unknown>;
	readonly active: boolean;
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
// Toggles
// ---------------------------------------------------------------------------

/** The selection of a toggle with no clause. Shared, so it never looks changed. */
const NOTHING_SELECTED: ReadonlySet<unknown> = new Set();

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
	// Track which scales we projected to, so we can clear them
	#projectedScales = new Set<ActiveValueScale>();
	/**
	 * Sources some registration projects onto scales (toggles, legends). Only a
	 * change to one of these can change what is dimmed, so a brush, which
	 * writes on every pointer move, never rebuilds the projection.
	 */
	#projectingSources = new Set<string>();

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
		if (opts.projection) this.#projectingSources.add(sourceId);

		return {
			update: (predicate: FilterExpr, value: unknown) => {
				const next: Clause = { predicate, excludeMarkIds: opts.excludeMarkIds(), value };
				this.#afterUpdate(sourceId, this.selection.update(sourceId, next), next);
			},
			clear: () => this.clearSource(sourceId),
			activate: () => this.#activate(sourceId),
			destroy: () => {
				// Once only: a second call must not remove a newer registration
				// under the same id, or clear its clause.
				if (!registrations.has(opts)) return;
				if (registrations.size === 1) {
					// The last one: drop the source's preagg tables first, so the
					// re-query below cannot start reading one about to go. Then clear
					// while the registration is still in place, so whatever reads the
					// source's registrations to route the removal still finds them,
					// and its scales are un-dimmed.
					this.#engine?.forgetSource(this, sourceId);
					this.clearSource(sourceId);
				}
				registrations.delete(opts);
				if (registrations.size > 0) return;
				this.#sources.delete(sourceId);
				this.#projectingSources.delete(sourceId);
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
		let view: SourceOpts['view'];
		for (const opts of registrations) {
			const excluded = opts.excludeMarkIds();
			excludedByAll = excludedByAll
				? new Set([...excludedByAll].filter((id) => excluded.has(id)))
				: excluded;
			if (opts.activeDims && dims.length === 0) dims = opts.activeDims();
			view ??= opts.view;
		}
		this.#engine.activate(this, { sourceId, excludedByAll: excludedByAll!, dims, view });
	}

	// -----------------------------------------------------------------
	// Toggles (legend/axis categorical selection)
	// -----------------------------------------------------------------

	/**
	 * Register a consumer's toggle on a field or field tuple. Toggles on the same
	 * fields share one clause and so one selection; each writes the clause with
	 * its own exclusions. The caller owns the registration and destroys it.
	 *
	 * Every `toggle-…` clause holds tuples: that is what lets the clause be read
	 * as the selection. Nothing else writes those ids (`upsertManual` prefixes
	 * its own with `manual:`).
	 */
	registerToggle(
		fields: string | string[],
		opts: { excludeMarkIds: () => Set<string>; scales?: () => ActiveValueScale[] }
	): ToggleHandle {
		const list = Array.isArray(fields) ? fields : [fields];
		const sourceId = toggleSourceId(list);
		const { selection } = this;
		const schema: FilterSchema = { kind: 'toggle', column: list[0], label: list.join(', ') };
		const source = this.register(sourceId, {
			excludeMarkIds: opts.excludeMarkIds,
			activeDims: () => list.map((field) => ({ kind: 'value' as const, field })),
			augment: () => schema,
			// Projection only makes sense for single-field toggles.
			projection:
				list.length === 1 && opts.scales
					? {
							scales: opts.scales,
							values: (value) => new Set((value as unknown[][]).map((t) => t[0]))
						}
					: undefined
		});

		const tuplesOf = (clause: Clause | undefined): unknown[][] =>
			(clause?.value as unknown[][] | undefined) ?? [];

		/**
		 * The selection, read from the clause. A brush frame bumps the selection
		 * map's version, so a toggle with nothing selected is re-read on every one;
		 * returning the same set while the clause is unchanged (and one shared
		 * empty set without a clause) keeps that from re-rendering its readers.
		 */
		let last: { clause: Clause; keys: Set<unknown> } | null = null;
		const keysOf = (clause: Clause | undefined): ReadonlySet<unknown> => {
			if (!clause) return NOTHING_SELECTED;
			if (last?.clause !== clause) {
				last = { clause, keys: new Set(tuplesOf(clause).map(tupleKey)) };
			}
			return last.keys;
		};

		const write = (tuples: unknown[][]) => {
			if (tuples.length === 0) source.clear();
			else source.update(this.#togglePredicate(list, tuples), tuples);
		};

		return {
			get values() {
				return keysOf(selection.get(sourceId));
			},
			get active() {
				return selection.isActive(sourceId);
			},
			toggle: (tuple, multi, total) => {
				const key = tupleKey(tuple);
				const next = new Map(tuplesOf(selection.get(sourceId)).map((t) => [tupleKey(t), t]));
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

	/**
	 * The clause for a toggle's tuples, with each field as the SQL its identity
	 * records (an expression keeps its own text), or the column of that name
	 * when no mark has registered it.
	 */
	#togglePredicate(fields: string[], tuples: unknown[][]): ExprNode {
		const exprs = fields.map((field) => {
			const text = this.fieldSql(field);
			return text ? sqlTag([text] as unknown as TemplateStringsArray) : column(field);
		});
		return togglePredicate(exprs, tuples);
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
		const next: Clause = { predicate, excludeMarkIds: resolved, value, schema };
		const sourceId = `manual:${key}`;
		this.#afterUpdate(sourceId, this.selection.update(sourceId, next), next);
	}

	removeManual(key: string): void {
		const sourceId = `manual:${key}`;
		this.#afterUpdate(sourceId, this.selection.update(sourceId, null), null);
	}

	// -----------------------------------------------------------------
	// Clear
	// -----------------------------------------------------------------

	/**
	 * Remove a source's clause. Re-queries only when there was a clause to
	 * remove: an unmount or a clear with nothing selected changes no mark's data.
	 */
	clearSource(sourceId: string): void {
		if (!this.selection.isActive(sourceId)) return;
		this.#afterUpdate(sourceId, this.selection.update(sourceId, null), null);
	}

	clearAll(): void {
		this.selection.clear();
		this.#clearAllScaleProjections();
		this.#engine?.onFilterChange(this);
	}

	// -----------------------------------------------------------------
	// Scale projection
	// -----------------------------------------------------------------

	/**
	 * After `sourceId`'s clause went from `prev` to `next`: re-project to scales
	 * (visual dimming) if that source dims anything, and have the engine
	 * re-query the marks either clause applies to. A brush move skips the
	 * projection, which would rebuild the same answer and allocate doing it on
	 * every pointer move.
	 */
	#afterUpdate(sourceId: string, prev: Clause | undefined, next: Clause | null): void {
		if (this.#projectingSources.has(sourceId)) this.#projectToScales();
		if (prev || next) this.#engine?.onClauseChange(this, prev, next);
	}

	/**
	 * Project active filter values onto scales (dim unselected categories).
	 */
	#projectToScales(): void {
		const activeByScale = new Map<ActiveValueScale, Set<unknown>>();

		for (const [sourceId, registrations] of this.#sources) {
			const clause = this.selection.get(sourceId);
			if (!clause) continue;

			for (const { projection } of registrations) {
				if (!projection) continue;

				const values = projection.values(clause.value);
				if (!values?.size) continue;

				for (const scale of projection.scales()) {
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
