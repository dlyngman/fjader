import { describe, it, expect } from 'vitest';
import { TransitionClock, type ClockLoop } from './TransitionClock';

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

	it('leaves the loop on stop, and stopping a clock at rest does nothing', () => {
		const f = fakeLoop();
		const clock = new TransitionClock({ loop: f.loop });
		clock.stop();
		expect(f.sources.size).toBe(0);

		clock.restart();
		clock.stop();
		expect(f.sources.has(clock)).toBe(false);
		expect(clock.running).toBe(false);

		// And a later restart joins again.
		clock.restart();
		expect(f.sources.has(clock)).toBe(true);
	});
});
