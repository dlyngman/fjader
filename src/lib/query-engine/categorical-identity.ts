/**
 * Categorical identity: stable numeric ids for categorical field values.
 *
 * Band step 2 of `proposals/review_band_category_index_architecture.md` §9.2.
 * This module owns *identity* only — which value is which id. Display position
 * (slots, ordering, animation) is not its concern and lives in the scale states.
 *
 * Three pieces:
 *
 * 1. A **dim table per source field**, `__dplot_dim_<field>_s<session>`, holding
 *    `(value, id)`. Built from the first table that requests the field; later
 *    tables APPEND unseen values with continuing ids. It never reorders and never
 *    renumbers, so an id already baked into a vertex buffer stays valid and no
 *    earlier mark has to requery.
 *
 * 2. A **per-table view**, `<table>_v_s<session>`, selecting `*` plus one
 *    `__dplot_<field>_idx` column per requested field. Always LEFT JOIN with
 *    COALESCE(-1): an inner join silently drops rows whose value is not in the
 *    dim (NULLs, values added later), which is data loss presenting as a
 *    rendering bug. -1 is the unmapped sentinel, unified in `1ac4fd4`.
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
 * Band and point positional axes read these columns today (step 3a); ordinal
 * colour, series and facet still CASE-inline a display position, and switch
 * over one at a time in steps 3b and 3c.
 */

/** The subset of QueryEngine this module needs. Keeps it testable in isolation. */
export interface IdentityExec {
	exec(sql: string | string[]): Promise<void>;
	/** Rows as plain objects. Callers adapt whatever their driver returns. */
	queryRows(sql: string): Promise<Array<Record<string, unknown>>>;
}

/**
 * A thing that can have an identity: a source column, or a fixed SQL expression
 * over one (§16). Both are dimmed identically — the only difference is how the
 * value is produced.
 */
export interface IdentityField {
	/**
	 * Stable key for this identity. The column name, or the expression's SQL
	 * text. Names the dim, the id column and the value array, and must be the
	 * same string that becomes the scale's `sourceField`, so scale identity and
	 * dim identity cannot diverge (§16.3).
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
	 * Serializes work on this dim. The coalescer is per TABLE, so two tables
	 * registering the same field run two independent drains, and without this
	 * they interleave: both observe `tables.size === 0` — the first adds itself
	 * only after its await — so both take the create branch and the second's
	 * CREATE TABLE IF NOT EXISTS is a silent no-op. Its rows are then never
	 * appended, and its categories vanish from a shared scale.
	 */
	chain: Promise<void>;
}

interface ViewEntry {
	/** Fields the view currently exposes. */
	current: Set<string>;
	/** Fields requested but not yet built. */
	pending: Set<string>;
	/** The in-progress rebuild, if any. */
	inflight: Promise<void> | null;
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
export type DimValue = string | number | bigint;

/**
 * A field's id <-> value bijection, both directions in one object.
 *
 * The two used to live apart: the engine owned id -> value and every scale
 * rebuilt value -> id for itself, self-healing on a length mismatch because the
 * array it mirrored was live and owned elsewhere. §15.5 #5 was a bug in exactly
 * that seam. Here `reset()` is the only writer and rewrites both directions in
 * one pass, so the pair cannot be half-updated and no holder needs a staleness
 * test.
 *
 * `values` and `ids` are mutated IN PLACE and never reassigned, so a holder
 * keeps a bare reference and sees growth. That is what lets a scale adopt this
 * once and stay correct when a second table appends to the dim (§9.4).
 */
export class FieldIdentity {
	/** id -> source value. Dense and 0-based, so position is the id. */
	readonly values: DimValue[] = [];
	/** source value -> id. The exact inverse of `values`. */
	readonly ids = new Map<DimValue, number>();

	constructor(values?: readonly DimValue[]) {
		if (values) this.reset(values);
	}

	/** Replace both directions. The only writer. */
	reset(values: readonly DimValue[]): void {
		this.values.length = 0;
		this.ids.clear();
		for (let i = 0; i < values.length; i++) {
			this.values.push(values[i]);
			this.ids.set(values[i], i);
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
 * Anything else — an expression key (§16) or an exotic column name — is named
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
 * Above this many distinct values a band axis is refused outright (§16.6).
 * The shared slot buffer holds 16384 floats across every band and point scale,
 * so a single axis this large cannot render whatever else is on the page — the
 * limit is capacity, not taste.
 */
export const MAX_IDENTITY_CARDINALITY = 10000;
/** Above this it renders but is unreadable: ~1px per band on a wide axis. */
export const WARN_IDENTITY_CARDINALITY = 1000;

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
	 * id. §9.4.
	 *
	 * DuckDB owns the mapping; this is a synchronously-readable copy of it,
	 * because the readers cannot await. Axis ticks render domain values during
	 * layout, tooltips decode a band index on pointermove, legends and toggles
	 * do the same — none can block on a query. Rebuilding it from mark query
	 * results instead would be per-mark rather than per-field, would see only
	 * the rows surviving the current filter, and would be the per-row JS pass
	 * §3 exists to delete.
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

	/** Name of the dim table for `field`. */
	dimTable(field: string): string {
		return `__dplot_dim_${identityToken(field)}_s${this.#session}`;
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
			entry = new FieldIdentity();
			this.#identities.set(field, entry);
		}
		return entry;
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
			entry = { current: new Set(), pending: new Set(), inflight: null };
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
	 */
	async #drain(table: string, entry: ViewEntry, generation: number): Promise<void> {
		try {
			while (entry.pending.size > 0) {
				// Superseded by a reset: stop before issuing more DDL, which would
				// re-create objects the reset is in the middle of dropping.
				if (this.#generation !== generation) return;

				const batch = [...entry.pending];
				entry.pending.clear();

				for (const field of batch) {
					await this.#ensureDim(field, table, generation);
				}

				if (this.#generation !== generation) return;

				const all = new Set([...entry.current, ...batch]);
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
				chain: Promise.resolve()
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
	 * Reserve an id for a value that exists in no table — the synthetic "Other"
	 * bucket a `topN({ includeOthers })` produces (§16.9).
	 *
	 * Goes through the same writer as every other id, so `values(f)[otherId]` is
	 * the label and no consumer has to know it was synthetic. Serialized on the
	 * per-field chain, so it cannot interleave with an append.
	 *
	 * Non-negative by construction: `scaleBand` discards `value < 0.0` before the
	 * slot lookup, so a negative sentinel could never render.
	 *
	 * **Reuses the id if a real category already carries this label**, rather
	 * than inserting a duplicate value — see the fan-out note above. Callers get
	 * an id that may already be in the data, which the transform has to fold
	 * into rather than append beside.
	 *
	 * Requires the dim to exist: call after `ensureColumns` has resolved.
	 */
	reserveSynthetic(field: string, label: string): Promise<number> {
		const dim = this.#dims.get(field);
		if (!dim) {
			return Promise.reject(
				new Error(`No dim for "${field}" — reserveSynthetic must follow ensureColumns.`)
			);
		}
		const next = dim.chain.then(() => this.#reserveSyntheticNow(dim, field, label));
		// Drop both the value and any rejection: the chain only sequences work,
		// and one failure must not poison every later append.
		dim.chain = next.then(
			() => {},
			() => {}
		);
		return next;
	}

	async #reserveSyntheticNow(dim: DimEntry, field: string, label: string): Promise<number> {
		const existing = this.identity(field).ids.get(label);
		if (existing !== undefined) return existing;

		const dimName = quote(dim.name);
		await this.#exec.exec(
			`INSERT INTO ${dimName} SELECT ${literal(label)}, ` +
				`(SELECT COALESCE(MAX(id), -1) + 1 FROM ${dimName})::INT`
		);
		await this.#refreshValues(field);

		const id = this.identity(field).ids.get(label);
		if (id === undefined) {
			throw new Error(`Reserved "${label}" for "${field}" but it is absent from the dim.`);
		}
		return id;
	}

	async #ensureDimNow(
		dim: DimEntry,
		field: string,
		table: string,
		generation: number
	): Promise<void> {
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
			await this.#exec.exec(
				`CREATE TABLE IF NOT EXISTS ${dimName} AS ` +
					`SELECT value, (ROW_NUMBER() OVER (ORDER BY value) - 1)::INT AS id ` +
					`FROM (SELECT DISTINCT ${expr} AS value FROM ${src} WHERE ${expr} IS NOT NULL)`
			);
			// A second statement: CTAS cannot carry a constraint. `value` is unique
			// by construction here (DISTINCT) and on append (WHERE NOT EXISTS), but
			// reserveSynthetic is a writer that could break it, and a duplicate
			// value does not tie-break — #createView joins ON t.field = d.value, so
			// it FANS OUT every matching source row in every query against the
			// view. Cheap insurance against a future writer forgetting.
			await this.#exec.exec(
				`CREATE UNIQUE INDEX IF NOT EXISTS ${quote(`${dim.name}_value_uq`)} ON ${dimName}(value)`
			);
		} else {
			await this.#exec.exec(
				`INSERT INTO ${dimName} ` +
					`SELECT s.v, ((SELECT COALESCE(MAX(id), -1) FROM ${dimName}) + ` +
					`ROW_NUMBER() OVER (ORDER BY s.v))::INT ` +
					`FROM (SELECT DISTINCT ${expr} AS v FROM ${src} WHERE ${expr} IS NOT NULL) s ` +
					`WHERE NOT EXISTS (SELECT 1 FROM ${dimName} d WHERE d.value = s.v)`
			);
		}

		dim.tables.add(table);
		await this.#refreshValues(field);
	}

	/**
	 * Refuse a band axis with more distinct values than can render (§16.6).
	 *
	 * Runs here rather than in `#fetchFieldStats` — that is a sibling of
	 * `#ensureIdentityColumns` in the same `Promise.all`, so gating one on the
	 * other would serialize two concurrent operations and put a round trip on
	 * the critical path §3.3 protects. Here it costs a query only for fields
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
				`"${field}" has about ${n} distinct values, over the ${MAX_IDENTITY_CARDINALITY} ` +
					`a categorical scale can render. The shared slot buffer holds 16384 ids across ` +
					`every band and point scale on the page. Use a continuous scale, bin the values, ` +
					`or reduce them with a transform.`
			);
		}
		if (n > WARN_IDENTITY_CARDINALITY) {
			console.warn(
				`[identity] "${field}" has about ${n} distinct values; a band axis with more than ` +
					`~${WARN_IDENTITY_CARDINALITY} categories is under a pixel per band on most charts.`
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
	async #refreshValues(field: string): Promise<void> {
		const rows = await this.#exec.queryRows(
			`SELECT id, value FROM ${quote(this.dimTable(field))} ORDER BY id`
		);

		// Ordered by id and dense by construction, so position is the id — and
		// reset() derives value -> id from the same pass, so the two directions
		// cannot disagree.
		this.identity(field).reset(rows.map((row) => row.value as DimValue));
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
			joins.push(`LEFT JOIN ${dimName} ${alias} ON t.${quote(keyCol)} = ${alias}.value`);
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

		const views = [...this.#views.keys()].map((t) => this.viewTable(t));
		const dims = [...this.#dims.values()].map((d) => d.name);
		this.#views.clear();
		this.#dims.clear();
		// In place, so any scale still holding the reference empties with it.
		for (const identity of this.#identities.values()) identity.reset([]);
		this.#identities.clear();

		for (const view of views) {
			await this.#exec.exec(`DROP VIEW IF EXISTS ${quote(view)}`);
		}
		for (const dim of dims) {
			await this.#exec.exec(`DROP TABLE IF EXISTS ${quote(dim)}`);
		}
	}
}
