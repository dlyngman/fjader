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
		// buildCaseExpression outlives this deletion: ordinal colour is the last
		// CASE-inlined channel, until step 3b. The sentinel it emits has to keep
		// matching the one scaleBand discards.
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
	// The CPU-side counterpart of the shader's identitySlots lookup. Consumers —
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

describe('BandScaleState across an identity reset', () => {
	// A data reload drops every dim and view. QueryEngine empties the
	// FieldIdentity it handed out IN PLACE and clears its map, so the mark
	// re-running setup adopts a DIFFERENT object for the same field. Everything
	// the scale stored under the old numbering is garbage at that point.

	/** What CategoricalIdentity.reset() does to an object a scale is holding. */
	function emptyInPlace(identity: FieldIdentity) {
		identity.reset([]);
	}

	it('drops pre-reset ids when a fresh identity arrives', () => {
		const before = new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']);
		const scale = new BandScaleState('species');
		scale.setIdentity(before);
		scale.addMark(['Gentoo', 'Adelie'], 'mark-1');
		scale.updateDomainFromExtents();
		expect(Array.from(scale.displayOrder)).toEqual([2, 0]);

		// The reload: same field, but the data now has different categories, so
		// the rebuilt dim numbers them differently. Ids 2 and 0 would still be
		// IN RANGE against it — they just mean something else now.
		emptyInPlace(before);
		const after = new FieldIdentity(['Emperor', 'King', 'Rockhopper']);
		scale.setIdentity(after);

		// Not ['Rockhopper', 'Emperor'], which is what the stale ids decode to.
		expect(scale.effectiveDomain).toEqual([]);
		expect(Array.from(scale.displayOrder)).toEqual([]);
	});

	it('drops the ids of a mark that has not re-registered yet', () => {
		// Two marks share the scale and re-run setup independently, so there is
		// always a window where one has refreshed its extents and the other has
		// not. A mark's own addMark overwrites its entry by markId — the peer's
		// stale entry is the one with nothing to overwrite it.
		const before = new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']);
		const scale = new BandScaleState('species');
		scale.setIdentity(before);
		scale.addMark(['Adelie', 'Chinstrap'], 'mark-1');
		scale.addMark(['Gentoo'], 'mark-2');
		scale.updateDomainFromExtents();

		emptyInPlace(before);
		const after = new FieldIdentity(['Emperor', 'King', 'Rockhopper']);
		scale.setIdentity(after);
		scale.addMark(['King', 'Emperor'], 'mark-1');
		scale.updateDomainFromExtents();

		// mark-2 still holds id 2, which is in range against the new dim and
		// decodes to Rockhopper — a category nothing has registered.
		expect(scale.effectiveDomain).toEqual(['King', 'Emperor']);
		expect(Array.from(scale.displayOrder)).toEqual([1, 0]);
		expect(Array.from(scale.slotTable)).toEqual([1, 0, -1]);
	});

	it('handles a mark that re-registers before the fresh identity is adopted', () => {
		// The setup race, on the reload path: a mark's domain fetch resumes off
		// the same coalesced promise as its ensureColumns, so addMark can land
		// with the scale still holding the emptied object. Those are VALUES.
		const before = new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']);
		const scale = new BandScaleState('species');
		scale.setIdentity(before);
		scale.addMark(['Gentoo', 'Adelie'], 'mark-1');
		scale.updateDomainFromExtents();

		emptyInPlace(before);
		scale.addMark(['King', 'Emperor'], 'mark-1');
		scale.setIdentity(new FieldIdentity(['Emperor', 'King', 'Rockhopper']));

		expect(scale.effectiveDomain).toEqual(['King', 'Emperor']);
		expect(Array.from(scale.displayOrder)).toEqual([1, 0]);
	});

	it('drops a stale explicit domain', () => {
		const before = new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']);
		const scale = new BandScaleState('species');
		scale.setIdentity(before);
		// A reordering explicit domain: ids [2, 0, 1].
		scale.addMark(['Gentoo', 'Adelie', 'Chinstrap'], 'mark-1', { explicit: true });
		scale.updateDomainFromExtents();

		emptyInPlace(before);
		const after = new FieldIdentity(['Emperor', 'King', 'Rockhopper']);
		scale.setIdentity(after);
		scale.addMark(['Emperor', 'King', 'Rockhopper'], 'mark-1');
		scale.updateDomainFromExtents();

		// Every one of those ids is in range against the new dim, so left in
		// place the old permutation would silently reorder the new axis into
		// Rockhopper, Emperor, King.
		expect(scale.effectiveDomain).toEqual(['Emperor', 'King', 'Rockhopper']);
	});
});

describe('BandScaleState GPU readiness and gpuState', () => {
	// Both of these used to route through a category -> index Map. gpuState read
	// its .size and isReadyForGPU asserted it was a Map at all.
	//
	// Note on what is NOT pinned here: swapping gpuState's effectiveDomain.length
	// for #domain.length passes every one of these, because updateDomainFromExtents
	// returns early while frozen, so the two arrays never actually diverge. The
	// old Map read the same expression, and .size differed from .length only on a
	// duplicate category — which the dim's unique index and the de-duplication in
	// updateDomainFromExtents both prevent. That substitution is behaviour-
	// preserving in every reachable state, so these pin the contract (domainMax
	// tracks the displayed domain and agrees with getConfig) rather than the
	// expression.

	function ready(domain: string[]) {
		const scale = new BandScaleState('species');
		scale.setIdentity(new FieldIdentity(domain));
		scale.addMark(domain, 'mark-1');
		scale.updateDomainFromExtents();
		scale.setReady();
		return scale;
	}

	it('reports domainMax as the last displayed slot', () => {
		expect(ready(['Adelie', 'Chinstrap', 'Gentoo']).gpuState.domainMax).toBe(2);
	});

	it('does not go negative on an empty domain', () => {
		const scale = new BandScaleState('species');
		expect(scale.gpuState.domainMax).toBe(0);
	});

	it('does not move while frozen', () => {
		const scale = ready(['Adelie', 'Chinstrap', 'Gentoo']);
		scale.setUpdatesEnabled(false);

		// A category-reducing transform lands while frozen: extents change, and
		// nothing the GPU sizes its band layout from may follow.
		scale.addMark(['Adelie'], 'mark-1');
		scale.updateDomainFromExtents();

		expect(scale.effectiveDomain).toEqual(['Adelie', 'Chinstrap', 'Gentoo']);
		expect(scale.gpuState.domainMax).toBe(2);
		expect(scale.getConfig().categoryCount).toBe(3);
		expect(Array.from(scale.slotTable)).toEqual([0, 1, 2]);
	});

	it('agrees with getConfig().categoryCount', () => {
		// They are the same quantity, and the GPU reads both — gpuState for the
		// domain bounds, getConfig for the band layout.
		const scale = ready(['Adelie', 'Chinstrap', 'Gentoo', 'Emperor']);
		expect(scale.gpuState.domainMax + 1).toBe(scale.getConfig().categoryCount);
	});

	it('is not GPU-ready without a domain or before setReady', () => {
		const bare = new BandScaleState('species');
		expect(bare.isReadyForGPU).toBe(false);

		const noReady = new BandScaleState('species');
		noReady.setIdentity(new FieldIdentity(['Adelie']));
		noReady.addMark(['Adelie'], 'mark-1');
		noReady.updateDomainFromExtents();
		expect(noReady.isReadyForGPU).toBe(false);

		expect(ready(['Adelie']).isReadyForGPU).toBe(true);
	});

	it('is not GPU-ready in the window where the last mark has gone but the domain has not', () => {
		// The one state the #extents clause decides on its own. removeMark
		// debounces the domain update through a microtask, so synchronously
		// after it the scale still has a full domain and no marks behind it —
		// and a frame rendered there would draw bands nothing owns.
		const scale = ready(['Adelie', 'Chinstrap']);
		expect(scale.isReadyForGPU).toBe(true);

		scale.removeMark('mark-1');

		expect(scale.effectiveDomain).toEqual(['Adelie', 'Chinstrap']);
		expect(scale.isReadyForGPU).toBe(false);
	});
});

describe('BandScaleState as a facet scale', () => {
	// Step 3c. A facet scale is a BandScaleState whose "slots" are grid cells.
	// The __facet channel carries the dim id, and GPUCoordinator resolves each
	// cell's frame uniform through idAtSlot, so the shader compares id to id.
	// These pin the two halves of that agreement.

	function facetScale(values: string[], displayed: string[]) {
		const scale = new BandScaleState('__facet__species', [], { sourceField: 'species' });
		scale.setIdentity(new FieldIdentity(values));
		scale.addMark(displayed, 'mark-1', { explicit: displayed.length !== values.length });
		scale.updateDomainFromExtents();
		return scale;
	}

	it('resolves a cell index to the id that cell renders', () => {
		const scale = facetScale(['Adelie', 'Chinstrap', 'Gentoo'], ['Adelie', 'Chinstrap', 'Gentoo']);
		// In dim order these coincide, which is why a default facet chart cannot
		// catch a confusion between the two.
		expect([0, 1, 2].map((cell) => scale.idAtSlot(cell))).toEqual([0, 1, 2]);
	});

	it('keeps cell index and id distinct once the cells are reordered', () => {
		const scale = new BandScaleState('__facet__species', [], { sourceField: 'species' });
		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
		scale.addMark(['Gentoo', 'Adelie', 'Chinstrap'], 'mark-1', { explicit: true });
		scale.updateDomainFromExtents();

		// Cell 0 shows Gentoo, whose id is 2. A uniform carrying the cell index
		// would make every instance whose __facet is 0 (Adelie) render in cell 0.
		expect(scale.idAtSlot(0)).toBe(2);
		expect(scale.idAtSlot(1)).toBe(0);
		expect(scale.idAtSlot(2)).toBe(1);
	});

	it('round-trips cell -> id -> label, which is what the cell heading shows', () => {
		const scale = new BandScaleState('__facet__species', [], { sourceField: 'species' });
		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
		scale.addMark(['Gentoo', 'Adelie', 'Chinstrap'], 'mark-1', { explicit: true });
		scale.updateDomainFromExtents();

		const labels = [0, 1, 2].map((cell) => scale.categoryAt(scale.idAtSlot(cell)!));
		expect(labels).toEqual(['Gentoo', 'Adelie', 'Chinstrap']);
		// And the same order the grid renders from.
		expect(labels).toEqual(scale.effectiveDomain);
	});

	it('reports no id for a cell beyond the categories present', () => {
		// The grid is sized from effectiveDomain, so this should not happen — but
		// the uniform falls back to the raw cell index when it does, and that must
		// not silently select a real category.
		const scale = facetScale(['Adelie', 'Chinstrap', 'Gentoo'], ['Adelie', 'Chinstrap']);
		expect(scale.idAtSlot(5)).toBeNull();
	});

	it('passes the cell index through when the scale has no identity', () => {
		// The migration's no-op step: before the facet field is dimmed, idAtSlot
		// returns the slot unchanged, so the uniform keeps carrying a cell index
		// and nothing changes.
		const scale = new BandScaleState('__facet__species');
		scale.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
		scale.updateDomainFromExtents();
		expect([0, 1, 2].map((cell) => scale.idAtSlot(cell))).toEqual([0, 1, 2]);
	});
});
