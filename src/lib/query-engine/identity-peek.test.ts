import { describe, it, expect } from 'vitest';
import { QueryEngine, type DuckDBConnection } from './QueryEngine';

const conn: DuckDBConnection = {
	async query() {
		return [] as never;
	},
	async exec() {},
	async close() {}
} as never;

describe('identity lookups', () => {
	it('names each identity by its key', () => {
		const engine = new QueryEngine(conn);
		expect(engine.identityFor('carrier').key).toBe('carrier');
	});

	it('peekIdentity never creates one, and returns the live one once it exists', () => {
		const engine = new QueryEngine(conn);
		expect(engine.peekIdentity('carrier')).toBeNull();
		const identity = engine.identityFor('carrier');
		expect(engine.peekIdentity('carrier')).toBe(identity);
		expect(engine.peekIdentity('origin')).toBeNull();
	});

	it('peekIdentity returns null again after a reset, until something asks', async () => {
		const engine = new QueryEngine(conn);
		const before = engine.identityFor('carrier');
		await engine.clearQueryCache();
		expect(engine.peekIdentity('carrier')).toBeNull();
		expect(engine.identityFor('carrier')).not.toBe(before);
	});
});
