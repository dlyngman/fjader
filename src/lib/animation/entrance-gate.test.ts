import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EntranceGate, ENTRANCE_HOLD_TIMEOUT_MS } from './EntranceGate';

describe('EntranceGate', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('lets a chart with no holding marks enter, without opening itself', () => {
		const gate = new EntranceGate();
		expect(gate.canEnter).toBe(true);
		expect(gate.opened).toBe(false);
	});

	it('opens when the last hold is released, and tells its listeners once', () => {
		const gate = new EntranceGate();
		const opened = vi.fn();
		gate.onOpen(opened);
		gate.hold('a');
		gate.hold('b');
		gate.release('a');
		expect(gate.canEnter).toBe(false);
		gate.release('b');
		expect(gate.opened).toBe(true);
		gate.release('b');
		gate.open();
		expect(opened).toHaveBeenCalledTimes(1);
	});

	it('waits for the slowest mark at most the timeout, counted from the first release', () => {
		const gate = new EntranceGate();
		gate.hold('fast');
		gate.hold('slow');
		// DuckDB starting is not a slow mark: no timer before any data.
		vi.advanceTimersByTime(ENTRANCE_HOLD_TIMEOUT_MS * 5);
		expect(gate.opened).toBe(false);
		gate.release('fast');
		vi.advanceTimersByTime(ENTRANCE_HOLD_TIMEOUT_MS - 1);
		expect(gate.opened).toBe(false);
		vi.advanceTimersByTime(1);
		expect(gate.opened).toBe(true);
	});

	it('ignores holds once open and releases it never saw', () => {
		const gate = new EntranceGate();
		gate.release('stranger');
		expect(gate.opened).toBe(false);
		gate.open();
		gate.hold('late');
		expect(gate.canEnter).toBe(true);
	});

	it('runs a listener added after opening at once, and drops an unsubscribed one', () => {
		const gate = new EntranceGate();
		const dropped = vi.fn();
		const off = gate.onOpen(dropped);
		off();
		gate.open();
		expect(dropped).not.toHaveBeenCalled();
		const late = vi.fn();
		gate.onOpen(late);
		expect(late).toHaveBeenCalledTimes(1);
	});

	it('clears its timer on destroy', () => {
		const gate = new EntranceGate();
		gate.hold('a');
		gate.hold('b');
		gate.release('a');
		gate.destroy();
		vi.advanceTimersByTime(ENTRANCE_HOLD_TIMEOUT_MS * 2);
		expect(gate.opened).toBe(false);
	});
});
