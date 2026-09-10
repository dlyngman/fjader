/**
 * Integration test: CategoricalIdentity against real DuckDB.
 *
 * Uses native DuckDB (not duckdb-wasm) for fast in-process execution, same as
 * window-correctness.integration.test.ts. The three cases band §13 step 2 calls
 * for — idempotent create, append from a second table, and the mid-flight
 * superset rebuild — all turn on SQL semantics (window functions applied after
 * WHERE, MAX(id) read inside the INSERT), so a mock connection would prove
 * nothing about them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import duckdb from 'duckdb';
import { CategoricalIdentity } from './categorical-identity';

// ---------------------------------------------------------------------------
// DuckDB helper — promise wrapper around the callback API
// ---------------------------------------------------------------------------

interface DB {
	run(sql: string): Promise<void>;
	all(sql: string): Promise<Record<string, unknown>[]>;
	close(): Promise<void>;
}

function openDB(): DB {
	const db = new duckdb.Database(':memory:');
	return {
		run: (sql: string) =>
			new Promise((res, rej) => db.run(sql, (e: Error | null) => (e ? rej(e) : res()))),
		all: (sql: string) =>
			new Promise((res, rej) =>
				db.all(sql, (e: Error | null, rows: Record<string, unknown>[]) => (e ? rej(e) : res(rows)))
			),
		close: () => new Promise((res, rej) => db.close((e: Error | null) => (e ? rej(e) : res())))
	};
}

/** Records every statement, so rebuild counts can be asserted. */
function makeExec(db: DB) {
	const statements: string[] = [];
	return {
		statements,
		async exec(sql: string | string[]) {
			for (const stmt of Array.isArray(sql) ? sql : [sql]) {
				statements.push(stmt);
				await db.run(stmt);
			}
		},
		async queryRows(sql: string) {
			return db.all(sql);
		}
	};
}

const SESSION = 'test01';

describe('CategoricalIdentity', () => {
	let db: DB;
	let exec: ReturnType<typeof makeExec>;
	let identity: CategoricalIdentity;

	beforeEach(async () => {
		db = openDB();
		exec = makeExec(db);
		identity = new CategoricalIdentity(exec, SESSION);

		await db.run(`CREATE TABLE penguins (species VARCHAR, island VARCHAR, mass INT)`);
		await db.run(`INSERT INTO penguins VALUES
			('Gentoo', 'Biscoe', 5000),
			('Adelie', 'Torgersen', 3750),
			('Adelie', 'Biscoe', 3800),
			('Chinstrap', 'Dream', 3700),
			(NULL, 'Dream', 3600)`);
	});

	afterEach(async () => {
		await db.close();
	});

	// -----------------------------------------------------------------------
	// Dim creation
	// -----------------------------------------------------------------------

	it('assigns dense 0-based ids ordered by value, excluding NULL', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });

		const rows = await db.all(
			`SELECT value, id FROM "${identity.dimTable('species')}" ORDER BY id`
		);
		expect(rows).toEqual([
			{ value: 'Adelie', id: 0 },
			{ value: 'Chinstrap', id: 1 },
			{ value: 'Gentoo', id: 2 }
		]);
	});

	it('is idempotent — a repeat request runs no further statements', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });
		const afterFirst = exec.statements.length;

		await identity.ensureColumns('penguins', { categorical: ['species'] });

		expect(exec.statements.length).toBe(afterFirst);
	});

	it('adds a second field without renumbering the first', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });
		const before = await db.all(
			`SELECT value, id FROM "${identity.dimTable('species')}" ORDER BY id`
		);

		await identity.ensureColumns('penguins', { categorical: ['island'] });
		const after = await db.all(
			`SELECT value, id FROM "${identity.dimTable('species')}" ORDER BY id`
		);

		expect(after).toEqual(before);
		expect(identity.columnsFor('penguins').sort()).toEqual(['island', 'species']);
	});

	// -----------------------------------------------------------------------
	// The view
	// -----------------------------------------------------------------------

	it('joins ids onto the source rows and passes the original columns through', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });

		const col = identity.idColumn('species');
		const rows = await db.all(
			`SELECT species, mass, "${col}" AS idx FROM "${identity.sourceFor('penguins')}" ORDER BY mass`
		);

		expect(rows).toEqual([
			{ species: null, mass: 3600, idx: -1 },
			{ species: 'Chinstrap', mass: 3700, idx: 1 },
			{ species: 'Adelie', mass: 3750, idx: 0 },
			{ species: 'Adelie', mass: 3800, idx: 0 },
			{ species: 'Gentoo', mass: 5000, idx: 2 }
		]);
	});

	it('keeps unmatched rows with the -1 sentinel rather than dropping them', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });

		const source = await db.all(`SELECT COUNT(*) AS n FROM penguins`);
		const view = await db.all(`SELECT COUNT(*) AS n FROM "${identity.sourceFor('penguins')}"`);

		// The NULL-species row must survive: LEFT JOIN, not INNER.
		// COUNT(*) comes back as BigInt from native duckdb.
		expect(Number(view[0].n)).toBe(Number(source[0].n));
	});

	it('returns the table itself when no columns were requested', () => {
		expect(identity.sourceFor('penguins')).toBe('penguins');
	});

	it('returns the table itself while the view is still being built', async () => {
		// ensureColumns registers the view entry synchronously, long before the
		// CREATE runs. A sibling mark with no categorical channel never awaits
		// that promise, so anything it asks for in the meantime must name a
		// relation that exists — otherwise its very first query dies with
		// "Catalog Error: Table with name penguins_v_s... does not exist".
		// Two marks on one table, only one with a band axis: /examples/brush-demo.
		const pending = identity.ensureColumns('penguins', { categorical: ['species'] });

		expect(identity.sourceFor('penguins')).toBe('penguins');

		await pending;
		expect(identity.sourceFor('penguins')).toBe(identity.viewTable('penguins'));
	});

	it('keeps naming the base table when a rebuild adds a second field', async () => {
		// A rebuild must not retract the view: the columns already there stay
		// there, so callers mid-flight are still correct to use it.
		await identity.ensureColumns('penguins', { categorical: ['species'] });
		const pending = identity.ensureColumns('penguins', { categorical: ['island'] });

		expect(identity.sourceFor('penguins')).toBe(identity.viewTable('penguins'));

		await pending;
		expect(identity.sourceFor('penguins')).toBe(identity.viewTable('penguins'));
	});

	// -----------------------------------------------------------------------
	// Fixed expressions (§16, #197)
	// -----------------------------------------------------------------------

	it('dims a fixed SQL expression the same way as a column', async () => {
		const expr = `CASE WHEN mass < 3700 THEN 'Light' ELSE 'Heavy' END`;
		await identity.ensureColumns('penguins', { categorical: [{ key: expr, sql: expr }] });

		// Ids are content-addressed per creation: alphabetical over the outputs.
		expect(identity.identity(expr).values).toEqual(['Heavy', 'Light']);

		const rows = await db.all(
			`SELECT mass, "${identity.idColumn(expr)}" AS idx ` +
				`FROM "${identity.sourceFor('penguins')}" ORDER BY mass`
		);
		// masses 3600, 3700, 3750, 3800, 5000 -> only 3600 is under the threshold.
		// The NULL-species row is one of them: the expression classifies it, since
		// it is the expression's value that must be non-null, not the column's.
		expect(rows.map((r) => r.idx)).toEqual([1, 0, 0, 0, 0]);
	});

	it('keys the dim on the expression text, so two spellings do not collide', async () => {
		const a = `upper(species)`;
		const b = `UPPER(species)`;
		await identity.ensureColumns('penguins', { categorical: [{ key: a, sql: a }] });
		await identity.ensureColumns('penguins', { categorical: [{ key: b, sql: b }] });

		// Duplicated work, but each internally consistent — §16.3. The failure to
		// avoid is one scale with two disagreeing dims, not two dims.
		expect(identity.dimTable(a)).not.toBe(identity.dimTable(b));
		expect(identity.identity(a).values).toEqual(identity.identity(b).values);
	});

	it('binds expression columns to the source, not to the dim', async () => {
		// A column literally named `id` collides with the dim's own column if the
		// join evaluates the expression in a scope containing both.
		await db.run(`CREATE TABLE shadowed (id INT, value VARCHAR)`);
		await db.run(`INSERT INTO shadowed VALUES (1, 'a'), (2, 'b'), (3, 'a')`);
		const expr = `CASE WHEN id > 1 THEN 'big' ELSE 'small' END`;

		await identity.ensureColumns('shadowed', { categorical: [{ key: expr, sql: expr }] });

		const rows = await db.all(
			`SELECT id, "${identity.idColumn(expr)}" AS idx FROM "${identity.sourceFor('shadowed')}" ORDER BY id`
		);
		expect(identity.identity(expr).values).toEqual(['big', 'small']);
		expect(rows.map((r) => r.idx)).toEqual([1, 0, 0]);
	});

	it('leaves the view shaped like the source, helper columns excluded', async () => {
		const expr = `CASE WHEN mass < 3700 THEN 'Light' ELSE 'Heavy' END`;
		await identity.ensureColumns('penguins', {
			categorical: ['species', { key: expr, sql: expr }]
		});

		const rows = await db.all(`SELECT * FROM "${identity.sourceFor('penguins')}" LIMIT 1`);
		const cols = Object.keys(rows[0]);
		expect(cols).toEqual(
			expect.arrayContaining(['species', 'island', 'mass', identity.idColumn('species')])
		);
		expect(cols.filter((c) => c.startsWith('__dplot_key_'))).toEqual([]);
	});

	// -----------------------------------------------------------------------
	// Cardinality gate (§16.6)
	// -----------------------------------------------------------------------

	it('refuses a field with more distinct values than can render', async () => {
		await db.run(`CREATE TABLE wide AS SELECT i::VARCHAR AS k FROM range(20000) t(i)`);

		await expect(identity.ensureColumns('wide', { categorical: ['k'] })).rejects.toThrow(
			/distinct values/
		);
		// Refused before the dim exists: a runaway expression never materializes.
		const tables = await db.all(
			`SELECT table_name FROM information_schema.tables WHERE table_name = '${identity.dimTable('k')}'`
		);
		expect(tables).toHaveLength(0);
	});

	it('allows an ordinary categorical without complaint', async () => {
		await expect(
			identity.ensureColumns('penguins', { categorical: ['species'] })
		).resolves.toBeUndefined();
		expect(identity.identity('species').values).toHaveLength(3);
	});

	// -----------------------------------------------------------------------
	// Synthetic ids (§16.9)
	// -----------------------------------------------------------------------

	it('reserves a synthetic id at the top of the space, through the same array', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });
		const held = identity.identity('species');

		const otherId = await identity.reserveSynthetic('species', 'Other');

		// Non-negative — scaleBand discards value < 0 before the slot lookup.
		expect(otherId).toBe(3);
		// Reachable through the ordinary accessor: no consumer branches on it.
		expect(held.values[otherId]).toBe('Other');
		expect(held.ids.get('Other')).toBe(otherId);
	});

	it('reuses the id when a real category already carries the label', async () => {
		await db.run(`CREATE TABLE labelled (species VARCHAR)`);
		await db.run(`INSERT INTO labelled VALUES ('Adelie'), ('Other'), ('Gentoo')`);
		await identity.ensureColumns('labelled', { categorical: ['species'] });

		const before = identity.identity('species').values.length;
		const realId = identity.identity('species').ids.get('Other');

		const otherId = await identity.reserveSynthetic('species', 'Other');

		// No duplicate row: #createView joins ON value, so two rows sharing a
		// value would fan out every matching source row.
		expect(otherId).toBe(realId);
		expect(identity.identity('species').values.length).toBe(before);
		const rows = await db.all(
			`SELECT COUNT(*) AS n FROM "${identity.dimTable('species')}" WHERE value = 'Other'`
		);
		expect(Number(rows[0].n)).toBe(1);
	});

	it('a unique index makes the duplicate structurally impossible', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });
		const dim = identity.dimTable('species');

		// Columns named: the dim carries (value, label, id), and a positional
		// INSERT would fail at the binder before ever reaching the constraint
		// this test is about.
		await expect(
			db.run(`INSERT INTO "${dim}" (value, label, id) VALUES ('Adelie', NULL, 99)`)
		).rejects.toThrow(/[Cc]onstraint|unique/);
	});

	it('an append after a reservation continues past it without renumbering', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });
		const otherId = await identity.reserveSynthetic('species', 'Other');

		await db.run(`CREATE TABLE more_penguins (species VARCHAR)`);
		await db.run(`INSERT INTO more_penguins VALUES ('Emperor')`);
		await identity.ensureColumns('more_penguins', { categorical: ['species'] });

		const held = identity.identity('species');
		expect(held.values[otherId]).toBe('Other');
		expect(held.ids.get('Emperor')).toBe(otherId + 1);
	});

	// -----------------------------------------------------------------------
	// Append from a second table
	// -----------------------------------------------------------------------

	it('appends unseen values from a second table with continuing ids', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });

		await db.run(`CREATE TABLE more_penguins (species VARCHAR)`);
		// Adelie is already known; Emperor and Rockhopper are new.
		await db.run(`INSERT INTO more_penguins VALUES ('Emperor'), ('Adelie'), ('Rockhopper')`);
		await identity.ensureColumns('more_penguins', { categorical: ['species'] });

		const rows = await db.all(
			`SELECT value, id FROM "${identity.dimTable('species')}" ORDER BY id`
		);
		expect(rows).toEqual([
			{ value: 'Adelie', id: 0 },
			{ value: 'Chinstrap', id: 1 },
			{ value: 'Gentoo', id: 2 },
			{ value: 'Emperor', id: 3 },
			{ value: 'Rockhopper', id: 4 }
		]);
	});

	it('shares one dim across tables, so the same value gets the same id', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });
		await db.run(`CREATE TABLE more_penguins (species VARCHAR)`);
		await db.run(`INSERT INTO more_penguins VALUES ('Emperor'), ('Adelie')`);
		await identity.ensureColumns('more_penguins', { categorical: ['species'] });

		const col = identity.idColumn('species');
		const a = await db.all(
			`SELECT "${col}" AS idx FROM "${identity.sourceFor('penguins')}" WHERE species = 'Adelie' LIMIT 1`
		);
		const b = await db.all(
			`SELECT "${col}" AS idx FROM "${identity.sourceFor('more_penguins')}" WHERE species = 'Adelie'`
		);

		expect(a[0].idx).toBe(b[0].idx);
	});

	it('does not duplicate a value already in the dim', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });
		await db.run(`CREATE TABLE more_penguins (species VARCHAR)`);
		await db.run(`INSERT INTO more_penguins VALUES ('Adelie'), ('Adelie'), ('Gentoo')`);
		await identity.ensureColumns('more_penguins', { categorical: ['species'] });

		const rows = await db.all(
			`SELECT value, COUNT(*) AS n FROM "${identity.dimTable('species')}" GROUP BY value HAVING COUNT(*) > 1`
		);
		expect(rows).toEqual([]);
	});

	it('appends correctly when two TABLES register one field concurrently', async () => {
		// The coalescer is per table, so this runs two independent drains against
		// one dim. Without serializing per field they both see tables.size === 0
		// and both take the create branch — the second's CREATE TABLE IF NOT
		// EXISTS is a silent no-op and its categories never reach the dim.
		// Caught in the browser on /test/band-identity chart 5: Emperor vanished.
		await db.run(`CREATE TABLE more_penguins (species VARCHAR)`);
		await db.run(`INSERT INTO more_penguins VALUES ('Emperor')`);

		await Promise.all([
			identity.ensureColumns('penguins', { categorical: ['species'] }),
			identity.ensureColumns('more_penguins', { categorical: ['species'] })
		]);

		const values = (
			await db.all(`SELECT value FROM "${identity.dimTable('species')}" ORDER BY id`)
		).map((r) => r.value);
		expect(values).toContain('Emperor');
		expect(values).toHaveLength(4);

		// And ids stay dense with no duplicates, whichever table won the race.
		const ids = (await db.all(`SELECT id FROM "${identity.dimTable('species')}" ORDER BY id`)).map(
			(r) => Number(r.id)
		);
		expect(ids).toEqual([0, 1, 2, 3]);
	});

	it('both views resolve ids for a concurrently-registered shared field', async () => {
		await db.run(`CREATE TABLE more_penguins (species VARCHAR)`);
		await db.run(`INSERT INTO more_penguins VALUES ('Emperor')`);

		await Promise.all([
			identity.ensureColumns('penguins', { categorical: ['species'] }),
			identity.ensureColumns('more_penguins', { categorical: ['species'] })
		]);

		const col = identity.idColumn('species');
		const emperor = await db.all(
			`SELECT "${col}" AS idx FROM "${identity.sourceFor('more_penguins')}"`
		);
		// -1 would mean the row exists but has no identity — the sentinel, not a
		// crash, which is how this would otherwise reach the GPU.
		expect(emperor[0].idx).not.toBe(-1);
		expect(identity.values('species')[emperor[0].idx as number]).toBe('Emperor');
	});

	// -----------------------------------------------------------------------
	// The coalescer
	// -----------------------------------------------------------------------

	it('coalesces concurrent callers into one view build', async () => {
		await Promise.all([
			identity.ensureColumns('penguins', { categorical: ['species'] }),
			identity.ensureColumns('penguins', { categorical: ['island'] }),
			identity.ensureColumns('penguins', { categorical: ['species', 'island'] })
		]);

		const views = exec.statements.filter((s) => s.includes('CREATE OR REPLACE VIEW'));
		expect(views.length).toBe(1);
		expect(identity.columnsFor('penguins').sort()).toEqual(['island', 'species']);
	});

	it('every concurrent caller can use the columns it asked for once it resolves', async () => {
		await Promise.all([
			identity.ensureColumns('penguins', { categorical: ['species'] }),
			identity.ensureColumns('penguins', { categorical: ['island'] })
		]);

		const rows = await db.all(
			`SELECT "${identity.idColumn('species')}" AS s, "${identity.idColumn('island')}" AS i ` +
				`FROM "${identity.sourceFor('penguins')}" LIMIT 1`
		);
		expect(rows[0].s).toBeTypeOf('number');
		expect(rows[0].i).toBeTypeOf('number');
	});

	it('rebuilds once more for a request arriving mid-flight, as a superset', async () => {
		// Start the first build and let it get past the microtask deferral into
		// real I/O, so the second call is genuinely "during a rebuild" rather than
		// same-tick — that is the case that costs one extra pass by design.
		const first = identity.ensureColumns('penguins', { categorical: ['species'] });
		await new Promise((r) => setTimeout(r, 0));
		const second = identity.ensureColumns('penguins', { categorical: ['island'] });
		await Promise.all([first, second]);

		const views = exec.statements.filter((s) => s.includes('CREATE OR REPLACE VIEW'));
		expect(views.length).toBe(2);
		// The second must be a SUPERSET, not a replacement that drops the first
		// field — the view is CREATE OR REPLACE, so a non-superset silently
		// removes a column other marks are already querying.
		expect(views[1]).toContain(identity.idColumn('species'));
		expect(views[1]).toContain(identity.idColumn('island'));
	});

	it('a caller asking only for present fields still awaits an in-flight rebuild', async () => {
		const build = identity.ensureColumns('penguins', { categorical: ['species'] });
		// Same field, while the first build is still running.
		const piggyback = identity.ensureColumns('penguins', { categorical: ['species'] });
		await Promise.all([build, piggyback]);

		// The view must exist by the time the second promise resolves.
		const rows = await db.all(`SELECT COUNT(*) AS n FROM "${identity.sourceFor('penguins')}"`);
		expect(Number(rows[0].n)).toBe(5);
	});

	// -----------------------------------------------------------------------
	// Labels (§9.4)
	// -----------------------------------------------------------------------

	it('exposes values indexed by id', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });
		expect(identity.values('species')).toEqual(['Adelie', 'Chinstrap', 'Gentoo']);
	});

	it('grows the SAME array in place when a second table appends', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });
		// A scale takes the reference at its own setup, before the second table
		// exists. §9.4: a snapshot here is what breaks, and only in multi-table
		// charts — ids from the later table index past the end of the copy.
		const held = identity.values('species');

		await db.run(`CREATE TABLE more_penguins (species VARCHAR)`);
		await db.run(`INSERT INTO more_penguins VALUES ('Emperor')`);
		await identity.ensureColumns('more_penguins', { categorical: ['species'] });

		expect(held).toBe(identity.values('species'));
		expect(held).toEqual(['Adelie', 'Chinstrap', 'Gentoo', 'Emperor']);
	});

	it('owns both directions of the bijection, and they agree', async () => {
		// §17.2: the reverse map used to be rebuilt per scale, with a
		// length-based self-heal because the array it mirrored was live and owned
		// elsewhere. One writer now rewrites both in a single pass.
		await identity.ensureColumns('penguins', { categorical: ['species'] });

		const fi = identity.identity('species');
		expect(fi.values).toEqual(['Adelie', 'Chinstrap', 'Gentoo']);
		for (let id = 0; id < fi.values.length; id++) {
			expect(fi.ids.get(fi.values[id])).toBe(id);
		}
		expect(fi.ids.size).toBe(fi.values.length);
	});

	it('grows both directions together when a second table appends', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });
		// Adopted before the second table exists, as a scale does at setup.
		const held = identity.identity('species');
		expect(held.ids.get('Emperor')).toBeUndefined();

		await db.run(`CREATE TABLE more_penguins (species VARCHAR)`);
		await db.run(`INSERT INTO more_penguins VALUES ('Emperor')`);
		await identity.ensureColumns('more_penguins', { categorical: ['species'] });

		// Same object, both directions extended — no staleness test anywhere.
		expect(held).toBe(identity.identity('species'));
		expect(held.values[3]).toBe('Emperor');
		expect(held.ids.get('Emperor')).toBe(3);
		expect(held.ids.size).toBe(held.values.length);
	});

	it('labels stay aligned with the ids in the view', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });
		const labels = identity.values('species');

		const rows = await db.all(
			`SELECT species, "${identity.idColumn('species')}" AS idx ` +
				`FROM "${identity.sourceFor('penguins')}" WHERE species IS NOT NULL`
		);
		for (const row of rows) {
			expect(labels[row.idx as number]).toBe(row.species);
		}
	});

	// -----------------------------------------------------------------------
	// Reset
	// -----------------------------------------------------------------------

	it('reset drops views and dims and forgets state', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });
		const dimName = identity.dimTable('species');

		await identity.reset();

		expect(identity.sourceFor('penguins')).toBe('penguins');
		expect(identity.columnsFor('penguins')).toEqual([]);
		const tables = await db.all(
			`SELECT table_name FROM information_schema.tables WHERE table_name = '${dimName}'`
		);
		expect(tables).toEqual([]);
	});

	it('rebuilds from scratch after reset, renumbering against current data', async () => {
		await identity.ensureColumns('penguins', { categorical: ['species'] });
		await identity.reset();

		// Simulate a data reload that removes a category.
		await db.run(`DELETE FROM penguins WHERE species = 'Adelie'`);
		await identity.ensureColumns('penguins', { categorical: ['species'] });

		const rows = await db.all(
			`SELECT value, id FROM "${identity.dimTable('species')}" ORDER BY id`
		);
		expect(rows).toEqual([
			{ value: 'Chinstrap', id: 0 },
			{ value: 'Gentoo', id: 1 }
		]);
	});

	// -----------------------------------------------------------------------
	// Naming
	// -----------------------------------------------------------------------

	it('keeps bare identifiers clean and disambiguates the rest', () => {
		expect(identity.idColumn('species')).toBe('__dplot_species_idx');

		// Both sanitize to the same token, so they must not share a dim.
		expect(identity.idColumn('a.b')).not.toBe(identity.idColumn('a-b'));
		expect(identity.dimTable('a.b')).not.toBe(identity.dimTable('a-b'));
	});

	it('names an expression key by hash, so identifiers stay short', () => {
		// Sanitizing the text instead gave 150+ characters for this expression,
		// growing without bound with the expression itself.
		const expr = `CASE WHEN mass < 3700 THEN 'Light'
		                   WHEN mass < 4500 THEN 'Medium'
		                   ELSE 'Heavy' END`;
		expect(identity.idColumn(expr).length).toBeLessThan(32);
		expect(identity.dimTable(expr).length).toBeLessThan(40);

		// Still keyed on the exact text: whitespace differences are different
		// fields, which §16.3 accepts as duplicated-but-correct.
		expect(identity.idColumn(expr)).not.toBe(identity.idColumn(expr.replace(/\s+/g, ' ')));
	});

	it('handles a field name needing sanitization end to end', async () => {
		await db.run(`CREATE TABLE odd ("my field" VARCHAR)`);
		await db.run(`INSERT INTO odd VALUES ('x'), ('y')`);

		await identity.ensureColumns('odd', { categorical: ['my field'] });

		const rows = await db.all(
			`SELECT "${identity.idColumn('my field')}" AS idx FROM "${identity.sourceFor('odd')}" ORDER BY idx`
		);
		expect(rows).toEqual([{ idx: 0 }, { idx: 1 }]);
	});

	describe('cardinality is a property of the dim, not of one table', () => {
		// §20.4 B. The pre-flight check runs approx_count_distinct against a single
		// source table, but the dim spans every table that registers the field, and
		// the dim is what sizes the slot table. Two tables under the limit
		// individually can union to a dim over it.

		it('refuses when a second table pushes the dim over the limit', async () => {
			await exec.exec(`CREATE TABLE lo AS SELECT 'a' || i AS k FROM range(6000) t(i)`);
			await exec.exec(`CREATE TABLE hi AS SELECT 'b' || i AS k FROM range(6000) t(i)`);

			// Each table on its own is comfortably under MAX_IDENTITY_CARDINALITY.
			await identity.ensureColumns('lo', { categorical: ['k'] });
			expect(identity.values('k').length).toBe(6000);

			// Together they are not. The pre-flight cannot see this; the dim size can.
			await expect(identity.ensureColumns('hi', { categorical: ['k'] })).rejects.toThrow(
				/across every table registering it/
			);
		});

		it('names the page-wide buffer budget only in the dim-size refusal', async () => {
			await exec.exec(`CREATE TABLE huge AS SELECT 'v' || i AS k FROM range(12000) t(i)`);

			// The single-table pre-flight fires first here, and it must NOT claim the
			// shared-buffer reasoning — it has only looked at one table.
			await expect(identity.ensureColumns('huge', { categorical: ['k'] })).rejects.toThrow(
				/distinct values in this table/
			);
		});
	});

	describe('dim id order and colour domain order', () => {
		// The SQL stack path orders its cumulative window by the series channel,
		// which since `58b0023` carries a dim id. Its comment claims that
		// reproduces the legend's stacking order "for free". That is true only
		// because TWO independent orderings agree:
		//
		//   the dim   ROW_NUMBER() OVER (ORDER BY value)      -> ids
		//   the scale SELECT DISTINCT color ORDER BY color    -> legend order
		//
		// Nothing enforces the agreement, and nothing would fail if it broke —
		// the chart would simply stack in a different order than it lists. These
		// pin it, so whoever changes either side gets a failure instead.

		beforeEach(async () => {
			// Deliberately not inserted in alphabetical order: if either side
			// happened to use insertion order, that would look correct here.
			await db.run(`CREATE TABLE sales (grade VARCHAR)`);
			await db.run(`INSERT INTO sales VALUES ('medium'), ('high'), ('low'), ('high')`);
		});

		it('assigns ids in the same order the colour domain is fetched in', async () => {
			await identity.ensureColumns('sales', { categorical: ['grade'] });
			const ids = identity.identity('grade').ids;

			// Exactly the query domain-queries runs for an ordinal colour scale.
			const domain = (await db.all(`SELECT DISTINCT grade FROM sales ORDER BY grade`)).map(
				(r) => r.grade as string
			);

			const idsInDomainOrder = domain.map((v) => ids.get(v)!);
			expect(idsInDomainOrder).toEqual([...idsInDomainOrder].sort((a, b) => a - b));
			expect(idsInDomainOrder).toEqual([0, 1, 2]);
		});

		it('DIVERGES once a second table appends to the dim', async () => {
			// The known limit, pinned as behaviour rather than left to be
			// discovered. The dim is append-only, so a second table's new
			// categories get ids AFTER every existing one instead of interleaving
			// alphabetically. A stacked mark on that table then orders by
			// insertion epoch, not by its legend.
			await identity.ensureColumns('sales', { categorical: ['grade'] });
			await db.run(`CREATE TABLE sales2 AS SELECT * FROM (VALUES ('critical'), ('low')) t(grade)`);
			await identity.ensureColumns('sales2', { categorical: ['grade'] });

			const ids = identity.identity('grade').ids;
			const domain = (await db.all(`SELECT DISTINCT grade FROM sales2 ORDER BY grade`)).map(
				(r) => r.grade as string
			);

			// 'critical' sorts first but was appended last, so domain order and
			// id order disagree. If this ever starts passing as ascending, the
			// dim stopped being append-only and §9.2's invariant is gone.
			const idsInDomainOrder = domain.map((v) => ids.get(v)!);
			expect(idsInDomainOrder).not.toEqual([...idsInDomainOrder].sort((a, b) => a - b));
			expect(ids.get('critical')).toBeGreaterThan(ids.get('low')!);
		});
	});

	it('keeps refusing an oversized dim, rather than only the first time', async () => {
		// The refusal used to fire exactly once: it threw AFTER marking the table
		// done, so a mark re-running setup hit `tables.has(table)`, returned
		// early, and rendered against the dim that had just been rejected.
		await db.run(`CREATE TABLE huge AS SELECT i::VARCHAR AS c FROM range(10001) t(i)`);

		await expect(identity.ensureColumns('huge', { categorical: ['c'] })).rejects.toThrow(
			/distinct values across every table/
		);
		// The retry is the case that regressed. Same error, not a silent pass.
		await expect(identity.ensureColumns('huge', { categorical: ['c'] })).rejects.toThrow(
			/distinct values across every table/
		);
	});

	it('refuses a second, smaller table on a dim that was already refused', async () => {
		// What the docstring always claimed: the dim IS too big, so inheriting it
		// must fail regardless of which table asks next.
		await db.run(`CREATE TABLE huge2 AS SELECT i::VARCHAR AS c2 FROM range(10001) t(i)`);
		await db.run(`CREATE TABLE tiny2 AS SELECT 'a' AS c2`);

		await expect(identity.ensureColumns('huge2', { categorical: ['c2'] })).rejects.toThrow();
		await expect(identity.ensureColumns('tiny2', { categorical: ['c2'] })).rejects.toThrow(
			/distinct values across every table/
		);
	});
});
