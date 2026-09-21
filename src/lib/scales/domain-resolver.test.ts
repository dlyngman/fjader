import { describe, it, expect } from 'vitest';
import { DomainResolver } from './DomainResolver';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';

/**
 * The resolver on its own: no d3 scale, no slot transition, no clock, no GPU.
 *
 * That is the point of it having a file. The logic below decides which
 * categories an axis shows and which space a number is in, and every one of
 * its failures is silent — the wrong categories, or none, with nothing
 * thrown. It used to be reachable only by driving a whole BandScaleState,
 * which is why the reload orderings were defended in prose rather than by a
 * test.
 */
describe('DomainResolver', () => {
	const SPECIES = ['Adelie', 'Chinstrap', 'Gentoo'];
	const withIdentity = (values: unknown[] = SPECIES) => {
		const r = new DomainResolver();
		r.setIdentity(new FieldIdentity(values as string[]));
		return r;
	};

	describe('order', () => {
		it('takes first appearance across marks', () => {
			const r = withIdentity();
			r.addMark(['Gentoo'], 'a');
			r.addMark(['Adelie', 'Gentoo'], 'b');
			expect(r.resolve().values).toEqual(['Gentoo', 'Adelie']);
		});

		it('puts a ranked mark first, and the rest behind it', () => {
			const r = withIdentity(['A', 'B', 'C', 'D', 'E']);
			r.addMark(['A', 'B', 'C', 'D', 'E'], 'plain');
			r.addMark(['C', 'A'], 'ranked', { sorted: true });
			expect(r.resolve().values).toEqual(['C', 'A', 'B', 'D', 'E']);
		});

		it('lets an explicit domain outrank a ranking', () => {
			const r = withIdentity();
			r.addMark(['Gentoo', 'Adelie'], 'ranked', { sorted: true });
			r.addMark(['Adelie', 'Chinstrap'], 'explicit', { explicit: true });
			expect(r.resolve().values).toEqual(['Adelie', 'Chinstrap', 'Gentoo']);
		});

		it('drops a claim when the mark that made it re-registers without one', () => {
			const r = withIdentity();
			r.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'plain');
			r.addMark(['Gentoo'], 'ranked', { sorted: true });
			expect(r.resolve().values).toEqual(['Gentoo', 'Adelie', 'Chinstrap']);

			r.addMark(['Gentoo'], 'ranked');
			expect(r.resolve().values).toEqual(['Adelie', 'Chinstrap', 'Gentoo']);
		});

		it('drops a claim when the mark that made it leaves', () => {
			const r = withIdentity();
			r.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'plain');
			r.addMark(['Gentoo'], 'ranked', { sorted: true });
			r.resolve();

			expect(r.removeMark('ranked')).toBe(true);
			expect(r.removeMark('ranked')).toBe(false);
			expect(r.resolve().values).toEqual(['Adelie', 'Chinstrap', 'Gentoo']);
		});
	});

	describe('which space a number is in', () => {
		// The two are not distinguishable by inspection, which is why every
		// entry point says. Guessing is the wrong-data class of failure.

		it('reads numbers as source values on a numeric band column', () => {
			const r = withIdentity([2019, 2020, 2021]);
			r.addMark([2021, 2019], 'mark-1');
			expect(Array.from(r.resolve().ids)).toEqual([2, 0]);
			expect(r.resolve().values).toEqual([2021, 2019]);
		});

		it('reads the same numbers as ids when the caller registers them as ids', () => {
			const r = withIdentity([2019, 2020, 2021]);
			r.addMarkIds([2, 0], 'mark-1');
			expect(r.resolve().values).toEqual([2021, 2019]);
		});

		it('drops an id past the end of the value array', () => {
			// It would survive into the permutation and be dropped from the value
			// projection, leaving the two different lengths.
			const r = withIdentity();
			r.addMarkIds([0, 7, 2], 'mark-1');
			const { ids, values } = r.resolve();
			expect(Array.from(ids)).toEqual([0, 2]);
			expect(ids.length).toBe(values.length);
		});

		it('drops a value the dim has never heard of', () => {
			const r = withIdentity();
			r.addMark(['Adelie', 'Emperor'], 'mark-1');
			expect(r.resolve().values).toEqual(['Adelie']);
		});
	});

	describe('adopting identity after marks have registered', () => {
		it('re-encodes values that were stored before the dim arrived', () => {
			// The setup race: a mark's domain fetch and its ensureColumns resume
			// off the same coalesced promise, so registration can land first.
			const r = new DomainResolver();
			r.addMark(['Gentoo', 'Adelie'], 'mark-1');
			expect(r.resolve().values).toEqual(['Gentoo', 'Adelie']);

			r.setIdentity(new FieldIdentity(SPECIES));
			const { ids, values } = r.resolve();
			expect(Array.from(ids)).toEqual([2, 0]);
			expect(values).toEqual(['Gentoo', 'Adelie']);
		});

		it('re-encodes once, however many marks adopt the same object', () => {
			// Every mark on a shared scale calls setIdentity with the same live
			// object. A second pass would look each stored ID up as a VALUE, miss,
			// and empty the domain.
			const live = new FieldIdentity(SPECIES);
			const r = new DomainResolver();
			r.addMark(['Gentoo', 'Adelie'], 'mark-1');

			r.setIdentity(live);
			r.setIdentity(live);
			r.setIdentity(live);

			expect(r.resolve().values).toEqual(['Gentoo', 'Adelie']);
		});

		it('sees a value appended to the live object without re-adoption', () => {
			const live = new FieldIdentity(SPECIES);
			const r = new DomainResolver();
			r.setIdentity(live);
			r.addMark(['Gentoo'], 'mark-1');
			r.resolve();

			// The dim grew, in place, as a second table registering the field
			// makes it do.
			live.reset([...SPECIES, 'Emperor']);
			r.addMark(['Gentoo', 'Emperor'], 'mark-1');
			expect(r.resolve().values).toEqual(['Gentoo', 'Emperor']);
			expect(r.idCount).toBe(4);
		});
	});

	describe('across an identity reset', () => {
		// A reload drops every dim. The engine empties the object a holder has
		// IN PLACE and clears its map, so a mark re-running setup adopts a
		// DIFFERENT object for the same field. Ids stored under the old
		// numbering are garbage, and — this is the trap — still in range.

		const reloaded = () => new FieldIdentity(['Emperor', 'King', 'Rockhopper']);

		it('drops pre-reset ids when a fresh object arrives', () => {
			const before = new FieldIdentity(SPECIES);
			const r = new DomainResolver();
			r.setIdentity(before);
			r.addMark(['Gentoo', 'Adelie'], 'mark-1');
			expect(Array.from(r.resolve().ids)).toEqual([2, 0]);

			before.reset([]);
			r.setIdentity(reloaded());

			// Not ['Rockhopper', 'Emperor'], which is what the stale ids decode to.
			expect(r.resolve().values).toEqual([]);
		});

		it('keeps the ids of a mark that has already refreshed, drops a peer that has not', () => {
			// Two marks re-run setup independently, so there is always a window
			// where one has refreshed and the other has not.
			const before = new FieldIdentity(SPECIES);
			const r = new DomainResolver();
			r.setIdentity(before);
			r.addMark(['Adelie', 'Chinstrap'], 'mark-1');
			r.addMark(['Gentoo'], 'mark-2');
			r.resolve();

			before.reset([]);
			r.setIdentity(reloaded());
			r.addMark(['King', 'Emperor'], 'mark-1');

			// mark-2 still holds id 2, in range against the new dim, decoding to a
			// category nothing registered.
			const { ids, values } = r.resolve();
			expect(values).toEqual(['King', 'Emperor']);
			expect(Array.from(ids)).toEqual([1, 0]);
		});

		it('treats a registration made against the emptied object as values', () => {
			// The setup race on the reload path: a mark can register while the
			// resolver still holds the emptied object.
			const before = new FieldIdentity(SPECIES);
			const r = new DomainResolver();
			r.setIdentity(before);
			r.addMark(['Gentoo', 'Adelie'], 'mark-1');
			r.resolve();

			before.reset([]);
			r.addMark(['King', 'Emperor'], 'mark-1');
			r.setIdentity(reloaded());

			expect(r.resolve().values).toEqual(['King', 'Emperor']);
		});
	});

	describe('what changed', () => {
		it('reports nothing when the answer is the one already given', () => {
			const r = withIdentity();
			r.addMark(['Adelie'], 'mark-1');
			expect(r.resolve().changed).toBe(true);
			expect(r.resolve().changed).toBe(false);
		});

		it('reports a permutation that moved while its values did not', () => {
			// Identity arriving after the domain has settled, which is the live
			// ordering during setup. Comparing the values alone left the
			// permutation empty and a slot table stale.
			const r = new DomainResolver();
			r.addMark(['Adelie', 'Chinstrap'], 'mark-1');
			const before = r.resolve();
			expect(before.values).toEqual(['Adelie', 'Chinstrap']);
			expect(Array.from(before.ids)).toEqual([]);

			r.setIdentity(new FieldIdentity(SPECIES));
			const after = r.resolve();
			expect(after.values).toEqual(['Adelie', 'Chinstrap']);
			expect(Array.from(after.ids)).toEqual([0, 1]);
			expect(after.changed).toBe(true);
		});

		it('reports the emptying when the last mark leaves', () => {
			const r = withIdentity();
			r.addMark(['Adelie'], 'mark-1');
			r.resolve();

			r.removeMark('mark-1');
			const { values, changed } = r.resolve();
			expect(values).toEqual([]);
			expect(changed).toBe(true);
			expect(r.resolve().changed).toBe(false);
		});
	});

	describe('identity <-> display for CPU consumers', () => {
		it('decodes a channel value through the dim when there is one', () => {
			const r = withIdentity();
			// Display order is irrelevant: an id indexes the dim, not the axis.
			expect(r.categoryAt(2, ['Gentoo', 'Adelie'])).toBe('Gentoo');
			expect(r.channelValueFor('Gentoo', [])).toBe(2);
		});

		it('treats a channel value as a display position without a dim', () => {
			const r = new DomainResolver();
			const displayed = ['Gentoo', 'Adelie'];
			expect(r.categoryAt(0, displayed)).toBe('Gentoo');
			expect(r.channelValueFor('Adelie', displayed)).toBe(1);
			expect(r.channelValueFor('Emperor', displayed)).toBeNull();
		});

		it('rebuilds its position cache when it is handed a different array', () => {
			// Keyed on the array, not a counter, so it cannot miss a change that
			// moved the domain without bumping one — freezing is such a change.
			const r = new DomainResolver();
			expect(r.channelValueFor('b', ['a', 'b'])).toBe(1);
			expect(r.channelValueFor('b', ['b', 'a'])).toBe(0);
		});
	});
});
