import { describe, it, expect } from 'vitest';
import { checkFacetCells, MAX_FACET_CELLS, WARN_FACET_CELLS } from './facet-limits';

describe('checkFacetCells', () => {
	it('passes an ordinary grid silently', () => {
		expect(checkFacetCells(3, 'species')).toEqual({ ok: true, message: null });
	});

	it('warns but renders between the two limits', () => {
		const got = checkFacetCells(WARN_FACET_CELLS + 1, 'species');
		expect(got.ok).toBe(true);
		expect(got.message).toContain('too small to read');
	});

	it('refuses above the maximum', () => {
		const got = checkFacetCells(MAX_FACET_CELLS + 1, 'ts');
		expect(got.ok).toBe(false);
		expect(got.message).toContain(String(MAX_FACET_CELLS));
	});

	it('names the field and points at truncation, since that is the fix', () => {
		// The message has to carry the way out: the pathological case is a
		// timestamp, and the answer is date_trunc rather than "use fewer".
		const got = checkFacetCells(6000, 'event_ts');
		expect(got.message).toContain('event_ts');
		expect(got.message).toContain('date_trunc');
	});

	it('is inclusive at each boundary rather than one off', () => {
		expect(checkFacetCells(WARN_FACET_CELLS, 'f').message).toBeNull();
		expect(checkFacetCells(MAX_FACET_CELLS, 'f').ok).toBe(true);
	});
});
