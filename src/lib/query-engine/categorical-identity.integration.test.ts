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

	it('handles a field name needing sanitization end to end', async () => {
		await db.run(`CREATE TABLE odd ("my field" VARCHAR)`);
		await db.run(`INSERT INTO odd VALUES ('x'), ('y')`);

		await identity.ensureColumns('odd', { categorical: ['my field'] });

		const rows = await db.all(
			`SELECT "${identity.idColumn('my field')}" AS idx FROM "${identity.sourceFor('odd')}" ORDER BY idx`
		);
		expect(rows).toEqual([{ idx: 0 }, { idx: 1 }]);
	});
});
