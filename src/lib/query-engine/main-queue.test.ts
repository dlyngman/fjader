import { describe, it, expect, vi, afterEach } from 'vitest';
import { MainQueue, type StatementRank } from './main-queue';

/** A queue with a manual clock, recording the order statements start in. */
function setup(cap = 1, maxWaitMs = 100, holding: () => boolean = () => true) {
	let now = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => now);
	const started: string[] = [];
	const ranks: Record<string, StatementRank> = {};
	const dropped: string[] = [];
	let grants = 0;
	const queue = new MainQueue(cap, maxWaitMs, () => grants++, holding);
	const send = (
		sql: string,
		rank: StatementRank,
		more: { signal?: AbortSignal; order?: number } = {}
	) =>
		queue.enqueue({
			sql,
			rank,
			...more,
			start: (r) => {
				started.push(sql);
				ranks[sql] = r;
			},
			drop: () => dropped.push(sql)
		});
	return {
		queue,
		send,
		started,
		ranks,
		dropped,
		grants: () => grants,
		advance: (ms: number) => (now += ms),
		/** Release the slot of what is running, the next starting at once. */
		next: () => queue.release()
	};
}

afterEach(() => vi.restoreAllMocks());

describe('MainQueue', () => {
	it('starts a statement at once while a slot is free, and holds the rest', () => {
		const q = setup();
		q.send('a', 2);
		q.send('b', 0);
		expect(q.started).toEqual(['a']);
		expect(q.queue.waiting).toBe(1);
		q.next();
		expect(q.started).toEqual(['a', 'b']);
	});

	it('starts the next synchronously inside release, after counting it busy', () => {
		const q = setup();
		q.send('a', 2);
		q.send('b', 2);
		expect(q.grants()).toBe(1);
		q.next();
		// No await between: the worker gets b before the caller of release goes on.
		expect(q.started).toEqual(['a', 'b']);
		expect(q.grants()).toBe(2);
	});

	it('goes by rank, first come first served within one', () => {
		const q = setup();
		q.send('running', 2);
		q.send('re-query 1', 2);
		q.send('first read 1', 1);
		q.send('setup 1', 0);
		q.send('first read 2', 1);
		q.send('setup 2', 0);
		q.send('background', 3);
		for (let i = 0; i < 6; i++) q.next();
		expect(q.started).toEqual([
			'running',
			'setup 1',
			'setup 2',
			'first read 1',
			'first read 2',
			're-query 1',
			'background'
		]);
	});

	it('holds as many as the cap on the connection', () => {
		const q = setup(2);
		q.send('a', 2);
		q.send('b', 2);
		q.send('c', 0);
		expect(q.started).toEqual(['a', 'b']);
		q.next();
		expect(q.started).toEqual(['a', 'b', 'c']);
	});

	describe('the maximum wait', () => {
		it('raises ranks 2 and 3 one rank per wait', () => {
			const q = setup();
			q.send('running', 0);
			q.send('background', 3);
			q.advance(100);
			q.send('re-query', 2);
			// background has waited one limit: 2, and it came first.
			q.next();
			expect(q.started.at(-1)).toBe('background');
			expect(q.ranks['background']).toBe(2);
		});

		it('rises at most to rank 1: a long-waiting read never overtakes setup', () => {
			const q = setup();
			q.send('running', 0);
			q.send('lod count', 2);
			q.advance(10_000);
			q.send('setup', 0);
			q.next();
			expect(q.started.at(-1)).toBe('setup');
			q.next();
			expect(q.ranks['lod count']).toBe(1);
		});

		it('a risen read takes its place in rank 1 by when it was queued', () => {
			const q = setup();
			q.send('running', 0);
			q.send('first read, mounted at 5', 1, { order: 5 });
			q.advance(50);
			q.send('lod count', 2);
			q.advance(200);
			q.send('first read, mounted at 500', 1, { order: 500 });
			q.next();
			q.next();
			q.next();
			// Risen to 1, queued at 50: after the mark mounted at 5, before the one at 500.
			expect(q.started).toEqual([
				'running',
				'first read, mounted at 5',
				'lod count',
				'first read, mounted at 500'
			]);
		});

		it('never raises a first read: setup still goes ahead of it however long it waited', () => {
			const q = setup();
			q.send('running', 1);
			q.send('first read', 1);
			q.advance(10_000);
			q.send('setup', 0);
			q.next();
			expect(q.started).toEqual(['running', 'setup']);
			q.next();
			expect(q.ranks['first read']).toBe(1);
		});
	});

	it('loads first reads in mount order, not queue order', () => {
		const q = setup();
		q.send('running', 0);
		q.send('chart 4', 1, { order: 40 });
		q.send('chart 5', 1, { order: 50 });
		// A categorical chart mounted second: its read comes after its chain.
		q.send('chart 2', 1, { order: 20 });
		for (let i = 0; i < 3; i++) q.next();
		expect(q.started).toEqual(['running', 'chart 2', 'chart 4', 'chart 5']);
	});

	describe('holding', () => {
		it('sends at once, past the cap, while not holding', () => {
			const q = setup(1, 100, () => false);
			q.send('a', 1);
			q.send('b', 1);
			q.send('c', 0);
			expect(q.started).toEqual(['a', 'b', 'c']);
			expect(q.queue.waiting).toBe(0);
		});

		it('once something is queued, drains at the cap after holding ends', () => {
			let holding = true;
			const q = setup(1, 100, () => holding);
			q.send('running', 0);
			q.send('chart 4', 1, { order: 40 });
			holding = false;
			// The drain ended; the chain's read still queues behind the held ones, in order.
			q.send('chart 2', 1, { order: 20 });
			expect(q.started).toEqual(['running']);
			q.next();
			q.next();
			expect(q.started).toEqual(['running', 'chart 2', 'chart 4']);
			// Queue empty: the window is over, nothing is held.
			q.send('x', 2);
			q.send('y', 2);
			expect(q.started.slice(-2)).toEqual(['x', 'y']);
		});
	});

	it('drops a statement aborted while queued, without spending a slot', () => {
		const q = setup();
		const controller = new AbortController();
		q.send('running', 2);
		q.send('cancelled', 2, { signal: controller.signal });
		q.send('next', 2);
		controller.abort();
		q.next();
		expect(q.dropped).toEqual(['cancelled']);
		expect(q.started).toEqual(['running', 'next']);
	});

	it('clear drops everything queued', () => {
		const q = setup();
		q.send('running', 2);
		q.send('a', 2);
		q.send('b', 0);
		q.queue.clear(new Error('destroyed'));
		expect(q.dropped).toEqual(['a', 'b']);
		expect(q.queue.waiting).toBe(0);
	});

	describe('barriers', () => {
		it('a DROP does not overtake a read queued before it that names the relation', () => {
			const q = setup();
			q.send('running', 2);
			q.send('SELECT x FROM "view_t"', 2);
			q.send('DROP VIEW IF EXISTS "view_t"', 0);
			q.next();
			q.next();
			expect(q.started).toEqual([
				'running',
				'SELECT x FROM "view_t"',
				'DROP VIEW IF EXISTS "view_t"'
			]);
		});

		it('a DROP still overtakes reads of other relations', () => {
			const q = setup();
			q.send('running', 2);
			q.send('SELECT x FROM other', 2);
			q.send('DROP TABLE IF EXISTS t', 0);
			q.next();
			expect(q.started.at(-1)).toBe('DROP TABLE IF EXISTS t');
		});

		it('a write of a TEMP table does not overtake a queued drop of the same name', () => {
			const q = setup();
			q.send('running', 2);
			// The previous lifecycle's drop (background), then the new write (hover).
			q.send('DROP TABLE IF EXISTS "tip_1"', 3);
			q.send('CREATE TEMP TABLE "tip_1" (a INT)', 0);
			q.next();
			q.next();
			expect(q.started).toEqual([
				'running',
				'DROP TABLE IF EXISTS "tip_1"',
				'CREATE TEMP TABLE "tip_1" (a INT)'
			]);
		});

		it('a read queued after a CREATE of what it reads does not overtake it', () => {
			const q = setup();
			q.send('running', 2);
			q.send('CREATE OR REPLACE VIEW v AS SELECT 1', 3);
			q.send('SELECT * FROM v', 0);
			q.next();
			expect(q.started.at(-1)).toBe('CREATE OR REPLACE VIEW v AS SELECT 1');
		});

		it('barriers keep send order among themselves: dims drop after the view their reads wait on', () => {
			const q = setup();
			q.send('running', 2);
			// A data read of the identity view; the reset then drops the view and its dims.
			q.send('SELECT * FROM "__dplot_t_view_abc"', 2);
			q.send('DROP VIEW IF EXISTS "__dplot_t_view_abc"', 0);
			q.send('DROP TABLE IF EXISTS "__dplot_dim_cat_abc"', 0);
			for (let i = 0; i < 3; i++) q.next();
			expect(q.started).toEqual([
				'running',
				'SELECT * FROM "__dplot_t_view_abc"',
				'DROP VIEW IF EXISTS "__dplot_t_view_abc"',
				'DROP TABLE IF EXISTS "__dplot_dim_cat_abc"'
			]);
		});

		it('matches names case-insensitively', () => {
			const q = setup();
			q.send('running', 2);
			q.send('SELECT * FROM flights', 2);
			q.send('DROP TABLE Flights', 0);
			q.next();
			expect(q.started.at(-1)).toBe('SELECT * FROM flights');
		});

		it('takes the names it is given when the text does not say (an Arrow insert)', () => {
			const q = setup();
			q.send('running', 2);
			q.send('SELECT * FROM t', 2);
			q.queue.enqueue({
				sql: 'INSERT ARROW INTO "t" (8 bytes)',
				rank: 0,
				barrier: ['t'],
				start: () => q.started.push('insert'),
				drop: () => {}
			});
			q.next();
			expect(q.started.at(-1)).toBe('SELECT * FROM t');
		});
	});
});
