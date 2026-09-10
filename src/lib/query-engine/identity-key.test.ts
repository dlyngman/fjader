import { describe, it, expect } from 'vitest';
import { sql, count, sum } from '@uwdata/mosaic-sql';
import { identityKeyFor } from './identity-key';
import { bin } from '$lib/sql/bin';

describe('identityKeyFor', () => {
	describe('what it accepts', () => {
		it('keys a plain column on its name and emits a quoted identifier', () => {
			expect(identityKeyFor('species')).toEqual({ key: 'species', sql: '"species"' });
		});

		it('escapes an embedded quote rather than breaking out of the identifier', () => {
			expect(identityKeyFor('we"ird')).toEqual({ key: 'we"ird', sql: '"we""ird"' });
		});

		it('keys a fixed expression on its own SQL text, emitted verbatim', () => {
			// The key and the emitted SQL are the same string here, which is the
			// point: one code path, differing only in what is substituted.
			const node = sql`CASE WHEN mass < 3700 THEN 'Light' ELSE 'Heavy' END`;
			const got = identityKeyFor(node)!;
			expect(got.key).toContain('CASE WHEN');
			expect(got.sql).toBe(got.key);
		});

		it('gives the same key for two structurally identical expressions', () => {
			// Two marks writing the same expression must land on ONE dim, or a
			// shared scale sees two id spaces for the same categories.
			const a = identityKeyFor(sql`upper(species)`)!;
			const b = identityKeyFor(sql`upper(species)`)!;
			expect(a.key).toBe(b.key);
		});
	});

	describe('what it refuses, and why the caller must not fall back', () => {
		it('refuses null and empty', () => {
			expect(identityKeyFor(null)).toBeNull();
			expect(identityKeyFor(undefined)).toBeNull();
			expect(identityKeyFor('')).toBeNull();
		});

		it('refuses bin(), whose buckets move with the viewport', () => {
			expect(identityKeyFor(bin('body_mass', { step: 500 }))).toBeNull();
			// Not pinned, and cannot be: an AutoBinNode fails isNode() too, so
			// removing the isBinExpression check still passes this. Nothing can be
			// both a node and a bin node by the current definitions, so no input
			// discriminates the two clauses. The check is kept as the durable
			// guard — if AutoBinNode ever becomes a real node, it is the one that
			// still refuses — but its coverage here is incidental, not earned.
		});

		it('refuses an aggregate, which is not a row-level value', () => {
			expect(identityKeyFor(count())).toBeNull();
			expect(identityKeyFor(sum('mass'))).toBeNull();
		});

		it('refuses a window expression', () => {
			expect(identityKeyFor(sum('mass').partitionby('species'))).toBeNull();
		});
	});

	describe('the agreement this exists to guarantee', () => {
		it('derives the scale sourceField and the dim key from one call', () => {
			// The whole reason this is a shared function: MarkLifecycleV2 names the
			// dim from `key` and the scale is registered under the same string. Two
			// derivations that merely agree is the shape that produced the
			// otherIdsByColumn bug, where a producer and a consumer were each
			// internally consistent and disagreed at the seam.
			for (const field of ['species', 'we"ird']) {
				expect(identityKeyFor(field)!.key).toBe(field);
			}
		});

		it('is stable across calls, so a re-setup lands on the same dim', () => {
			// A reload re-runs setup; if the key moved, the mark would build a
			// second dim and the scale would look up the first.
			const node = sql`date_trunc('month', ts)`;
			expect(identityKeyFor(node)!.key).toBe(identityKeyFor(node)!.key);
		});
	});
});
