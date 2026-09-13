import { describe, it, expect, vi } from 'vitest';
import { BandScaleState } from './BandScaleState.svelte';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';

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

	// The animation interface exists but nothing drives it yet (step 5 C2).
	//
	// Two claims, and the second is the one worth a test: BandScaleState now
	// satisfies what GPUCoordinator's loop calls, and it does not register, so
	// the loop never sees it. C3 makes one change that both registers and
	// interpolates — deliberately one change, so the first frame of motion
	// proves the registration too.
	describe('animation interface', () => {
		function scale(): BandScaleState {
			const s = new BandScaleState('species');
			s.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
			s.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
			s.updateDomainFromExtents();
			return s;
		}

		it('has the four methods GPUCoordinator drives a scale through', () => {
			const s = scale();
			for (const name of ['step', 'updateRenderState', 'isAtRest', '_markAtRest'] as const) {
				expect(typeof s[name]).toBe('function');
			}
			// step() takes no arguments here. The band-geometry step(rangeSize)
			// moved to stepWidth for exactly this reason, and an arity clash
			// between them would have been silent.
			expect(s.step.length).toBe(0);
			expect(s.stepWidth(100)).toBeGreaterThan(0);
		});

		it('reports at rest, so a registered scale cannot pin the loop on', () => {
			// Load-bearing, not a placeholder. With no spring, a scale that ever
			// reached #animatedScalesArray must fall straight back out on the next
			// sweep; otherwise the chart redraws every frame while looking
			// perfectly correct, which is invisible outside a profiler.
			const s = scale();
			expect(s.isAtRest()).toBe(true);

			s.step();
			s.updateRenderState(0.016);
			expect(s.isAtRest()).toBe(true);
		});

		it('settles immediately when no coordinator can drive the loop', () => {
			// slotCurrent is written only by updateRenderState, which only runs
			// while the loop holds this scale. Without a coordinator that never
			// happens, so a retarget alone would leave the old order on screen
			// forever. An animation nobody can drive has to be an instant
			// transition, not a lost one — and this is the common case in tests
			// and for any scale built before a coordinator is wired up.
			const s = scale();
			s.setSortOrder(['Gentoo', 'Adelie', 'Chinstrap']);
			s.updateDomainFromExtents();

			expect(Array.from(s.slotTable)).toEqual([1, 2, 0]);
			expect(Array.from(s.slotTable)).toEqual(Array.from(s.slotTarget));
		});
	});

	// The spring (step 5 C3).
	//
	// These need a coordinator, because without one a retarget settles instantly
	// by design. The fake records what registered, which is also what makes the
	// claim C2 could not test — "it does not register" — finally testable: there
	// is now something that CAN.
	describe('the spring', () => {
		function withLoop() {
			const registered: unknown[] = [];
			const s = new BandScaleState('species', [], {
				gpuCoordinator: { addAnimatingScale: (x: unknown) => registered.push(x) }
			});
			s.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
			s.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
			s.updateDomainFromExtents();
			return { s, registered };
		}

		it('does not register for the first layout, which must not animate', () => {
			// Every id enters from -1 on a first build, and an entering id snaps.
			// If this registered, the opening frame of every chart would slide
			// its bars in from off-axis.
			const { s, registered } = withLoop();
			expect(registered).toEqual([]);
			expect(Array.from(s.slotTable)).toEqual([0, 1, 2]);
		});

		it('still does not register when the data lands BEFORE the identity', () => {
			// withLoop adopts identity first, which is the order every other test
			// here uses and NOT the only order the app produces: setIdentity is
			// reached through a coalesced promise, so addMark can land on either
			// side of it (§29.8's transient).
			//
			// Arriving on the early side used to make the first real layout look
			// like a reorder. The passthrough branch had already written slots
			// 0..n in DOMAIN-POSITION space and set #hasLaidOut; the identity
			// branch then re-read those numbers as DIM IDS, found every id
			// "already on screen" somewhere arbitrary, and sprang the lot. The
			// opening frame of the chart slid its bars in from nowhere.
			const registered: unknown[] = [];
			const s = new BandScaleState('species', [], {
				gpuCoordinator: { addAnimatingScale: (x: unknown) => registered.push(x) }
			});

			s.addMark(['Gentoo', 'Adelie', 'Chinstrap'], 'mark-1');
			s.updateDomainFromExtents();
			// Dim ids are alphabetical, so this display order is NOT id order —
			// which is what makes the stale table and the real one differ.
			s.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));

			expect(registered).toEqual([]);
			expect(Array.from(s.slotTarget)).toEqual([1, 2, 0]);
			expect(Array.from(s.slotTable)).toEqual([1, 2, 0]);
		});

		it('registers once on a reorder, and leaves the table where it was', () => {
			const { s, registered } = withLoop();
			s.setSortOrder(['Gentoo', 'Adelie', 'Chinstrap']);
			s.updateDomainFromExtents();

			expect(registered).toEqual([s]);
			// The target moved; the visible table has not yet. That gap is the
			// animation, and at C1 it did not exist.
			expect(Array.from(s.slotTarget)).toEqual([1, 2, 0]);
			expect(Array.from(s.slotTable)).toEqual([0, 1, 2]);

			// A second reorder while already animating must not register twice.
			s.setSortOrder(['Chinstrap', 'Gentoo', 'Adelie']);
			s.updateDomainFromExtents();
			expect(registered).toEqual([s]);
		});

		it('walks the table toward the target and arrives', () => {
			const { s } = withLoop();
			s.setSortOrder(['Gentoo', 'Adelie', 'Chinstrap']);
			s.updateDomainFromExtents();

			expect(s.isAtRest()).toBe(false);

			// Adelie(0) is travelling from slot 0 to slot 1.
			let previous = s.slotTable[0];
			let moved = false;
			// A one-slot move needs 412 steps to reach REST_PRECISION at stiffness
			// 120 — about 1.1s of physics at 360Hz, nearly all of it an
			// imperceptible tail. The cap is generous rather than tight so this
			// asserts convergence and not a particular tuning; `steps` is checked
			// against it so a spring that never settles fails here loudly instead
			// of falling out of the loop and passing.
			let steps = 0;
			while (steps < 5000 && !s.isAtRest()) {
				s.step();
				s.updateRenderState(0);
				if (s.slotTable[0] > previous) moved = true;
				previous = s.slotTable[0];
				steps++;
			}

			// It got there gradually, not in one jump.
			expect(moved).toBe(true);
			expect(steps).toBeLessThan(5000);
			expect(s.isAtRest()).toBe(true);
			expect(s.slotTable[0]).toBeCloseTo(1, 2);
		});

		it('bumps slotVersion every frame, or the packer uploads only the first', () => {
			const { s } = withLoop();
			s.setSortOrder(['Gentoo', 'Adelie', 'Chinstrap']);
			s.updateDomainFromExtents();

			const before = s.slotVersion;
			s.step();
			s.updateRenderState(0);
			s.step();
			s.updateRenderState(0);
			expect(s.slotVersion).toBe(before + 2);
		});

		it('lands exactly on the target when the loop lets go', () => {
			// REST_PRECISION is sub-pixel, so the sliver is invisible — but
			// slotCurrent is what the next retarget springs FROM, and a scale at
			// rest holding 2.0003 springs from a number that was never a slot.
			const { s } = withLoop();
			s.setSortOrder(['Gentoo', 'Adelie', 'Chinstrap']);
			s.updateDomainFromExtents();
			for (let i = 0; i < 400 && !s.isAtRest(); i++) {
				s.step();
				s.updateRenderState(0);
			}
			s._markAtRest();

			expect(Array.from(s.slotTable)).toEqual([1, 2, 0]);
			expect(s.isAnimating).toBe(false);
		});

		// §12 Q1, answered (C4): enter and leave TRAVEL, from beyond the end.
		//
		// A leaver cannot take -1 as its spring target — the shader discards
		// slot < 0.0 before the lookup, so the bar would vanish on the frame the
		// reorder landed. It holds a real slot for the whole exit and only becomes
		// hidden once it arrives. For a topN axis the far end is also where a
		// category genuinely goes: it drops past the cutoff, it does not evaporate
		// from the middle.
		it('walks a leaver off the end instead of vanishing it', () => {
			const { s, registered } = withLoop();

			// Chinstrap(1) leaves; the axis compacts to two slots, so `far` is 2.
			s.addMark(['Adelie', 'Gentoo'], 'mark-1');
			s.updateDomainFromExtents();

			expect(registered).toEqual([s]);
			// Still on screen, at the slot it held, with -1 waiting for it.
			expect(s.slotTable[1]).toBe(1);
			expect(s.slotTarget[1]).toBe(-1);
			// And it is travelling: the loop may not evict while it is in flight.
			expect(s.isAtRest()).toBe(false);

			let steps = 0;
			while (steps < 5000 && !s.isAtRest()) {
				s.step();
				s.updateRenderState(0);
				// Never discarded mid-exit, which is the C3 behaviour this replaces.
				expect(s.slotTable[1]).toBeGreaterThanOrEqual(0);
				steps++;
			}
			expect(steps).toBeLessThan(5000);
			// It got past the last visible slot before the loop let go.
			expect(s.slotTable[1]).toBeGreaterThan(1);

			s._markAtRest();
			// Only now is it hidden.
			expect(s.slotTable[1]).toBe(-1);
		});

		it('climbs an entrant in from beyond the end', () => {
			const { s } = withLoop();
			// Drop to two, settle, then bring the third back.
			s.addMark(['Adelie', 'Gentoo'], 'mark-1');
			s.updateDomainFromExtents();
			s._markAtRest();
			expect(s.slotTable[1]).toBe(-1);

			s.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
			s.updateDomainFromExtents();

			// Starts past the last slot — clipped by the scissor, not discarded by
			// the shader, which is what lets it travel at all.
			expect(s.slotTable[1]).toBe(3);
			expect(s.slotTarget[1]).toBe(1);

			let steps = 0;
			while (steps < 5000 && !s.isAtRest()) {
				s.step();
				s.updateRenderState(0);
				steps++;
			}
			expect(s.slotTable[1]).toBeCloseTo(1, 2);
		});

		it('enters and leaves through Other when the axis has one', () => {
			// With an Other bucket the far end is the WRONG destination: a category
			// dropping out of the top N does not leave the chart, its value moves
			// into Other. Animating it past the end would state something untrue
			// about where the data went.
			const s = new BandScaleState('species', [], {
				gpuCoordinator: { addAnimatingScale: () => {} }
			});
			// Adelie, Chinstrap, Gentoo, then the reserved bucket at the top of the
			// id space, exactly as reserveSynthetic hands it out.
			s.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo', 'Other']));
			s.setOtherId(3);
			s.addMark(['Adelie', 'Chinstrap', 'Other'], 'mark-1');
			s.updateDomainFromExtents();
			expect(Array.from(s.slotTable)).toEqual([0, 1, -1, 2]);

			// Chinstrap drops out and Gentoo takes its place. Other stays at 2.
			s.addMark(['Adelie', 'Gentoo', 'Other'], 'mark-1');
			s.updateDomainFromExtents();

			// The leaver heads for Other's slot, not slot 3 past the end.
			expect(s.slotTarget[1]).toBe(-1);
			let steps = 0;
			while (steps < 5000 && !s.isAtRest()) {
				s.step();
				s.updateRenderState(0);
				expect(s.slotTable[1]).toBeLessThanOrEqual(2);
				steps++;
			}
			expect(s.slotTable[1]).toBeCloseTo(2, 2);

			// And the entrant came OUT of Other rather than in from past the end.
			expect(s.slotTarget[2]).toBe(1);
		});

		it('sends Other itself to the far end, having nowhere else to go', () => {
			const s = new BandScaleState('species', [], {
				gpuCoordinator: { addAnimatingScale: () => {} }
			});
			s.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Other']));
			s.setOtherId(2);
			s.addMark(['Adelie', 'Chinstrap', 'Other'], 'mark-1');
			// Other FIRST, so its exit has somewhere to travel. With Other already
			// at the end there is no journey to observe, and a test that cannot see
			// the difference between "went to the far end" and "did not move"
			// cannot check that it did not try to leave through itself.
			s.setSortOrder(['Other', 'Adelie', 'Chinstrap']);
			s.updateDomainFromExtents();
			expect(s.slotTable[2]).toBe(0);

			s.addMark(['Adelie', 'Chinstrap'], 'mark-1');
			s.updateDomainFromExtents();

			// Two slots remain, so the far end is 2. If Other took its own slot as
			// its gateway it would sit at 0 and never travel.
			let steps = 0;
			let furthest = -1;
			while (steps < 5000 && !s.isAtRest()) {
				s.step();
				s.updateRenderState(0);
				furthest = Math.max(furthest, s.slotTable[2]);
				steps++;
			}
			expect(steps).toBeLessThan(5000);
			expect(furthest).toBeCloseTo(2, 2);

			s._markAtRest();
			expect(s.slotTable[2]).toBe(-1);
		});

		it('moves everything on one clock, so ids with different distances arrive together', () => {
			// The defining property of a single driver, and the reason it is not a
			// compromise: A travels one slot while D travels three, so a shared `t`
			// moves them at proportionally different SPEEDS and lands them on the
			// same frame. Independent springs would finish raggedly.
			const s = new BandScaleState('species', [], {
				gpuCoordinator: { addAnimatingScale: () => {} }
			});
			s.setIdentity(new FieldIdentity(['A', 'B', 'C', 'D']));
			s.addMark(['A', 'B', 'C', 'D'], 'mark-1');
			s.updateDomainFromExtents();
			expect(Array.from(s.slotTable)).toEqual([0, 1, 2, 3]);

			// D to the front: A 0->1 (one slot), D 3->0 (three).
			s.setSortOrder(['D', 'A', 'B', 'C']);
			s.updateDomainFromExtents();

			let steps = 0;
			let sawMotion = false;
			while (steps < 5000 && !s.isAtRest()) {
				s.step();
				s.updateRenderState(0);
				const fracA = (s.slotTable[0] - 0) / (1 - 0);
				const fracD = (s.slotTable[3] - 3) / (0 - 3);
				expect(fracA).toBeCloseTo(fracD, 6);
				if (fracA > 0.01 && fracA < 0.99) sawMotion = true;
				steps++;
			}
			// The assertion above is vacuous if the transition never had a middle.
			expect(sawMotion).toBe(true);

			s._markAtRest();
			expect(Array.from(s.slotTable)).toEqual([1, 2, 3, 0]);
		});

		it('folds a mid-flight retarget, continuing from where it is', () => {
			// New data under a drag is the NORMAL case. The animation must carry on
			// from where things actually are, so current position becomes the new
			// `from` before t resets — otherwise every result restarts the journey
			// and a bar sliding out stutters instead of sliding.
			const s = new BandScaleState('species', [], {
				gpuCoordinator: { addAnimatingScale: () => {} }
			});
			s.setIdentity(new FieldIdentity(['A', 'B', 'C']));
			s.addMark(['A', 'B', 'C'], 'mark-1');
			s.updateDomainFromExtents();

			s.setSortOrder(['C', 'B', 'A']);
			s.updateDomainFromExtents();

			// Get genuinely mid-flight.
			for (let i = 0; i < 20; i++) {
				s.step();
				s.updateRenderState(0);
			}
			const midFlight = Array.from(s.slotTable);
			expect(midFlight[0]).toBeGreaterThan(0);
			expect(midFlight[0]).toBeLessThan(2);

			// A third order arrives while that is still running.
			s.setSortOrder(['B', 'A', 'C']);
			s.updateDomainFromExtents();

			// The table does not jump on the frame the new result lands: the fold
			// captured where each id was. Without it these would snap back to the
			// positions the PREVIOUS transition started from.
			expect(Array.from(s.slotTable)).toEqual(midFlight);

			let steps = 0;
			while (steps < 5000 && !s.isAtRest()) {
				s.step();
				s.updateRenderState(0);
				steps++;
			}
			s._markAtRest();
			expect(Array.from(s.slotTable)).toEqual([1, 0, 2]);
		});

		it('completes an exit that has nowhere to travel, instead of stranding it', () => {
			// Other is ALREADY at the far end, so its gateway is the slot it is
			// standing on and the exit is a zero-length journey.
			//
			// Per-id springs left the table untouched in this case — nothing was
			// "moving", so neither the loop nor the settle path ran, and a category
			// that had left the domain stayed drawn at its old slot indefinitely.
			// One driver makes the no-op case take the settle path like any other.
			const s = new BandScaleState('species', [], {
				gpuCoordinator: { addAnimatingScale: () => {} }
			});
			s.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Other']));
			s.setOtherId(2);
			s.addMark(['Adelie', 'Chinstrap', 'Other'], 'mark-1');
			s.updateDomainFromExtents();
			expect(s.slotTable[2]).toBe(2);

			s.addMark(['Adelie', 'Chinstrap'], 'mark-1');
			s.updateDomainFromExtents();

			expect(s.slotTarget[2]).toBe(-1);
			expect(s.slotTable[2]).toBe(-1);
		});

		it('still snaps the FIRST layout, so a chart does not slide in on load', () => {
			// Every category is entering on an opening frame. Animating that would
			// slide every bar in from off-axis on every chart, every load.
			const { s, registered } = withLoop();
			expect(Array.from(s.slotTable)).toEqual([0, 1, 2]);
			expect(registered).toEqual([]);
		});

		it('reverses an exit that changes its mind, rather than restarting it', () => {
			const { s } = withLoop();
			s.addMark(['Adelie', 'Gentoo'], 'mark-1');
			s.updateDomainFromExtents();
			for (let i = 0; i < 20; i++) {
				s.step();
				s.updateRenderState(0);
			}
			const midExit = s.slotTable[1];
			expect(midExit).toBeGreaterThan(1);

			// Back before it landed. It should resume from where it is.
			s.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
			s.updateDomainFromExtents();
			expect(s.slotTable[1]).toBeCloseTo(midExit, 5);
			expect(s.slotTarget[1]).toBe(1);
		});
	});

	// The slot table is now a target and a current (§9.5, step 5 C1).
	//
	// C1's whole assertion is that splitting them changes nothing: with no
	// spring, slotCurrent is settled straight onto slotTarget, so the array the
	// GPU reads is byte-for-byte what it was before the split. These pin that,
	// and they are the tests that have to START FAILING at C3 — a spring that
	// leaves them passing mid-transition is a spring that is not interpolating.
	describe('slot target and current', () => {
		function reordered(): BandScaleState {
			const scale = new BandScaleState('species');
			scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
			scale.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
			scale.setSortOrder(['Gentoo', 'Adelie', 'Chinstrap']);
			scale.updateDomainFromExtents();
			return scale;
		}

		it('agree exactly, because nothing interpolates yet', () => {
			const scale = reordered();
			expect(Array.from(scale.slotTable)).toEqual(Array.from(scale.slotTarget));
		});

		it('slotTable is slotCurrent, and it is what the reorder produced', () => {
			const scale = reordered();
			// Ids alphabetical; display order Gentoo, Adelie, Chinstrap. So
			// Adelie(0) sits at slot 1, Chinstrap(1) at 2, Gentoo(2) at 0.
			expect(Array.from(scale.slotTable)).toEqual([1, 2, 0]);
			expect(Array.from(scale.slotTarget)).toEqual([1, 2, 0]);
		});

		it('keeps -1 for an id the scale does not display', () => {
			const scale = new BandScaleState('species');
			scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
			scale.addMark(['Adelie', 'Gentoo'], 'topn');
			scale.updateDomainFromExtents();

			// Chinstrap(1) is in the dim but not on this axis. Both arrays must
			// say so: a target of -1 that settles to something else would draw a
			// filtered category at a real slot.
			expect(Array.from(scale.slotTarget)).toEqual([0, -1, 1]);
			expect(Array.from(scale.slotTable)).toEqual([0, -1, 1]);
		});

		it('reuses its arrays across a reorder, and resizes when the dim grows', () => {
			const scale = reordered();
			const before = scale.slotTable;

			scale.setSortOrder(['Chinstrap', 'Gentoo', 'Adelie']);
			scale.updateDomainFromExtents();
			// Same length, so the same object — a reorder must not allocate, which
			// is what makes this safe to drive from a per-frame spring later.
			expect(scale.slotTable).toBe(before);
			expect(Array.from(scale.slotTable)).toEqual([2, 0, 1]);

			// A second table appends to the dim: the arrays have to grow with it,
			// or an id past the old end would index off the table.
			scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo', 'Emperor']));
			scale.addMark(['Adelie', 'Chinstrap', 'Gentoo', 'Emperor'], 'mark-2');
			scale.updateDomainFromExtents();
			expect(scale.slotTable.length).toBe(4);
			expect(scale.slotTable.length).toBe(scale.slotTarget.length);
		});

		it('bumps slotVersion when it settles, so the packer re-uploads', () => {
			const scale = reordered();
			const v = scale.slotVersion;
			scale.setSortOrder(['Chinstrap', 'Gentoo', 'Adelie']);
			scale.updateDomainFromExtents();
			expect(scale.slotVersion).toBeGreaterThan(v);
		});
	});

	// A re-sort has to REORDER, not just be remembered.
	//
	// Every other test around this one calls updateDomainFromExtents() by hand
	// after setSortOrder, which is why none of them caught that the production
	// path never does. MarkLifecycleV2's sort effect runs the sidecar and ends
	// at setSortOrder — nothing downstream of it recomputed anything, so a
	// reactive sort change moved no bars at all (§3.1, §32.7). These tests
	// deliberately do NOT crank the handle.
	describe('a re-sort schedules its own domain update', () => {
		function sorted(): BandScaleState {
			const scale = new BandScaleState('species');
			scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
			scale.addMark(['Adelie', 'Chinstrap', 'Gentoo'], 'mark-1');
			scale.updateDomainFromExtents();
			return scale;
		}

		it('reorders the domain without the caller cranking the handle', async () => {
			const scale = sorted();
			expect(scale.effectiveDomain).toEqual(['Adelie', 'Chinstrap', 'Gentoo']);

			scale.setSortOrder(['Gentoo', 'Adelie', 'Chinstrap']);
			// The update is scheduled on a microtask, as it is for addMark.
			await Promise.resolve();

			expect(scale.effectiveDomain).toEqual(['Gentoo', 'Adelie', 'Chinstrap']);
		});

		it('moves the slot table with it, which is what the GPU reads', async () => {
			const scale = sorted();
			scale.setSortOrder(['Gentoo', 'Adelie', 'Chinstrap']);
			await Promise.resolve();

			// slotTable is indexed by id and holds the display slot. Ids are
			// alphabetical, so Adelie(0) is now at slot 1, Chinstrap(1) at 2 and
			// Gentoo(2) at 0. A reorder that moved #domain but not this would draw
			// the old order while labelling the new one.
			expect(Array.from(scale.slotTable)).toEqual([1, 2, 0]);
			expect(Array.from(scale.displayOrder)).toEqual([2, 0, 1]);
		});

		it('a partial preferred order pulls its members to the front', async () => {
			// Why handing an UNFILTERED SELECT DISTINCT to setSortOrder was so
			// damaging. A preferred order need not cover the domain, and whatever
			// it does cover is moved ahead of everything else — so a five-category
			// DISTINCT over the base table dictated the order of a three-category
			// topN axis, rotating ranked rows into DuckDB's hash order.
			//
			// The numbers below are the real case: rows arrived ranked A, B, C and
			// rendered B, C, A, because the DISTINCT happened to come back
			// E, B, C, D, A.
			const scale = new BandScaleState('species');
			scale.setIdentity(new FieldIdentity(['A', 'B', 'C', 'D', 'E']));
			scale.addMark(['A', 'B', 'C'], 'topn-mark');
			scale.updateDomainFromExtents();
			expect(scale.effectiveDomain).toEqual(['A', 'B', 'C']);

			scale.setSortOrder(['E', 'B', 'C', 'D', 'A']);
			await Promise.resolve();

			expect(scale.effectiveDomain).toEqual(['B', 'C', 'A']);
		});

		it('does not leak categories that are not in the extents', async () => {
			// What setSortOrder is named for: the sidecar ranks the FULL dataset
			// while a topN mark's extents hold only the survivors. Scheduling must
			// not put the losers on the axis — the intersection in
			// updateDomainFromExtents is what prevents it.
			const scale = new BandScaleState('species');
			scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
			scale.addMark(['Adelie', 'Gentoo'], 'topn-mark');
			scale.updateDomainFromExtents();

			scale.setSortOrder(['Gentoo', 'Chinstrap', 'Adelie']);
			await Promise.resolve();

			expect(scale.effectiveDomain).toEqual(['Gentoo', 'Adelie']);
		});

		it('stays put while the scale is frozen', async () => {
			const scale = sorted();
			scale.setUpdatesEnabled(false);

			scale.setSortOrder(['Gentoo', 'Adelie', 'Chinstrap']);
			await Promise.resolve();

			expect(scale.effectiveDomain).toEqual(['Adelie', 'Chinstrap', 'Gentoo']);
		});
	});

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

describe('BandScaleState after the registry tears it down', () => {
	// §25.4. ScaleRegistry destroys a scale when its chart-id usage hits zero and
	// then drops it from storage — but a component can still hold the reference,
	// and a faceted container guarantees it: it obtains the facet scale, hands it
	// to its cells, and stops being a chart itself.
	//
	// destroy() used to clear #extents, #explicitDomain and #frozenDomain, which
	// is how an explicit fxDomain vanished with no error and no symptom beyond
	// an ordering that did not apply.

	it('keeps the state a still-referenced holder depends on', () => {
		const scale = new BandScaleState('species');
		scale.setIdentity(new FieldIdentity(['Adelie', 'Chinstrap', 'Gentoo']));
		scale.addMark(['Gentoo', 'Adelie', 'Chinstrap'], 'mark-1', { explicit: true });
		scale.updateDomainFromExtents();

		scale.destroy();
		scale.updateDomainFromExtents();

		// The explicit ordering survives, because nothing else can ever be handed
		// this instance: the registry builds a fresh one for the next request.
		expect(scale.effectiveDomain).toEqual(['Gentoo', 'Adelie', 'Chinstrap']);
		expect(Array.from(scale.displayOrder)).toEqual([2, 0, 1]);
	});

	it('reports itself destroyed', () => {
		const scale = new BandScaleState('species');
		expect(scale.isDestroyed).toBe(false);
		scale.destroy();
		expect(scale.isDestroyed).toBe(true);
	});

	it('warns once when state is registered after destroy', () => {
		// Loud rather than silent: registering on a dead scale means a holder is
		// not counted in the registry, which is the actual defect. Once only —
		// this is reachable from a render path.
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const scale = new BandScaleState('species');
		scale.destroy();

		scale.addMark(['Adelie'], 'mark-1');
		scale.addMark(['Chinstrap'], 'mark-2');
		scale.setSortOrder(['Adelie']);

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][0]).toContain('after destroy()');
		spy.mockRestore();
	});

	it('does not warn on a live scale', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const scale = new BandScaleState('species');
		scale.addMark(['Adelie'], 'mark-1');
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});
