/**
 * Categorical identity: stable numeric ids for categorical field values.
 *
 * This module owns *identity* only — which value is which id. Display position
 * (slots, ordering, animation) is not its concern and lives in the scale states.
 *
 * Three pieces:
 *
 * 1. A **dim table per source field**, `__dplot_dim_<field>_s<session>`, holding
 *    `(value, label, id)`. Built from the first table that requests the field;
 *    later tables APPEND unseen values with continuing ids. It never reorders and
 *    never renumbers, so an id already baked into a vertex buffer stays valid and
 *    no earlier mark has to requery. `value` carries the source column's own type
 *    and `label` is NULL, except on a synthetic row (`acquireSynthetic`), where
 *    that is inverted, and on the NULL category's row, where both are NULL.
 *
 * 2. A **per-table view**, `<table>_v_s<session>`, selecting `*` plus one
 *    `__dplot_<field>_idx` column per requested field. Always LEFT JOIN with
 *    COALESCE(-1): an inner join silently drops rows whose value is not in the
 *    dim (a value a later append will add), which is data loss presenting as a
 *    rendering bug. -1 is the unmapped sentinel, unified in `1ac4fd4`. A NULL
 *    value is not unmapped: the dim has a row for it (value NULL, label NULL),
 *    joined with IS NOT DISTINCT FROM, so NULL is a category like any other.
 *
 * 3. An **additive coalescer**, `ensureColumns()`. Concurrent callers union into
 *    a pending set, one CREATE OR REPLACE VIEW runs with the full union, and a
 *    request arriving mid-rebuild is picked up by exactly one more pass.
 *
 * The dim is shared by every categorical scale kind reading that field — the
 * band scale, the facet scale, an ordinal colour scale, a series grouping — so
 * they all see the same ids. That sharing is the point; it is what makes this
 * one mechanism rather than four.
 *
 * **Concurrency**: the append is safe only because QueryEngine holds a single
 * DuckDB connection and awaits statements in sequence, so two appends for the
 * same field cannot both read the same MAX(id). WHERE NOT EXISTS filters
 * duplicate *values*, not duplicate *ids* — it does not make this safe under a
 * connection pool. A second render context is a second connection, which is why
 * both dims and views carry a session suffix.
 *
 * Nothing here is reactive, and nothing here knows which scale kind is reading.
 * That is the point: band and point axes, the facet grid, ordinal colour and
 * the series scale all read the same columns from the same dim, and none of
 * them is special-cased here.
 */

import { IDENTITY_SLOT_CAPACITY } from '$lib/gpu/identity-slot-packing';

/**
 * A synthetic id handed out by `acquireSynthetic`: what to release it with.
 * `generation` ties it to the dims it was acquired from, so a release after a
 * reset does not offer a dropped row to the next acquire.
 */
export interface SyntheticId {
	readonly field: string;
	readonly id: number;
	/** The label it displays: the requested one, or `"<label> (rest)"` beside a real one. */
	readonly label: string;
	readonly generation: number;
}

/** The subset of QueryEngine this module needs. Keeps it testable in isolation. */
export interface IdentityExec {
	exec(sql: string | string[]): Promise<void>;
	/** Rows as plain objects. Callers adapt whatever their driver returns. */
	queryRows(sql: string): Promise<Array<Record<string, unknown>>>;
}

/**
 * A thing that can have an identity: a source column, or a fixed SQL expression
 * over one. Both are dimmed identically — the only difference is how the
 * value is produced.
 */
export interface IdentityField {
	/**
	 * Stable key for this identity. The column name, or the expression's SQL
	 * text. Names the dim, the id column and the value array, and must be the
	 * same string that becomes the scale's `sourceField`, so scale identity and
	 * dim identity cannot diverge.
	 */
	key: string;
	/** SQL producing the value. A quoted identifier, or the expression itself. */
	sql: string;
}

/** A bare string means a plain column. */
function asField(field: string | IdentityField): IdentityField {
	return typeof field === 'string' ? { key: field, sql: quote(field) } : field;
}

interface DimEntry {
	/** Fully-qualified dim table name, without quotes. */
	name: string;
	/** SQL producing this field's value, from the first registration. */
	sql: string;
	/** Source tables already folded into this dim. */
	tables: Set<string>;
	/**
	 * The refusal message once `#checkDimSize` has rejected this dim, and null
	 * otherwise. Sticky, because the dim genuinely IS too big: a later, smaller
	 * table registering the same field must fail too rather than inherit a dim
	 * nothing can draw.
	 *
	 * Recorded rather than inferred from `tables`, because the obvious fix —
	 * marking the table done only after the check passes — would put a second
	 * table back on the CREATE branch, where `CREATE TABLE IF NOT EXISTS` is a
	 * silent no-op and its rows are never appended. That is exactly what `chain`
	 * below exists to prevent, so the refusal is tracked separately.
	 */
	refusal: string | null;
	/**
	 * Serializes work on this dim. The coalescer is per TABLE, so two tables
	 * registering the same field run two independent drains, and without this
	 * they interleave: both observe `tables.size === 0` — the first adds itself
	 * only after its await — so both take the create branch and the second's
	 * CREATE TABLE IF NOT EXISTS is a silent no-op. Its rows are then never
	 * appended, and its categories vanish from a shared scale.
	 */
	chain: Promise<void>;
	/**
	 * The ids each folded table actually holds, as a table name and in JS. The dim
	 * spans every table registering the field; a chart pads and lists only the
	 * categories of its own table, so it never shows a slot for one only another
	 * table has. Built once per table when it folds in: the data is static.
	 */
	present: Map<string, { name: string; ids: Set<number> }>;
}

interface ViewEntry {
	/** Fields the view currently exposes. */
	current: Set<string>;
	/** Fields requested but not yet built. */
	pending: Set<string>;
	/** The in-progress rebuild, if any. */
	inflight: Promise<void> | null;
	/**
	 * The error from each field whose LAST attempt threw, and nothing else.
	 *
	 * The coalescer batches every mark on a table into one drain, so without
	 * this a single refusal rejected the shared promise and took down every
	 * concurrent caller — a mark whose own fields were fine would fail setup and
	 * never retry, blaming a field it had not asked for. Failure has to be as
	 * per-field as the work is.
	 *
	 * Cleared on the field's next success rather than accumulated, so a
	 * transient failure does not become permanent: a retry re-enters `pending`
	 * (the field is not in `current`), is re-attempted, and re-records only if
	 * it throws again. A sticky refusal stays sticky because `#ensureDimNow`
	 * re-throws `dim.refusal`, not because it is remembered here.
	 */
	failures: Map<string, Error>;
}

/**
 * A source value held in a dim.
 *
 * NOT always a string, which the types here claimed until this was checked
 * against DuckDB rather than assumed. A dim is built by `SELECT DISTINCT <expr>`
 * over the source, so the value keeps whatever type that expression produced:
 * a VARCHAR column gives strings, an INTEGER column gives numbers, and a BIGINT
 * column gives **bigints**. A band axis over a year, a rating or a zip code is
 * an ordinary chart, not a corner case.
 *
 * The type is load-bearing, not cosmetic, so this must never be normalized to a
 * string on the way through:
 *
 *  - d3's `scaleBand` keys its lookup by the raw domain value. With a numeric
 *    domain, `scale(2021)` returns a position and `scale('2021')` returns
 *    **undefined** — verified. Every axis tick, TextMark label and tooltip
 *    position goes through that lookup.
 *  - `Toggle` puts a decoded category straight into `literal(v)` from
 *    mosaic-sql, which emits `2021` for a number and `'2021'` for a string. A
 *    stringified value would compare VARCHAR against an INTEGER column.
 *
 * Both directions of `FieldIdentity` are keyed by this, and both sides of every
 * lookup come from the same driver, so a `Map` keyed on it matches by value
 * (SameValueZero, which covers bigint). That is why the round trip is correct
 * today; it is the declared types that were wrong.
 */
export type DimValue = string | number | bigint | null;

/**
 * How a category value is shown: as itself, except the NULL category, which has
 * no text of its own. The one formatter for axis ticks, legend entries, facet
 * labels and tooltips, so NULL reads the same everywhere. Selections keep the
 * raw `null`: this is display only.
 */
export const NULL_CATEGORY_LABEL = '(null)';
export function categoryLabel<T>(value: T): T | string {
	return value === null ? NULL_CATEGORY_LABEL : value;
}

/**
 * A field's id <-> value bijection, both directions in one object.
 *
 * The two used to live apart: the engine owned id -> value and every scale
 * rebuilt value -> id for itself, self-healing on a length mismatch because the
 * array it mirrored was live and owned elsewhere. A bug lived in exactly that
 * seam. Here `reset()` is the only writer and rewrites both directions in
 * one pass, so the pair cannot be half-updated and no holder needs a staleness
 * test.
 *
 * `values` and `ids` are mutated IN PLACE and never reassigned, so a holder
 * keeps a bare reference and sees growth. That is what lets a scale adopt this
 * once and stay correct when a second table appends to the dim.
 */
export class FieldIdentity {
	/**
	 * id -> source value. Dense and 0-based, so position is the id. A synthetic
	 * id (an Other bucket) holds its display label here.
	 */
	readonly values: DimValue[] = [];
	/**
	 * source value -> id, for real values only: the inverse of `values` with the
	 * synthetic ids left out. A label is not a value, and several synthetic ids
	 * may share one, so nothing resolves a bucket by its label.
	 */
	readonly ids = new Map<DimValue, number>();
	/** The synthetic ids (Other buckets): rows of the dim no source row joins to. */
	readonly synthetic = new Set<number>();
	/**
	 * The NULL category's id, or null while the data has no NULL. An ordinary
	 * category: ranked, drawn, selectable; `values[nullId]` is `null`, and `ids`
	 * maps `null` to it, so value lookups need no special case.
	 */
	nullId: number | null = null;

	/**
	 * The identity key this is the bijection for, as `identityKeyFor` derives
	 * it: what a scale that adopted it is keyed by for selection activity.
	 * Empty for one built outside the engine, as tests do.
	 */
	readonly key: string;

	constructor(values?: readonly DimValue[], key: string = '') {
		this.key = key;
		if (values) this.reset(values);
	}

	/**
	 * Bumped by `reset`, so a holder of this LIVE object can tell whether it
	 * moved since it last looked. Appends, a same-length replacement and an
	 * emptying all go through `reset`, so comparing this is complete where
	 * comparing `values.length` is not.
	 */
	version: number = 0;

	/**
	 * Replace both directions. The only writer. `synthetic` names the ids that
	 * are buckets rather than values: they keep their label in `values` and stay
	 * out of `ids`.
	 */
	reset(values: readonly DimValue[], synthetic: Iterable<number> = []): void {
		this.version++;
		this.values.length = 0;
		this.ids.clear();
		this.synthetic.clear();
		this.nullId = null;
		for (const id of synthetic) this.synthetic.add(id);
		for (let i = 0; i < values.length; i++) {
			this.values.push(values[i]);
			if (this.synthetic.has(i)) continue;
			this.ids.set(values[i], i);
			if (values[i] === null) this.nullId = i;
		}
	}

	/** True once the dim has been built and holds at least one value. */
	get present(): boolean {
		return this.values.length > 0;
	}
}

/** Single-quote a string so it is safe as a SQL literal. */
function literal(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/** Double any embedded quote so a name is safe inside "..." . */
function quote(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

/** FNV-1a, base36. Same algorithm QueryEngine uses for preagg table names. */
function shortHash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/**
 * A name safe to embed in an identifier.
 *
 * A key that is already identifier-safe is used as-is, so the common case reads
 * cleanly in a query plan (`__dplot_species_idx`).
 *
 * Anything else — an expression key or an exotic column name — is named
 * by HASH ALONE, not by its sanitized text. Sanitizing produced identifiers of
 * 150+ characters for an ordinary three-branch CASE, growing without bound with
 * the expression and turning its whitespace into runs of underscores: neither
 * readable, which was the point of keeping the text, nor bounded.
 *
 * The hash is over the exact original, which is what disambiguation actually
 * needs — sanitizing alone would map `a.b` and `a-b` onto one name, two fields
 * silently sharing a dim, the wrong-data class of failure rather than a crash.
 * The residual 1-in-2^32 collision is left unhandled as adversarial.
 */
function identityToken(field: string): string {
	const sanitized = field.replace(/[^A-Za-z0-9_]/g, '_');
	return sanitized === field ? field : `h${shortHash(field)}`;
}

/**
 * Above this many distinct values a band axis is refused outright. The shared
 * slot buffer (IDENTITY_SLOT_CAPACITY floats) holds every band and point
 * scale's slots and every selected field's activity, one run per filter group,
 * so an axis this large would crowd out the rest of the page — the limit is
 * capacity, not taste.
 */
export const MAX_IDENTITY_CARDINALITY = 10000;
/**
 * Above this it renders but is unreadable: ~1px per band on a wide axis.
 *
 * It is also where a second, invisible cost starts to matter. A grid on a band
 * axis draws one line per id in the DIM, not per displayed category, because
 * row i has to be the same category on every update for a line's opacity to
 * morph the way a bar's height does. Hidden ids resolve to slot -1 and are put
 * off-screen, so they cost nothing to look at and a vertex each to draw, every
 * frame. Fine at a few hundred; worth knowing at several thousand.
 */
export const WARN_IDENTITY_CARDINALITY = 1000;
/**
 * Quoted in the refusal above. Imported rather than written as a literal so the
 * message cannot claim a budget the packer does not have.
 */
const SLOT_BUDGET = IDENTITY_SLOT_CAPACITY;

export class CategoricalIdentity {
	#exec: IdentityExec;
	#session: string;
	#dims = new Map<string, DimEntry>();
	#views = new Map<string, ViewEntry>();
	/**
	 * Bumped by reset(). Work that started before a reset must not finish into
	 * the state after it: the maps are cleared synchronously while the DROPs run
	 * async, so without this a drain already in flight re-creates a dim that the
	 * reset then drops, or records columns on a view that no longer exists.
	 */
	#generation = 0;
	/** Serializes resets against each other. */
	#resetChain: Promise<void> = Promise.resolve();
	/**
	 * A CACHE of the dim's id -> value mapping, one array per FIELD, indexed by
	 * id.
	 *
	 * DuckDB owns the mapping; this is a synchronously-readable copy of it,
	 * because the readers cannot await. Axis ticks render domain values during
	 * layout, tooltips decode a band index on pointermove, legends and toggles
	 * do the same — none can block on a query. Rebuilding it from mark query
	 * results instead would be per-mark rather than per-field, would see only
	 * the rows surviving the current filter, and would be the per-row JS pass
	 * this identity layer exists to delete.
	 *
	 * The cache is unusually safe because the dim is append-only and never
	 * renumbers: it can only grow, and an entry's meaning never changes once
	 * written. Invalidation collapses to extending the array, so holders can
	 * keep a bare reference and there is no stale-entry case. If ids were ever
	 * reassigned this would need real invalidation and a re-read protocol for
	 * every holder — which is a concrete payoff of the append-only rule, not
	 * just a nicety.
	 *
	 * These are source values — the decode side of the string -> id encode —
	 * NOT display labels. Formatting them for an axis (dates, number formats,
	 * truncation) is presentation and stays in the scale/axis layer.
	 *
	 *
	 * Deliberately one shared array rather than a copy per scale or per mark: a
	 * second table registering the same field appends to the dim afterwards, and
	 * ids from it would index past the end of an older copy. That shows up as
	 * blank axis labels in multi-table charts only — the kind of bug that
	 * survives a long time. Refreshes mutate this array IN PLACE so every holder
	 * of the reference sees the growth; because the dim is append-only and never
	 * renumbers, an in-place extension is always consistent with ids already in
	 * flight.
	 */
	#identities = new Map<string, FieldIdentity>();
	/**
	 * Released synthetic ids, per field and label, for the next acquire. Keeps the
	 * dim from growing a row per remount: mark ids are random, so nothing about a
	 * remounted mark can name the id it held before. Cleared with the dims.
	 */
	#freeSynthetic = new Map<string, Map<string, number[]>>();
	/** key -> SQL producing the value. Set at registration, read by the drain. */
	#sqlFor = new Map<string, string>();

	constructor(exec: IdentityExec, session: string) {
		this.#exec = exec;
		this.#session = session;
	}

	/** Name of the id column this module adds to a view for `field`. */
	idColumn(field: string): string {
		return `__dplot_${identityToken(field)}_idx`;
	}

	/** SQL producing `field`'s value, once a mark has registered it; undefined before. */
	sqlFor(field: string): string | undefined {
		return this.#sqlFor.get(field);
	}

	/**
	 * Whether `field`'s dim has folded in `table`, so every value the table holds,
	 * NULL included, has an id and `-1` never appears. A dim another table built
	 * may lack this table's values; a refused dim covers nothing.
	 */
	dimCovers(field: string, table: string): boolean {
		const dim = this.#dims.get(field);
		return !!dim && !dim.refusal && dim.tables.has(table);
	}

	/** The field whose id column is `column`, or null if no dim has that column. */
	fieldOfIdColumn(column: string): string | null {
		for (const field of this.#dims.keys()) if (this.idColumn(field) === column) return field;
		return null;
	}

	/** Whether `table`'s view already exposes `field`'s id column. */
	viewHas(table: string, field: string): boolean {
		return this.#views.get(table)?.current.has(field) ?? false;
	}

	/** Name of the dim table for `field`. */
	dimTable(field: string): string {
		return `__dplot_dim_${identityToken(field)}_s${this.#session}`;
	}

	/**
	 * The table of ids `table` holds for `field`, or null before that table has
	 * folded into the dim. What `dense()` pads from, so a chart never pads a
	 * category only another table has.
	 */
	presentTable(field: string, table: string): string | null {
		return this.#dims.get(field)?.present.get(table)?.name ?? null;
	}

	/** The ids `table` holds for `field`, or null before that table has folded in. */
	presentIds(field: string, table: string): ReadonlySet<number> | null {
		return this.#dims.get(field)?.present.get(table)?.ids ?? null;
	}

	/**
	 * Record which of the dim's ids `table` holds: the ids of its distinct values,
	 * joined as the view joins (NULL to a NULL row, never to a synthetic one).
	 * Once per table, when it folds in.
	 */
	async #recordPresent(dim: DimEntry, table: string, expr: string, src: string): Promise<void> {
		const name = `${dim.name}_t_${identityToken(table)}`;
		await this.#exec.exec(
			`CREATE OR REPLACE TABLE ${quote(name)} AS ` +
				`SELECT DISTINCT d.id FROM (SELECT DISTINCT ${expr} AS v FROM ${src}) s ` +
				`JOIN ${quote(dim.name)} d ON s.v IS NOT DISTINCT FROM d.value AND d.label IS NULL`
		);
		const rows = await this.#exec.queryRows(`SELECT id FROM ${quote(name)}`);
		dim.present.set(table, { name, ids: new Set(rows.map((r) => Number(r.id))) });
	}

	/** Name of the view that carries id columns for `table`. */
	viewTable(table: string): string {
		return `${identityToken(table)}_v_s${this.#session}`;
	}

	/**
	 * The view to query for `table`, or the table itself when no identity
	 * columns are BUILT for it yet. Callers substitute this for the table name;
	 * a table with no categorical channels is untouched.
	 *
	 * Gated on `current` — fields the view actually exposes — not on the entry
	 * existing. ensureColumns registers the entry synchronously, well before the
	 * CREATE OR REPLACE VIEW runs, so keying on the entry names a relation that
	 * may not exist for the whole width of the first drain. Substituting the
	 * base table meanwhile is always safe: the view is `SELECT t.*` plus id
	 * columns, so the two differ only in columns a caller that has not awaited
	 * ensureColumns cannot be selecting.
	 */
	sourceFor(table: string): string {
		const entry = this.#views.get(table);
		return entry && entry.current.size > 0 ? this.viewTable(table) : table;
	}

	/**
	 * Dim values for `field`, indexed by id — `values(f)[id]` is the source
	 * value. The live array, not a copy: hold the reference rather than
	 * snapshotting it. Empty until the field's dim has been built.
	 */
	values(field: string): DimValue[] {
		return this.identity(field).values;
	}

	/**
	 * The field's id <-> value bijection. The live object, not a copy: hold the
	 * reference rather than snapshotting either direction. Empty until the
	 * field's dim has been built, and created on first ask so a caller can adopt
	 * it before the dim exists.
	 */
	identity(field: string): FieldIdentity {
		let entry = this.#identities.get(field);
		if (!entry) {
			entry = new FieldIdentity(undefined, field);
			this.#identities.set(field, entry);
		}
		return entry;
	}

	/**
	 * The field's current bijection, or null if nothing has asked for it since
	 * the last reset. Unlike `identity`, never creates one: for a holder checking
	 * whether the identity it applied is still the live one, on every frame.
	 */
	peekIdentity(field: string): FieldIdentity | null {
		return this.#identities.get(field) ?? null;
	}

	/** Fields the view for `table` currently exposes. Empty when there is no view. */
	columnsFor(table: string): string[] {
		return [...(this.#views.get(table)?.current ?? [])];
	}

	/**
	 * Ensure `table`'s view exposes an id column for every field in
	 * `categorical`. Idempotent: fields already present cost nothing. Safe to
	 * call concurrently from every mark during setup — callers union into one
	 * rebuild rather than racing to CREATE OR REPLACE the same view.
	 */
	async ensureColumns(
		table: string,
		fields: { categorical?: (string | IdentityField)[] }
	): Promise<void> {
		const categorical = (fields.categorical ?? []).map(asField);
		if (categorical.length === 0) return;

		let entry = this.#views.get(table);
		if (!entry) {
			entry = { current: new Set(), pending: new Set(), inflight: null, failures: new Map() };
			this.#views.set(table, entry);
		}

		for (const field of categorical) {
			// Remember the SQL before the drain needs it; the pending set is keys.
			this.#sqlFor.set(field.key, field.sql);
			if (!entry.current.has(field.key)) entry.pending.add(field.key);
		}

		// Nothing new. Still await any rebuild in flight, so a caller that asked
		// only for already-present fields does not race ahead of the CREATE OR
		// REPLACE that a concurrent caller is running against the same view.
		//
		// No failure check on this branch, and it is not an omission: reaching it
		// means every field this caller asked for is in `current`, and a field
		// enters `current` only by succeeding, which deletes it from `failures`.
		if (entry.pending.size === 0) {
			if (entry.inflight) await entry.inflight;
			return;
		}

		const generation = this.#generation;

		if (!entry.inflight) {
			// Yield one microtask before reading `pending`. Every mark on a chart
			// calls this from the same Promise.all, so they all run synchronously up
			// to their first await — starting the drain immediately would let the
			// first caller claim the batch alone and charge the others a second
			// rebuild each. Deferring lets one tick's worth of callers accumulate
			// into a single CREATE OR REPLACE VIEW. Callers arriving later, after
			// real I/O has begun, are the "during a rebuild" case and still cost
			// exactly one more pass.
			entry.inflight = Promise.resolve().then(() => this.#drain(table, entry, generation));
		}
		await entry.inflight;

		// A reset landed while this was in flight, so the view this caller was
		// promised no longer exists. Reject rather than resolve: the caller's
		// next move is to select id columns FROM that view, and a silent resolve
		// turns a reload into a binder error with no context, or worse, a query
		// against a stale view that still resolves.
		if (this.#generation !== generation) {
			throw new Error(
				`Categorical identity for "${table}" was reset while being built; ` +
					`the mark must re-run setup.`
			);
		}

		// Only THIS caller's fields. The drain builds one batch for every mark on
		// the table, so a refusal it hit belongs to whichever caller asked for
		// that field — rejecting the shared promise instead would fail marks that
		// have their columns and can render, and hand them an error naming a
		// field they never mentioned.
		//
		// After the reset check, because a reset invalidates the fields too and
		// its message is the one that says what to do about it.
		for (const field of categorical) {
			const failure = entry.failures.get(field.key);
			if (failure) throw failure;
		}
	}

	/**
	 * Build every pending field, then rebuild the view. Loops rather than
	 * returning after one pass: a caller arriving during an await adds to
	 * `pending`, and the re-check picks it up, so any number of concurrent
	 * arrivals cost exactly one extra rebuild.
	 *
	 * `inflight` is cleared in a finally *inside* the async function, so it is
	 * null the instant the loop exits rather than one microtask later — a caller
	 * landing in that gap starts a fresh drain instead of awaiting a promise
	 * that is already done with its work.
	 *
	 * A field that throws is RECORDED, not propagated. One batch serves every
	 * mark on the table, so throwing out of here rejects the shared promise and
	 * fails marks whose own fields built cleanly; `ensureColumns` re-throws each
	 * failure to the callers that asked for that field. Only a failure of the
	 * view rebuild itself still rejects everyone, because then nobody got a
	 * column.
	 */
	async #drain(table: string, entry: ViewEntry, generation: number): Promise<void> {
		try {
			while (entry.pending.size > 0) {
				// Superseded by a reset: stop before issuing more DDL, which would
				// re-create objects the reset is in the middle of dropping.
				if (this.#generation !== generation) return;

				const batch = [...entry.pending];
				entry.pending.clear();

				const succeeded: string[] = [];
				for (const field of batch) {
					try {
						await this.#ensureDim(field, table, generation);
						succeeded.push(field);
						entry.failures.delete(field);
					} catch (error) {
						entry.failures.set(field, error instanceof Error ? error : new Error(String(error)));
					}
				}

				if (this.#generation !== generation) return;

				// Nothing new to expose. Skip the rebuild rather than re-running
				// CREATE OR REPLACE with the columns it already has — and when
				// `current` is empty too, `#createView` would have no columns to
				// emit and would build syntactically invalid SQL.
				if (succeeded.length === 0) continue;

				const all = new Set([...entry.current, ...succeeded]);
				await this.#createView(table, [...all]);

				// Only after the view exists — a failed rebuild must not leave
				// `current` claiming columns that are not there.
				entry.current = all;
			}
		} finally {
			entry.inflight = null;
		}
	}

	/**
	 * Create the dim for `field` from `table`, or append `table`'s unseen values
	 * to an existing one.
	 *
	 * The append reads MAX(id) in the same statement that inserts, so ids
	 * continue rather than restart. WHERE is applied before the window function,
	 * so ROW_NUMBER numbers only the new values.
	 */
	#ensureDim(field: string, table: string, generation: number): Promise<void> {
		let dim = this.#dims.get(field);
		if (!dim) {
			dim = {
				name: this.dimTable(field),
				sql: this.#sqlFor.get(field) ?? quote(field),
				tables: new Set(),
				refusal: null,
				chain: Promise.resolve(),
				present: new Map()
			};
			this.#dims.set(field, dim);
		}

		// Queue behind any work already running on this dim, so the next caller
		// observes the completed `tables` set and takes the append branch. The
		// stored chain swallows rejections so one failure does not poison every
		// later append; the returned promise still rejects for this caller.
		const next = dim.chain.then(() => this.#ensureDimNow(dim!, field, table, generation));
		dim.chain = next.catch(() => {});
		return next;
	}

	/**
	 * Acquire an id for a value that exists in no table — the synthetic "Other"
	 * bucket a `topN({ includeOthers })` produces — and return it with the label
	 * it displays.
	 *
	 * A released id with the same label is reused before a dim row is inserted,
	 * so remounting a chart does not grow the dim or the field's activity block.
	 * Keyed by label too, so a reused id never needs relabelling.
	 *
	 * Goes through the same writer as every other id, so `values(f)[id]` is the
	 * label; `synthetic` records that it is a bucket, which keeps it out of the
	 * value -> id map. Serialized on the per-field chain, so it cannot interleave
	 * with an append.
	 *
	 * Non-negative by construction: `scaleBand` discards `value < 0.0` before the
	 * slot lookup, so a negative sentinel could never render.
	 *
	 * **A real category carrying the label stays a category.** The bucket takes
	 * `"<label> (rest)"` instead, so two bars never share a label and the real
	 * one stays selectable. The check runs at acquire; a reload re-acquires.
	 *
	 * Requires the dim to exist: call after `ensureColumns` has resolved.
	 */
	acquireSynthetic(field: string, label: string): Promise<SyntheticId> {
		const dim = this.#dims.get(field);
		if (!dim) {
			return Promise.reject(
				new Error(`No dim for "${field}" — acquireSynthetic must follow ensureColumns.`)
			);
		}
		const generation = this.#generation;
		const next = dim.chain.then(() => this.#acquireSyntheticNow(dim, field, label, generation));
		// Drop both the value and any rejection: the chain only sequences work,
		// and one failure must not poison every later append.
		dim.chain = next.then(
			() => {},
			() => {}
		);
		return next;
	}

	/**
	 * Give an acquired id back for the next acquire of the same label. One from
	 * before a reset names a row of a dropped dim, and is ignored.
	 */
	releaseSynthetic(synthetic: SyntheticId): void {
		if (synthetic.generation !== this.#generation) return;
		let byLabel = this.#freeSynthetic.get(synthetic.field);
		if (!byLabel) this.#freeSynthetic.set(synthetic.field, (byLabel = new Map()));
		let free = byLabel.get(synthetic.label);
		if (!free) byLabel.set(synthetic.label, (free = []));
		if (!free.includes(synthetic.id)) free.push(synthetic.id);
	}

	/**
	 * Abort an acquire that a reset overtook. An AbortError, which a mark's setup
	 * treats as superseded rather than failed: the reset re-runs that setup, and
	 * it acquires again from the new dim.
	 */
	#throwIfSuperseded(generation: number, field: string, label: string): void {
		if (this.#generation === generation) return;
		const superseded = new Error(`Acquiring "${label}" for "${field}" was superseded by a reset.`);
		superseded.name = 'AbortError';
		throw superseded;
	}

	async #acquireSyntheticNow(
		dim: DimEntry,
		field: string,
		requested: string,
		generation: number
	): Promise<SyntheticId> {
		// Queued behind work that outlived a reset, as #ensureDimNow checks too.
		// Without this the INSERT would write a bucket row into the NEW dim (same
		// name) that no one holds and no release can return: releases from an
		// older generation are ignored.
		// Checked again after each await: a reset landing mid-flight drops the dim
		// the row went into, and the identity read afterwards is a new one.
		this.#throwIfSuperseded(generation, field, requested);
		const identity = this.identity(field);
		let label = requested;
		while (identity.ids.has(label)) label = `${label} (rest)`;

		const free = this.#freeSynthetic.get(field)?.get(label);
		const reused = free?.pop();
		if (reused !== undefined) return { field, id: reused, label, generation };

		const dimName = quote(dim.name);
		// value NULL, label carrying the text. The label cannot go in `value`:
		// that column has the source column's type, so 'Other' against a year or
		// a rating is `Conversion Error: Could not convert string 'Other' to
		// INT32` — includeOthers simply threw on every non-VARCHAR band axis.
		//
		// NULL is the right value rather than a placeholder of the column's type,
		// because a synthetic row must never join to a source row and #createView
		// joins ON t.key = d.value. Any in-range sentinel would collide with a
		// real category the moment the data contained it; NULL cannot, since
		// NULL = anything is never true.
		//
		// RETURNING, not a lookup by label afterwards: several buckets may carry
		// one label, and labels are kept out of the value -> id map.
		const rows = await this.#exec.queryRows(
			`INSERT INTO ${dimName} (value, label, id) ` +
				`SELECT NULL, ${literal(label)}, ` +
				`(SELECT COALESCE(MAX(id), -1) + 1 FROM ${dimName})::INT ` +
				`RETURNING id`
		);
		this.#throwIfSuperseded(generation, field, requested);
		await this.#refreshValues(field);
		this.#throwIfSuperseded(generation, field, requested);

		const id = Number(rows[0]?.id);
		if (!Number.isInteger(id) || !identity.synthetic.has(id)) {
			throw new Error(`Acquired "${label}" for "${field}" but it is absent from the dim.`);
		}
		return { field, id, label, generation };
	}

	async #ensureDimNow(
		dim: DimEntry,
		field: string,
		table: string,
		generation: number
	): Promise<void> {
		// BEFORE the tables check, not after: a mark whose setup re-runs would
		// otherwise hit `tables.has(table)`, return early, and render against a
		// dim the size check had already refused — the refusal firing exactly
		// once and then never again.
		if (dim.refusal) throw new Error(dim.refusal);
		if (dim.tables.has(table)) return;
		// Queued behind other dim work that outlived a reset.
		if (this.#generation !== generation) return;

		const dimName = quote(dim.name);
		const src = quote(table);
		// The value expression: a quoted column, or a fixed SQL expression. Both
		// are evaluated with only the source table in scope.
		const expr = dim.sql;

		await this.#checkCardinality(field, expr, src);

		if (dim.tables.size === 0) {
			// `label` is NULL for every real value and carries the text for a
			// synthetic one (see reserveSynthetic). It exists because `value` takes
			// the SOURCE column's type: on a band axis over a year or a rating
			// there is no INTEGER that means "Other", and writing the string into
			// that column is a conversion error, not a fallback.
			await this.#exec.exec(
				`CREATE TABLE IF NOT EXISTS ${dimName} AS ` +
					`SELECT value, NULL::VARCHAR AS label, ` +
					`(ROW_NUMBER() OVER (ORDER BY value NULLS LAST) - 1)::INT AS id ` +
					`FROM (SELECT DISTINCT ${expr} AS value FROM ${src})`
			);
			// A second statement: CTAS cannot carry a constraint. `value` is unique
			// by construction here (DISTINCT) and on append (WHERE NOT EXISTS), but
			// reserveSynthetic is a writer that could break it, and a duplicate
			// value does not tie-break — #createView joins ON t.field = d.value, so
			// it FANS OUT every matching source row in every query against the
			// view. Cheap insurance against a future writer forgetting.
			//
			// Synthetic rows hold value NULL, and SQL treats NULLs as distinct
			// under a unique index, so any number of them coexist here — verified
			// against DuckDB rather than assumed.
			await this.#exec.exec(
				`CREATE UNIQUE INDEX IF NOT EXISTS ${quote(`${dim.name}_value_uq`)} ON ${dimName}(value)`
			);
		} else {
			// Columns named rather than positional: the table has three of them and
			// a positional INSERT would silently put the id into `label`.
			await this.#exec.exec(
				`INSERT INTO ${dimName} (value, label, id) ` +
					`SELECT s.v, NULL, ((SELECT COALESCE(MAX(id), -1) FROM ${dimName}) + ` +
					`ROW_NUMBER() OVER (ORDER BY s.v NULLS LAST))::INT ` +
					`FROM (SELECT DISTINCT ${expr} AS v FROM ${src}) s ` +
					// IS NOT DISTINCT FROM, so a second table's NULLs find the NULL row
					// (NULL = NULL is never true, and `=` appended one per table). The
					// label test keeps a synthetic row, also value NULL, from passing
					// for it.
					`WHERE NOT EXISTS (SELECT 1 FROM ${dimName} d ` +
					`WHERE d.value IS NOT DISTINCT FROM s.v AND d.label IS NULL)`
			);
		}

		dim.tables.add(table);
		await this.#refreshValues(field);
		await this.#recordPresent(dim, table, expr, src);

		// The gate above saw ONE table. The dim spans every table that registers
		// the field, so two tables of 6k each pass it individually and produce a
		// 12k dim — and the limit is a property of the dim, since that is what
		// sizes the slot table and therefore what the shared buffer has to hold.
		// Exact rather than approximate here: the rows exist, COUNT(*) on a
		// categorical dim is trivial, and this is the number the error should
		// quote.
		this.#checkDimSize(dim, field, this.identity(field).values.length);
	}

	/**
	 * Refuse a band axis with more distinct values than can render.
	 *
	 * Runs here rather than in `#fetchFieldStats` — that is a sibling of
	 * `#ensureIdentityColumns` in the same `Promise.all`, so gating one on the
	 * other would serialize two concurrent operations and put a round trip on
	 * the setup path that already blocks on one. Here it costs a query only for fields
	 * that actually get a dim, and it is where the refusal has to land anyway.
	 *
	 * `approx_count_distinct` rather than `COUNT(DISTINCT …)`: one HyperLogLog
	 * pass with no materialization, which matters precisely for the runaway
	 * expression this exists to catch.
	 *
	 * Neither syntax nor result type can answer this question — `year(ts)` is
	 * numeric with a tiny distinct set, a CASE can have ten thousand branches —
	 * so the count is the only honest gate.
	 */
	async #checkCardinality(field: string, expr: string, src: string): Promise<void> {
		const rows = await this.#exec.queryRows(
			`SELECT approx_count_distinct(${expr}) AS n FROM ${src}`
		);
		const n = Number(rows[0]?.n ?? 0);

		if (n > MAX_IDENTITY_CARDINALITY) {
			throw new Error(
				`"${field}" has about ${n} distinct values in this table, over the ` +
					`${MAX_IDENTITY_CARDINALITY} a categorical scale can render. Use a continuous ` +
					`scale, bin the values, or reduce them with a transform.`
			);
		}
	}

	/**
	 * Refuse or warn on the DIM's size, which is what actually has to render.
	 *
	 * Separate from `#checkCardinality` because they answer different questions.
	 * That one is a cheap pre-flight against a single table, run before any rows
	 * are materialized so a runaway expression is refused without building
	 * anything. This one is the real limit, and it can only be applied after the
	 * append, because until then the union is unknown.
	 *
	 * Throwing here leaves the appended rows in place. That is deliberate: the
	 * dim genuinely IS over the limit, so a later, smaller table registering the
	 * same field should fail too rather than inherit a dim nothing can draw.
	 * Rolling back would make the failure depend on which mark set up first.
	 *
	 * That "should" is now enforced rather than asserted. The refusal is stored
	 * on the dim and re-thrown by `#ensureDimNow` before its `tables` check, so
	 * a mark re-running setup cannot slip past it — previously the throw left
	 * the table already marked done, and the retry returned early and rendered
	 * against the dim this refused.
	 *
	 * The buffer figure is quoted here and nowhere else, because this is the
	 * only check that compares against the thing the buffer actually holds.
	 */
	#checkDimSize(dim: DimEntry, field: string, size: number): void {
		if (size > MAX_IDENTITY_CARDINALITY) {
			// Recorded on the dim before it is thrown, so every later registration
			// of this field fails the same way instead of the first one being the
			// only one that ever sees it.
			dim.refusal =
				`"${field}" has ${size} distinct values across every table registering it, over the ` +
				`${MAX_IDENTITY_CARDINALITY} a categorical scale can render. The shared slot ` +
				`buffer holds ${SLOT_BUDGET} ids across every scale that needs one on the ` +
				`page, so this is a page-wide budget and not a per-axis one. Use a continuous ` +
				`scale, bin the values, or reduce them with a transform.`;
			throw new Error(dim.refusal);
		}
		if (size > WARN_IDENTITY_CARDINALITY) {
			console.warn(
				`[identity] "${field}" has ${size} distinct values; a band axis with more than ` +
					`~${WARN_IDENTITY_CARDINALITY} categories is under a pixel per band on most charts, ` +
					`and a grid on that axis draws a line per value whether it is displayed or not.`
			);
		}
	}

	/**
	 * Re-read the dim into the field's value array, mutating in place.
	 *
	 * Re-reading the whole dim rather than only the new rows: categorical
	 * cardinality is small, this runs once per (field, table) pair at setup, and
	 * a full read cannot drift out of sync with the ids the way an incremental
	 * one can if an append is ever missed.
	 */
	/**
	 * Bumped whenever a dim's rows change: a table folding in, an Other bucket
	 * reserved, a reset. A query that reads a dim (dense padding, an id join)
	 * returns different rows afterwards under the same SQL text, so whatever
	 * caches results by that text must also key on this. Only ever increases.
	 */
	get version(): number {
		return this.#version;
	}

	#version = 0;

	async #refreshValues(field: string): Promise<void> {
		const rows = await this.#exec.queryRows(
			`SELECT id, value, label FROM ${quote(this.dimTable(field))} ORDER BY id`
		);

		// Ordered by id and dense by construction, so position is the id — and
		// reset() derives value -> id from the same pass, so the two directions
		// cannot disagree.
		//
		// `label` wins where it is set, which is only ever a synthetic row. Every
		// real row has label NULL and keeps its native value, so this does not
		// stringify anything the dim read from the source (see DimValue). A row
		// with a label is recorded as synthetic, which keeps it out of the
		// value -> id map: a label is not a value.
		const synthetic: number[] = [];
		for (let i = 0; i < rows.length; i++) if (rows[i].label != null) synthetic.push(i);
		this.identity(field).reset(
			rows.map((row) => (row.label ?? row.value) as DimValue),
			synthetic
		);
		// After the rows are written, never before: a query keyed on the new
		// version must see them. One keyed on the old version may also see them,
		// which costs a re-run later, not a stale result.
		this.#version++;
	}

	/** CREATE OR REPLACE the view with an id column for every field in `all`. */
	async #createView(table: string, all: string[]): Promise<void> {
		const src = quote(table);
		const joins: string[] = [];
		const columns: string[] = [];
		const keyExprs: string[] = [];
		const keyCols: string[] = [];

		all.forEach((field, i) => {
			const alias = `d${i}`;
			const keyCol = `__dplot_key_${i}`;
			const dimName = quote(this.#dims.get(field)!.name);
			keyExprs.push(`(${this.#dims.get(field)!.sql}) AS ${quote(keyCol)}`);
			keyCols.push(quote(keyCol));
			columns.push(`COALESCE(${alias}.id, -1) AS ${quote(this.idColumn(field))}`);
			// IS NOT DISTINCT FROM, so a NULL source value joins the NULL row; the
			// label test keeps synthetic rows (also value NULL) out. Measured free:
			// it keeps the hash join. An `= OR (both NULL)` form falls back to a
			// nested loop, 73 s on 2 M rows x 10 000 categories — never write it.
			joins.push(
				`LEFT JOIN ${dimName} ${alias} ON t.${quote(keyCol)} IS NOT DISTINCT FROM ${alias}.value ` +
					`AND ${alias}.label IS NULL`
			);
		});

		// The value expression is computed in an inner SELECT, where only the
		// source table is in scope, and joined on the qualified helper column.
		//
		// Joining on the raw expression instead would evaluate it in a scope that
		// also contains the dim, so an expression over a column named `id` or
		// `value` — `id` is not a rare column name — would bind ambiguously or,
		// worse, to the dim's column. EXCLUDE drops the helpers again, so the
		// view's shape is still `SELECT *` plus one id column per field.
		await this.#exec.exec(
			`CREATE OR REPLACE VIEW ${quote(this.viewTable(table))} AS ` +
				`SELECT t.* EXCLUDE (${keyCols.join(', ')}), ${columns.join(', ')} ` +
				`FROM (SELECT *, ${keyExprs.join(', ')} FROM ${src}) t ${joins.join(' ')}`
		);
	}

	/**
	 * Drop every view and dim and forget all state. Called on data reload, where
	 * the ids are stale by definition — the same values may not exist any more,
	 * and CREATE TABLE IF NOT EXISTS would otherwise keep serving pre-reload ids
	 * indefinitely, the same trap preagg cubes have.
	 *
	 * Views go first: they depend on the dims.
	 */
	reset(): Promise<void> {
		// Serialized against other resets, so two reloads cannot interleave their
		// DROPs with each other's bookkeeping. The generation bump is INSIDE the
		// chained work, not before it, so it pairs with the drops it belongs to.
		const next = this.#resetChain.then(() => this.#resetNow());
		this.#resetChain = next.catch(() => {});
		return next;
	}

	async #resetNow(): Promise<void> {
		// Before any await: work already in flight compares against this and
		// stops rather than re-creating what is about to be dropped.
		this.#generation++;
		this.#version++;

		const views = [...this.#views.keys()].map((t) => this.viewTable(t));
		const dims = [...this.#dims.values()].flatMap((d) => [
			d.name,
			...[...d.present.values()].map((p) => p.name)
		]);
		this.#views.clear();
		this.#dims.clear();
		// In place, so any scale still holding the reference empties with it.
		for (const identity of this.#identities.values()) identity.reset([]);
		this.#identities.clear();
		// Their ids name rows of the dims being dropped.
		this.#freeSynthetic.clear();

		for (const view of views) {
			await this.#exec.exec(`DROP VIEW IF EXISTS ${quote(view)}`);
		}
		for (const dim of dims) {
			await this.#exec.exec(`DROP TABLE IF EXISTS ${quote(dim)}`);
		}
	}
}
