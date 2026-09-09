import { describe, it, expect, vi } from 'vitest';
import { BandScaleState } from './BandScaleState.svelte';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';
import { buildCaseExpression } from '$lib/sql/case-expression';

describe('BandScaleState.processDataForGPU', () => {
	function scaleWith(domain: string[]): BandScaleState {
		const scale = new BandScaleState('category');
		scale.addMark(domain, 'mark-1');
		scale.updateDomainFromExtents();
		return scale;
	}

	it('passes identity ids through untouched, zero-copy', () => {
		const scale = scaleWith(['a', 'b']);
		const ids = new Float32Array([2, 0, 1]);
		// The same object, not a copy: the query already produced GPU-ready floats.
		expect(scale.processDataForGPU(ids)).toBe(ids);
	});

	it('reports raw category strings instead of mapping them', () => {
		// The per-row string mapping is gone (§16.10 item 3). Nothing produces
		// strings on a band channel any more, so strings here mean a defect
		// upstream — reported, and drawn as the no-identity sentinel so nothing
		// renders rather than something wrong.
		const scale = scaleWith(['a', 'b']);
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const out = scale.processDataForGPU(['a', 'b'], 'mark-1');

		expect(Array.from(out)).toEqual([-1, -1]);
		expect(spy).toHaveBeenCalledOnce();
		expect(spy.mock.calls[0][0]).toContain('identity ids were expected');
		spy.mockRestore();
	});

	it('still emits -1 for an unmapped value in the SQL CASE', () => {
		// buildCaseExpression outlives this deletion: ordinal colour and facet
		// still CASE-inline until steps 3b and 3c. The sentinel it emits has to
		// keep matching the one scaleBand discards.
		const sql = buildCaseExpression('category', ['a', 'b']);
		expect(sql).toContain('WHEN "category" = \'a\' THEN 0');
		expect(sql).toContain('ELSE -1');
	});

	it('passes a Float32Array through untouched', () => {
		const scale = scaleWith(['a', 'b']);
		const input = new Float32Array([1, 0, -1]);
		expect(scale.processDataForGPU(input)).toBe(input);
	});
});

// ---------------------------------------------------------------------------
// Slot table (band step 3a / §9.5)
// ---------------------------------------------------------------------------

describe('BandScaleState.slotTable', () => {
	/** Build a scale whose identity ids are alphabetical, as the dim assigns them. */
	function withIdentity(values: string[], domain: string[]) {
		const scale = new BandScaleState('species');
		scale.setIdentity(new FieldIdentity(values));
		scale.addMark(domain, 'mark-1');
		scale.updateDomainFromExtents();
		return scale;
	}

	it('is the identity permutation when display order matches id order', () => {
		const scale = withIdentity(
			['Adelie', 'Chinstrap', 'Gentoo'],
			['Adelie', 'Chinstrap', 'Gentoo']
		);
		expect(Array.from(scale.slotTable)).toEqual([0, 1, 2]);
	});

	it('maps id to display slot under an explicit reorder', () => {
		const scale = new BandScaleState('species');
		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
		// Displayed as Gentoo, Adelie, Chinstrap.
		scale.addMark(['Gentoo', 'Adelie', 'Chinstrap'], 'mark-1', { explicit: true });
		scale.updateDomainFromExtents();

		// Adelie(id 0) -> slot 1, Chinstrap(id 1) -> slot 2, Gentoo(id 2) -> slot 0.
		expect(Array.from(scale.slotTable)).toEqual([1, 2, 0]);
	});

	it('gives -1 to ids that are not displayed', () => {
		const scale = new BandScaleState('species');
		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
		// A category-reducing transform left only two.
		scale.addMark(['Adelie', 'Gentoo'], 'mark-1');
		scale.updateDomainFromExtents();

		const table = Array.from(scale.slotTable);
		expect(table[1]).toBe(-1); // Chinstrap: filtered out
		expect(table[0]).toBe(0);
		expect(table[2]).toBe(1);
	});

	it('sizes to the id space, not the displayed count', () => {
		// A second table added Emperor to the shared dim; this mark shows none.
		const scale = new BandScaleState('species');
		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo', 'Emperor']));
		scale.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
		scale.updateDomainFromExtents();

		// Indexable by Emperor's id without running off the end — the §9.4 failure.
		expect(scale.slotTable.length).toBe(4);
		expect(scale.slotTable[3]).toBe(-1);
	});

	it('follows a reorder without the ids changing', () => {
		const scale = new BandScaleState('species');
		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
		scale.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
		scale.updateDomainFromExtents();
		expect(Array.from(scale.slotTable)).toEqual([0, 1, 2]);

		// Sort by some measure: Gentoo, Chinstrap, Adelie. Ids are untouched.
		scale.setSortOrder(['Gentoo', 'Chinstrap', 'Adelie']);
		scale.updateDomainFromExtents();
		expect(Array.from(scale.slotTable)).toEqual([2, 1, 0]);
	});

	it('is empty before identity values arrive', () => {
		const scale = new BandScaleState('species');
		expect(scale.slotTable.length).toBe(0);
	});

	it('re-encodes categories registered before identity arrived', () => {
		// The live ordering: a mark's domain fetch and its ensureColumns both
		// resume off the same coalesced promise, so addMark can land while
		// hasIdentity is still false. Those values must not be read as ids later.
		const scale = new BandScaleState('species');
		scale.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
		scale.updateDomainFromExtents();

		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));

		expect(scale.effectiveDomain).toEqual(['Adelie', 'Chinstrap', 'Gentoo']);
		expect(Array.from(scale.displayOrder)).toEqual([0, 1, 2]);
		expect(Array.from(scale.slotTable)).toEqual([0, 1, 2]);
	});

	it('keeps a pre-identity sort order after identity arrives', () => {
		const scale = new BandScaleState('species');
		scale.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
		scale.setSortOrder(['Gentoo', 'Adelie', 'Chinstrap']);
		scale.updateDomainFromExtents();

		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));

		expect(scale.effectiveDomain).toEqual(['Gentoo', 'Adelie', 'Chinstrap']);
		expect(Array.from(scale.slotTable)).toEqual([1, 2, 0]);
	});

	it('encodes a value added to the live array after identity was adopted', () => {
		// The engine's value array grows IN PLACE when a second table appends to
		// the dim (§9.4), and a mark can call addMark between that append and its
		// own setIdentity. A value->id map snapshotted at adoption time
		// drops the new category silently — a bar missing from multi-table charts
		// on some interleavings only.
		const live = new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']);
		const scale = new BandScaleState('species');
		scale.setIdentity(live);

		// The dim appended; no re-adoption. reset() is the engine's single
		// writer, so both directions move together and the scale sees both.
		live.reset(['Adelie', 'Chinstrap', 'Gentoo', 'Emperor']);

		scale.addMark(['Adelie', 'Chinstrap', 'Gentoo', 'Emperor'], 'mark-1');
		scale.updateDomainFromExtents();

		expect(scale.effectiveDomain).toContain('Emperor');
		expect(Array.from(scale.displayOrder)).toEqual([0, 1, 2, 3]);
		expect(scale.slotTable[3]).toBe(3);
	});

	it('accepts ids directly, as topN passes them', () => {
		const scale = new BandScaleState('species');
		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
		// Only two survived the transform, handed over as ids with no decode.
		scale.addMark([2, 0], 'mark-1', { encoded: true });
		scale.updateDomainFromExtents();

		expect(scale.effectiveDomain).toEqual(['Gentoo', 'Adelie']);
		expect(Array.from(scale.displayOrder)).toEqual([2, 0]);
		// Chinstrap is not displayed.
		expect(Array.from(scale.slotTable)).toEqual([1, -1, 0]);
	});

	it('passes positions through when the scale has no identity values', () => {
		// An expression-backed axis or a topN mark sends display positions, not
		// dim ids. The lookup must not remap them — and must not leave an empty
		// table, which would share offset 0 with another scale.
		const scale = new BandScaleState('species');
		scale.addMark(['Gentoo', 'Adelie', 'Chinstrap'], 'mark-1', { explicit: true });
		scale.updateDomainFromExtents();

		expect(Array.from(scale.slotTable)).toEqual([0, 1, 2]);
	});
});

describe('BandScaleState identity <-> display translation', () => {
	// The CPU-side counterpart of the shader's bandSlots lookup. Consumers —
	// tooltips, hit-testing, toggles — ask in their own terms and never index
	// displayOrder or identityValues themselves.

	it('maps a display slot to the id sitting there', () => {
		const scale = new BandScaleState('species');
		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
		scale.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
		scale.setSortOrder(['Gentoo', 'Adelie', 'Chinstrap']);
		scale.updateDomainFromExtents();

		// Display order is Gentoo, Adelie, Chinstrap; ids are alphabetical.
		expect(scale.idAtSlot(0)).toBe(2);
		expect(scale.idAtSlot(1)).toBe(0);
		expect(scale.idAtSlot(2)).toBe(1);
	});

	it('decodes a channel id to its source value regardless of display order', () => {
		const scale = new BandScaleState('species');
		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
		scale.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
		scale.setSortOrder(['Gentoo', 'Adelie', 'Chinstrap']);
		scale.updateDomainFromExtents();

		// The id decodes to the same value whatever slot it currently occupies —
		// this is the whole point of the split. Indexing effectiveDomain with
		// these ids would give Chinstrap, Gentoo, Adelie: the original bug.
		expect(scale.categoryAt(0)).toBe('Adelie');
		expect(scale.categoryAt(1)).toBe('Chinstrap');
		expect(scale.categoryAt(2)).toBe('Gentoo');
	});

	it('round-trips slot -> id -> value back to the axis label', () => {
		const scale = new BandScaleState('species');
		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
		scale.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
		scale.setSortOrder(['Gentoo', 'Adelie', 'Chinstrap']);
		scale.updateDomainFromExtents();

		// What a hover does: invert to a slot, translate to an id to match the
		// row, decode the row's value back for the label. It must land on the
		// same category the axis renders at that slot.
		for (let slot = 0; slot < scale.effectiveDomain.length; slot++) {
			const id = scale.idAtSlot(slot);
			expect(id).not.toBeNull();
			expect(scale.categoryAt(id as number)).toBe(scale.effectiveDomain[slot]);
		}
	});

	it('reports no id for a slot holding no category', () => {
		const scale = new BandScaleState('species');
		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
		scale.addMark([2, 0], 'mark-1', { encoded: true }); // topN kept two of three
		scale.updateDomainFromExtents();

		expect(scale.idAtSlot(0)).toBe(2);
		expect(scale.idAtSlot(1)).toBe(0);
		// Past the displayed set: the cursor is over no bar, so the caller must
		// build no query rather than one matching an arbitrary row.
		expect(scale.idAtSlot(2)).toBeNull();
	});

	it('treats a channel value as a display position without identity', () => {
		// Expression-backed axes have no dim, so the channel already carries a
		// position and both translations are the identity function.
		const scale = new BandScaleState('species');
		scale.addMark(['Gentoo', 'Adelie', 'Chinstrap'], 'mark-1', { explicit: true });
		scale.updateDomainFromExtents();

		expect(scale.hasIdentity).toBe(false);
		expect(scale.idAtSlot(1)).toBe(1);
		expect(scale.categoryAt(1)).toBe('Adelie');
		expect(scale.idAtSlot(3)).toBeNull();
	});

	it('decodes against the live domain, not a snapshot taken before a reorder', () => {
		// The bug this move exists to prevent: a consumer that captured the
		// domain once decodes with stale display order after a sort.
		const scale = new BandScaleState('species');
		scale.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
		scale.updateDomainFromExtents();
		const captured = scale.effectiveDomain;

		scale.setSortOrder(['Gentoo', 'Adelie', 'Chinstrap']);
		scale.updateDomainFromExtents();

		expect(captured).toEqual(['Adelie', 'Chinstrap', 'Gentoo']);
		expect(scale.categoryAt(0)).toBe('Gentoo');
		expect(scale.categoryAt(0)).not.toBe(captured[0]);
	});
});

describe('BandScaleState id/value disambiguation', () => {
	it('reads numbers as source values on a numeric band column', () => {
		// A band axis over a year column: dim values are numbers, so a raw
		// category is indistinguishable from an id by inspection. Guessing read
		// 2021 as id 2021, which no dim has — the category vanished.
		const scale = new BandScaleState('year');
		scale.setIdentity(new FieldIdentity([2019, 2020, 2021] as unknown as string[]));
		scale.addMark([2021, 2019], 'mark-1');
		scale.updateDomainFromExtents();

		expect(Array.from(scale.displayOrder)).toEqual([2, 0]);
		expect(scale.effectiveDomain).toEqual([2021, 2019]);
	});

	it('reads the same numbers as ids when the caller says they are encoded', () => {
		const scale = new BandScaleState('year');
		scale.setIdentity(new FieldIdentity([2019, 2020, 2021] as unknown as string[]));
		scale.addMark([2, 0], 'mark-1', { encoded: true });
		scale.updateDomainFromExtents();

		expect(Array.from(scale.displayOrder)).toEqual([2, 0]);
		expect(scale.effectiveDomain).toEqual([2021, 2019]);
	});

	it('drops an id past the end of the value array', () => {
		// Such an id would survive into displayOrder but be dropped from #domain
		// by the string projection, leaving the permutation a different length
		// from the d3 band index space it must agree with.
		const scale = new BandScaleState('species');
		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
		scale.addMark([0, 7, 2], 'mark-1', { encoded: true });
		scale.updateDomainFromExtents();

		expect(Array.from(scale.displayOrder)).toEqual([0, 2]);
		expect(scale.displayOrder.length).toBe(scale.effectiveDomain.length);
	});

	it('survives every mark on a shared scale adopting identity in turn', () => {
		// setIdentity runs once per mark with the same live object. The
		// re-encode is a one-time transition: repeating it would look each stored
		// id up as a value, miss, and empty the domain.
		const live = new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']);
		const scale = new BandScaleState('species');
		scale.addMark(['Gentoo', 'Adelie'], 'mark-1');

		scale.setIdentity(live);
		scale.setIdentity(live);
		scale.setIdentity(live);

		expect(scale.effectiveDomain).toEqual(['Gentoo', 'Adelie']);
		expect(Array.from(scale.displayOrder)).toEqual([2, 0]);
	});
});
