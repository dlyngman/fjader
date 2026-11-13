import { describe, it, expect } from 'vitest';
import { TransitionClock, TRANSITION_STIFFNESS, type ClockLoop } from './TransitionClock';
import { DT } from './Spring';

/**
 * A loop that behaves like the coordinator's: a set of sources, and a settle
 * sweep that removes a source BEFORE telling it — so a source that restarts
 * from its rest callback rejoins.
 */
function fakeLoop() {
	const sources = new Set<TransitionClock>();
	let adds = 0;
	const loop: ClockLoop = {
		addAnimatedSource: (s) => {
			adds++;
			sources.add(s);
		},
		removeAnimatedSource: (s) => {
			sources.delete(s);
		}
	};
	/** Drive every source to rest and run the settle sweep. */
	const runToRest = () => {
		for (let n = 0; n < 5000 && [...sources].some((s) => !s.isAtRest()); n++) {
			for (const s of sources) {
				s.step();
				s.updateRenderState(0);
			}
		}
		for (const s of [...sources]) {
			if (!s.isAtRest()) continue;
			sources.delete(s);
			s._markAtRest();
		}
	};
	return { loop, sources, runToRest, adds: () => adds };
}

describe('TransitionClock and the loop', () => {
	it('joins the loop on restart, once while it runs', () => {
		const f = fakeLoop();
		const clock = new TransitionClock({ loop: f.loop });

		clock.restart();
		clock.restart();
		expect(f.sources.has(clock)).toBe(true);
		expect(f.adds()).toBe(1);
		expect(clock.running).toBe(true);
		expect(clock.t).toBe(0);
	});

	it('rejoins on the first restart after the loop has settled it', () => {
		const f = fakeLoop();
		const clock = new TransitionClock({ loop: f.loop });
		clock.restart();
		f.runToRest();

		expect(clock.running).toBe(false);
		expect(clock.t).toBe(1);
		expect(f.sources.has(clock)).toBe(false);

		clock.restart();
		expect(f.sources.has(clock)).toBe(true);
		expect(clock.running).toBe(true);
	});

	it('rejoins when its owner restarts it from the rest callback', () => {
		// The sweep removes before it calls _markAtRest. The other order would
		// add a clock that is already present — a no-op — and then remove it,
		// leaving it "running" at t = 0 with nothing driving it.
		const f = fakeLoop();
		let restarted = false;
		const clock: TransitionClock = new TransitionClock({
			loop: f.loop,
			onRest: () => {
				if (restarted) return;
				restarted = true;
				clock.restart();
			}
		});
		clock.restart();
		f.runToRest();

		expect(restarted).toBe(true);
		expect(f.sources.has(clock)).toBe(true);
		expect(clock.running).toBe(true);
	});

	it('lands at once when there is no loop to drive it', () => {
		let rests = 0;
		const clock = new TransitionClock({ onRest: () => rests++ });
		const version = clock.version;

		clock.restart();
		// Still a restart: consumers that fold on the version see one.
		expect(clock.version).toBe(version + 1);
		expect(clock.t).toBe(1);
		expect(clock.running).toBe(false);
		expect(rests).toBe(1);
	});

	it('hands back the same empty list every frame when nothing supplied one', () => {
		// The loop reads this once per frame per clock it drives. Returning a
		// fresh [] was an allocation per frame on the animation path, for a
		// value that never changes.
		const clock = new TransitionClock();
		expect(clock._affectedChartsArray).toEqual([]);
		expect(clock._affectedChartsArray).toBe(clock._affectedChartsArray);
	});

	it('asks its owner every read, so a list that grows later is seen', () => {
		// The counterpart: the owner's list is NOT cached here. A facet grid
		// registers its cells after the mark's first data has landed.
		const charts: string[] = ['chart-a'];
		const clock = new TransitionClock({ charts: () => charts });
		expect(clock._affectedChartsArray).toEqual(['chart-a']);
		charts.push('chart-b');
		expect(clock._affectedChartsArray).toEqual(['chart-a', 'chart-b']);
	});

	it('leaves the loop on stop, and stopping a clock at rest does nothing', () => {
		const f = fakeLoop();
		const clock = new TransitionClock({ loop: f.loop });
		clock.stop();
		expect(f.sources.size).toBe(0);

		clock.restart();
		clock.stop();
		expect(f.sources.has(clock)).toBe(false);
		expect(clock.running).toBe(false);
	});

	it('stays stopped, and a later restart lands at once instead of rejoining', () => {
		// stop() is for an owner being torn down. Rejoining the loop afterwards
		// would animate for nobody and keep the loop awake doing it. Landing at
		// once is the same answer a clock with no loop gives, and it leaves the
		// consumer's state coherent rather than stuck mid transition.
		const f = fakeLoop();
		let rests = 0;
		const clock = new TransitionClock({ loop: f.loop, onRest: () => rests++ });

		clock.restart();
		expect(f.sources.has(clock)).toBe(true);
		clock.stop();
		rests = 0;

		clock.restart();
		expect(f.sources.has(clock)).toBe(false);
		expect(clock.running).toBe(false);
		// Landed, not abandoned: t is at the end and the owner was told.
		expect(clock.t).toBe(1);
		expect(rests).toBe(1);
		// And the version still moved, so a consumer folds onto the new target.
		expect(clock.version).toBeGreaterThan(0);
	});
});

describe('TransitionClock.restartEaseOut', () => {
	/** t after `ms` of physics steps, at the default stiffness. */
	function tAfter(ms: number, start: (c: TransitionClock) => void): number {
		const { loop } = fakeLoop();
		const clock = new TransitionClock({ loop });
		start(clock);
		const steps = Math.round(ms / 1000 / DT);
		for (let i = 0; i < steps; i++) clock.step();
		clock.updateRenderState(0);
		return clock.t;
	}

	it('moves from the first frames, where a restart from rest barely starts', () => {
		const eased = tAfter(50, (c) => c.restartEaseOut());
		const fromRest = tAfter(50, (c) => c.restart());
		const omega = Math.sqrt(TRANSITION_STIFFNESS);
		expect(eased).toBeCloseTo(1 - Math.exp(-omega * 0.05), 2);
		expect(fromRest).toBeLessThan(0.25);
		expect(eased).toBeGreaterThan(0.5);
	});

	it('rises monotonically: no overshoot and return, which the clamp to 1 would hide', () => {
		const { loop } = fakeLoop();
		const clock = new TransitionClock({ loop });
		clock.restartEaseOut();
		let last = 0;
		for (let i = 0; i < 2000 && !clock.isAtRest(); i++) {
			clock.step();
			clock.updateRenderState(0);
			expect(clock.t).toBeGreaterThanOrEqual(last);
			last = clock.t;
		}
		expect(last).toBeGreaterThan(0.99);
	});
});
