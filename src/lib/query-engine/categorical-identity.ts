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
 * Nothing here is reactive. Nothing reads these columns yet — that is band
 * step 3, which switches each scale kind over one at a time.
 */

/** The subset of QueryEngine this module needs. Keeps it testable in isolation. */
export interface IdentityExec {
	exec(sql: string | string[]): Promise<void>;
	/** Rows as plain objects. Callers adapt whatever their driver returns. */
	queryRows(sql: string): Promise<Array<Record<string, unknown>>>;
}

interface DimEntry {
	/** Fully-qualified dim table name, without quotes. */
	name: string;
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
 * A field that is already a bare identifier is used as-is, so the common case
 * reads cleanly in a query plan (`__dplot_species_idx`). Anything else is
 * sanitized *and* suffixed with a hash of the original, because sanitizing
 * alone maps `a.b` and `a-b` onto the same name — two fields silently sharing
 * one dim, which is the wrong-data class of failure rather than a crash.
 *
 * The residual collision (a field literally named `a_b_<hash of "a.b">`) is
 * left unhandled as adversarial.
 */
function identityToken(field: string): string {
	const sanitized = field.replace(/[^A-Za-z0-9_]/g, '_');
	return sanitized === field ? field : `${sanitized}_${shortHash(field)}`;
}

export class CategoricalIdentity {
	#exec: IdentityExec;
	#session: string;
	#dims = new Map<string, DimEntry>();
	#views = new Map<string, ViewEntry>();
	/**
	 * One value array per FIELD, indexed by id. §9.4.
	 *
	 * These are the dim's source values — the decode side of the string -> id
	 * encode this module performed — NOT display labels. Formatting them for an
	 * axis (dates, number formats, truncation) is presentation and stays in the
	 * scale/axis layer.
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
	#values = new Map<string, string[]>();

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
	 * columns have been requested for it. Callers substitute this for the table
	 * name; a table with no categorical channels is untouched.
	 */
	sourceFor(table: string): string {
		return this.#views.has(table) ? this.viewTable(table) : table;
	}

	/**
	 * Dim values for `field`, indexed by id — `values(f)[id]` is the source
	 * value. The live array, not a copy: hold the reference rather than
	 * snapshotting it. Empty until the field's dim has been built.
	 */
	values(field: string): string[] {
		let arr = this.#values.get(field);
		if (!arr) {
			arr = [];
			this.#values.set(field, arr);
		}
		return arr;
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
	async ensureColumns(table: string, fields: { categorical?: string[] }): Promise<void> {
		const categorical = fields.categorical ?? [];
		if (categorical.length === 0) return;

		let entry = this.#views.get(table);
		if (!entry) {
			entry = { current: new Set(), pending: new Set(), inflight: null };
			this.#views.set(table, entry);
		}

		for (const field of categorical) {
			if (!entry.current.has(field)) entry.pending.add(field);
		}

		// Nothing new. Still await any rebuild in flight, so a caller that asked
		// only for already-present fields does not race ahead of the CREATE OR
		// REPLACE that a concurrent caller is running against the same view.
		if (entry.pending.size === 0) {
			if (entry.inflight) await entry.inflight;
			return;
		}

		if (!entry.inflight) {
			// Yield one microtask before reading `pending`. Every mark on a chart
			// calls this from the same Promise.all, so they all run synchronously up
			// to their first await — starting the drain immediately would let the
			// first caller claim the batch alone and charge the others a second
			// rebuild each. Deferring lets one tick's worth of callers accumulate
			// into a single CREATE OR REPLACE VIEW. Callers arriving later, after
			// real I/O has begun, are the "during a rebuild" case and still cost
			// exactly one more pass.
			entry.inflight = Promise.resolve().then(() => this.#drain(table, entry));
		}
		return entry.inflight;
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
	async #drain(table: string, entry: ViewEntry): Promise<void> {
		try {
			while (entry.pending.size > 0) {
				const batch = [...entry.pending];
				entry.pending.clear();

				for (const field of batch) {
					await this.#ensureDim(field, table);
				}

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
	#ensureDim(field: string, table: string): Promise<void> {
		let dim = this.#dims.get(field);
		if (!dim) {
			dim = { name: this.dimTable(field), tables: new Set(), chain: Promise.resolve() };
			this.#dims.set(field, dim);
		}

		// Queue behind any work already running on this dim, so the next caller
		// observes the completed `tables` set and takes the append branch. The
		// stored chain swallows rejections so one failure does not poison every
		// later append; the returned promise still rejects for this caller.
		const next = dim.chain.then(() => this.#ensureDimNow(dim!, field, table));
		dim.chain = next.catch(() => {});
		return next;
	}

	async #ensureDimNow(dim: DimEntry, field: string, table: string): Promise<void> {
		if (dim.tables.has(table)) return;

		const dimName = quote(dim.name);
		const src = quote(table);
		const col = quote(field);

		if (dim.tables.size === 0) {
			await this.#exec.exec(
				`CREATE TABLE IF NOT EXISTS ${dimName} AS ` +
					`SELECT value, (ROW_NUMBER() OVER (ORDER BY value) - 1)::INT AS id ` +
					`FROM (SELECT DISTINCT ${src}.${col} AS value FROM ${src} WHERE ${src}.${col} IS NOT NULL)`
			);
		} else {
			await this.#exec.exec(
				`INSERT INTO ${dimName} ` +
					`SELECT s.v, ((SELECT COALESCE(MAX(id), -1) FROM ${dimName}) + ` +
					`ROW_NUMBER() OVER (ORDER BY s.v))::INT ` +
					`FROM (SELECT DISTINCT ${src}.${col} AS v FROM ${src} WHERE ${src}.${col} IS NOT NULL) s ` +
					`WHERE NOT EXISTS (SELECT 1 FROM ${dimName} d WHERE d.value = s.v)`
			);
		}

		dim.tables.add(table);
		await this.#refreshValues(field);
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

		const arr = this.values(field);
		arr.length = 0;
		for (const row of rows) {
			// Ids are dense and 0-based by construction, so position is the id.
			arr.push(row.value as string);
		}
	}

	/** CREATE OR REPLACE the view with an id column for every field in `all`. */
	async #createView(table: string, all: string[]): Promise<void> {
		const src = quote(table);
		const joins: string[] = [];
		const columns: string[] = [];

		all.forEach((field, i) => {
			const alias = `d${i}`;
			const dimName = quote(this.#dims.get(field)!.name);
			columns.push(`COALESCE(${alias}.id, -1) AS ${quote(this.idColumn(field))}`);
			joins.push(`LEFT JOIN ${dimName} ${alias} ON t.${quote(field)} = ${alias}.value`);
		});

		await this.#exec.exec(
			`CREATE OR REPLACE VIEW ${quote(this.viewTable(table))} AS ` +
				`SELECT t.*, ${columns.join(', ')} FROM ${src} t ${joins.join(' ')}`
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
	async reset(): Promise<void> {
		const views = [...this.#views.keys()].map((t) => this.viewTable(t));
		const dims = [...this.#dims.values()].map((d) => d.name);
		this.#views.clear();
		this.#dims.clear();
		// In place, so any scale still holding the reference empties with it.
		for (const arr of this.#values.values()) arr.length = 0;
		this.#values.clear();

		for (const view of views) {
			await this.#exec.exec(`DROP VIEW IF EXISTS ${quote(view)}`);
		}
		for (const dim of dims) {
			await this.#exec.exec(`DROP TABLE IF EXISTS ${quote(dim)}`);
		}
	}
}
