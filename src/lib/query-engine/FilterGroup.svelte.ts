/**
 * FilterGroup — visual concerns layer on top of CrossfilterSelection.
 *
 * Manages the interactor API (register, registerToggle), schema augmentation
 * for UI filter pills, and this group's selection on each categorical field
 * (FieldActivity), which marks, legends and band axes dim by.
 *
 * Owns clauses: a clause lives while at least one registration for its id
 * exists. Components own their registrations through their own lifecycle.
 *
 * Replaces SelectionGroup from SelectionRegistry. No Mosaic Selection
 * objects, no event listeners.
 */

import { column, sql as sqlTag, type ExprNode } from '@uwdata/mosaic-sql';
import { CrossfilterSelection } from './CrossfilterSelection.svelte';
import type {
	CategoricalSelection,
	Clause,
	FilterExpr,
	FilterSchema,
	SourceRegistration
} from './CrossfilterSelection.svelte';
import type { ActiveDim, QueryEngine } from './QueryEngine';
import { togglePredicate } from './toggle-predicate';
import { identityKeyFor } from './identity-key';
import { FieldActivity } from './FieldActivity.svelte';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilterItem {
	sourceId: string;
	predicate: FilterExpr;
	value: unknown;
	schema?: FilterSchema;
}

/** One registration of a selection source: a brush, a legend, a Toggle. */
export interface SourceOpts extends SourceRegistration {
	/**
	 * The chart this registration skips: its ChartConfig, or nothing. A chart
	 * holding a control for a selection is not filtered by it (crossfilter), so
	 * its marks that do not read the field keep their data; those that do, dim.
	 * Opt-in: a control that wants its own chart filtered passes none.
	 */
	chart?: object | null;
	/**
	 * For a source that selects categories of one field: that field's identity
	 * key, and how to read the selected values from a write. Every clause the
	 * source writes carries both (`Clause.categorical`).
	 */
	categorical?: { key: string; values: (value: unknown) => ReadonlySet<unknown> };
	/** How the source selects, read at hover time for preagg activation. */
	activeDims?: () => ActiveDim[];
	/**
	 * A bin source's current view, `[d0, d1, pixel extent]` per bin dim, written
	 * into `out` without allocating: read on every query to keep a table only
	 * while its bins are as fine as the pixels.
	 */
	view?: (out: Float64Array) => void;
	/**
	 * Schema metadata for UI filter pills, derived from the clause value. Run
	 * once per write and stored on the clause.
	 */
	augment?: (value: unknown) => FilterSchema | null;
}

export interface SourceHandle {
	/** Write the source's clause. */
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

/**
 * A source's declaration of `key`: the writer's, or another registration's
 * when the writer has none. Every registration under one id is one source, so
 * any of them can say what its clause is.
 */
function declared<K extends 'augment' | 'categorical'>(
	registrations: ReadonlySet<SourceOpts> | undefined,
	writer: SourceOpts,
	key: K
): SourceOpts[K] {
	if (writer[key]) return writer[key];
	for (const opts of registrations ?? []) if (opts[key]) return opts[key];
	return undefined;
}

/**
 * A clause's schema, computed once when it is written rather than on every
 * read of `items`, and stored on the clause, so a reader of raw clauses (the
 * relay looking for a range brush) sees it too.
 */
function schemaOf(
	registrations: ReadonlySet<SourceOpts> | undefined,
	writer: SourceOpts,
	value: unknown
): FilterSchema | undefined {
	return declared(registrations, writer, 'augment')?.(value) ?? undefined;
}

/** A clause's categorical selection: the field's identity key and the selected values. */
function categoricalOf(
	registrations: ReadonlySet<SourceOpts> | undefined,
	writer: SourceOpts,
	value: unknown
): CategoricalSelection | null {
	const categorical = declared(registrations, writer, 'categorical');
	return categorical ? { key: categorical.key, values: categorical.values(value) } : null;
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

	/**
	 * This group's page-wide index, assigned by FilterGroupRegistry and never
	 * reused: a mark stores it to read this group's half of an activity block.
	 */
	readonly index: number;

	/** The selection state of a field, shared with the other groups on the page. */
	#activityOf: (key: string) => FieldActivity;

	/** Fields this group has an active categorical selection on, for clearAll. */
	#selectedFields = new Set<string>();

	/**
	 * A group made outside a registry (unit tests) keeps its field activity to
	 * itself, with no loop: its fades land at once.
	 */
	constructor(index: number = 0, activityOf?: (key: string) => FieldActivity) {
		this.index = index;
		if (activityOf) {
			this.#activityOf = activityOf;
		} else {
			const own = new Map<string, FieldActivity>();
			this.#activityOf = (key) => {
				let activity = own.get(key);
				if (!activity) own.set(key, (activity = new FieldActivity(key)));
				return activity;
			};
		}
	}

	/** The selection state of a categorical field, by identity key: this group's fade is `index`. */
	activity(key: string): FieldActivity {
		return this.#activityOf(key);
	}

	setEngine(engine: QueryEngine): void {
		this.#engine = engine;
	}

	/**
	 * Active filter items with schema metadata, for UI consumption. The schema
	 * is the clause's own, computed when it was written (see `update`).
	 */
	get items(): FilterItem[] {
		return this.selection.items;
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
	 * source and write one clause.
	 */
	register(sourceId: string, opts: SourceOpts): SourceHandle {
		const { selection } = this;
		selection.addRegistration(sourceId, opts);
		// A chart that starts skipping a selection already in force has marks
		// whose filters just changed.
		if (opts.chart && selection.isActive(sourceId)) {
			this.#engine?.onChartRouteChange(this, opts.chart);
		}
		const registrations = () => selection.registrationsOf(sourceId) as ReadonlySet<SourceOpts>;
		let registered = true;

		return {
			update: (predicate: FilterExpr, value: unknown) => {
				const next: Clause = {
					predicate,
					value,
					schema: schemaOf(registrations(), opts, value),
					categorical: categoricalOf(registrations(), opts, value)
				};
				this.#afterUpdate(sourceId, selection.update(sourceId, next), next);
			},
			clear: () => this.clearSource(sourceId),
			activate: () => this.#activate(sourceId),
			destroy: () => {
				// Once only: a second call must not remove a newer registration
				// under the same id, or clear its clause.
				if (!registered) return;
				registered = false;
				if (registrations()?.size === 1) {
					// The last one: drop the source's preagg tables first, so the
					// re-query below cannot start reading one about to go. Then clear
					// while the registration is still in place, so the removal is
					// routed by it: the marks re-queried are those the clause filtered.
					this.#engine?.forgetSource(this, sourceId);
					this.clearSource(sourceId);
					selection.removeRegistration(sourceId, opts);
					return;
				}
				selection.removeRegistration(sourceId, opts);
				// Another registration keeps the clause; its chart may stop skipping it.
				if (opts.chart && selection.isActive(sourceId)) {
					this.#engine?.onChartRouteChange(this, opts.chart);
				}
			}
		};
	}

	/**
	 * Hand the engine a snapshot of the source: its dims, its view, and its
	 * categorical field, so activation can tell which marks it would filter
	 * before it has written a clause.
	 */
	#activate(sourceId: string): void {
		const registrations = this.selection.registrationsOf(sourceId) as
			| ReadonlySet<SourceOpts>
			| undefined;
		if (!this.#engine || !registrations?.size) return;

		let dims: ActiveDim[] = [];
		let view: SourceOpts['view'];
		let categoricalKey: string | null = null;
		for (const opts of registrations) {
			if (opts.activeDims && dims.length === 0) dims = opts.activeDims();
			view ??= opts.view;
			categoricalKey ??= opts.categorical?.key ?? null;
		}
		this.#engine.activate(this, { sourceId, categoricalKey, dims, view });
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
	registerToggle(fields: string | string[], opts: { chart?: object | null } = {}): ToggleHandle {
		const list = Array.isArray(fields) ? fields : [fields];
		const sourceId = toggleSourceId(list);
		const { selection } = this;
		const schema: FilterSchema = { kind: 'toggle', column: list[0], label: list.join(', ') };
		// One field selects categories; a tuple does not (see Clause.categorical).
		const categoricalKey = list.length === 1 ? (identityKeyFor(list[0])?.key ?? null) : null;
		const source = this.register(sourceId, {
			chart: opts.chart ?? null,
			categorical: categoricalKey
				? {
						key: categoricalKey,
						values: (value) => new Set((value as unknown[][]).map((t) => t[0]))
					}
				: undefined,
			activeDims: () => list.map((field) => ({ kind: 'value' as const, field })),
			augment: () => schema
		});

		const tuplesOf = (clause: Clause | undefined): unknown[][] =>
			(clause?.value as unknown[][] | undefined) ?? [];

		/**
		 * The selection, read from the clause. A brush frame bumps the selection
		 * map's version, so a toggle with nothing selected is re-read on every one;
		 * returning the same set while the clause is unchanged (and one shared
		 * empty set without a clause) keeps that from re-rendering its readers.
		 *
		 * One field's values are the clause's own categorical set, built once per
		 * write. A tuple's keys are built here, once per clause.
		 */
		let last: { clause: Clause; keys: Set<unknown> } | null = null;
		const keysOf = (clause: Clause | undefined): ReadonlySet<unknown> => {
			if (!clause) return NOTHING_SELECTED;
			if (clause.categorical) return clause.categorical.values;
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

	upsertManual(key: string, predicate: FilterExpr, value: unknown, schema?: FilterSchema): void {
		const next: Clause = { predicate, value, schema, categorical: null };
		const sourceId = `manual:${key}`;
		this.#afterUpdate(sourceId, this.selection.update(sourceId, next), next);
	}

	/**
	 * Hold `clause` under a manual key, as given: the relay passes another
	 * group's clause on. The clause it already holds there changes nothing, so
	 * it neither re-projects nor re-queries: the relay runs on every change in
	 * its source group, on every brush frame there.
	 */
	relayClause(key: string, clause: Clause): void {
		const sourceId = `manual:${key}`;
		if (this.selection.get(sourceId) === clause) return;
		this.#afterUpdate(sourceId, this.selection.update(sourceId, clause), clause);
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
		for (const key of this.#selectedFields) this.#activityOf(key).set(this.index, null);
		this.#selectedFields.clear();
		this.#engine?.onFilterChange(this);
	}

	// -----------------------------------------------------------------
	// After a change
	// -----------------------------------------------------------------

	/**
	 * After a clause went from `prev` to `next`: update this group's selection on
	 * the field of either if it is categorical, and have the engine re-query the
	 * marks either clause applies to. A brush, which writes on every pointer
	 * move, touches no selection.
	 */
	#afterUpdate(sourceId: string, prev: Clause | undefined, next: Clause | null): void {
		if (prev?.categorical) this.#syncActivity(prev.categorical.key);
		if (next?.categorical && next.categorical.key !== prev?.categorical?.key) {
			this.#syncActivity(next.categorical.key);
		}
		if (prev || next) this.#engine?.onClauseChange(this, sourceId, prev, next);
	}

	/**
	 * Set this group's selection on field `key` from its clauses: the
	 * intersection of the selected values of every categorical clause on that
	 * field, because the filters AND, or nothing when there is none. Usually one
	 * clause; a native toggle and a relayed one make two. Runs on categorical
	 * clause changes only, never on a brush frame.
	 */
	#syncActivity(key: string): void {
		let active: Set<unknown> | null = null;
		this.selection.forEach((clause) => {
			const categorical = clause.categorical;
			if (!categorical || categorical.key !== key) return;
			if (!active) {
				active = new Set(categorical.values);
				return;
			}
			for (const value of active) if (!categorical.values.has(value)) active.delete(value);
		});
		if (active) this.#selectedFields.add(key);
		else this.#selectedFields.delete(key);
		this.#activityOf(key).set(this.index, active);
	}
}
