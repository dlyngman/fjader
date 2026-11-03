import { describe, it, expect, vi } from 'vitest';
import { brushHandleAt, createPanModeHandlers } from './brush-utils';

const key = (code: string) => ({ code }) as KeyboardEvent;

describe('createPanModeHandlers', () => {
	function setup() {
		const state = { active: false };
		const reroutePress = vi.fn();
		const handlers = createPanModeHandlers((active) => {
			state.active = active;
		}, reroutePress);
		return { state, reroutePress, ...handlers };
	}

	it('is active while Space is held', () => {
		const { state, handleKeyDown, handleKeyUp } = setup();
		handleKeyDown(key('Space'));
		expect(state.active).toBe(true);
		handleKeyUp(key('Space'));
		expect(state.active).toBe(false);
	});

	it('ignores other keys', () => {
		const { state, reroutePress, handleKeyDown, handleKeyUp } = setup();
		handleKeyDown(key('KeyA'));
		handleKeyUp(key('KeyA'));
		expect(state.active).toBe(false);
		expect(reroutePress).not.toHaveBeenCalled();
	});

	it('re-routes the press when Space goes down and when it comes up', () => {
		const { reroutePress, handleKeyDown, handleKeyUp } = setup();
		handleKeyDown(key('Space'));
		expect(reroutePress).toHaveBeenCalledTimes(1);
		handleKeyUp(key('Space'));
		expect(reroutePress).toHaveBeenCalledTimes(2);
	});

	it('does not re-route on key repeats while Space is held', () => {
		const { reroutePress, handleKeyDown } = setup();
		handleKeyDown(key('Space'));
		handleKeyDown(key('Space'));
		handleKeyDown(key('Space'));
		expect(reroutePress).toHaveBeenCalledTimes(1);
	});

	it('ends pan mode and re-routes when the window loses focus with Space down', () => {
		const { state, reroutePress, handleKeyDown, handleBlur } = setup();
		handleKeyDown(key('Space'));
		handleBlur();
		expect(state.active).toBe(false);
		expect(reroutePress).toHaveBeenCalledTimes(2);
	});

	it('does nothing on blur when Space is up', () => {
		const { reroutePress, handleBlur } = setup();
		handleBlur();
		expect(reroutePress).not.toHaveBeenCalled();
	});
});

/** A minimal element: attributes, and a parent for closest('[attr]'). */
interface FakeElement {
	getAttribute(name: string): string | null;
	closest(selector: string): FakeElement | null;
	parent: FakeElement | null;
}

function fake(attrs: Record<string, string>, parent: FakeElement | null = null): FakeElement {
	const self: FakeElement = {
		getAttribute: (name) => attrs[name] ?? null,
		closest(selector) {
			const name = selector.slice(1, -1);
			for (let e: FakeElement | null = self; e; e = e.parent) {
				if (e.getAttribute(name) != null) return e;
			}
			return null;
		},
		parent
	};
	return self;
}

const el = (attrs: Record<string, string>, parent: FakeElement | null = null) =>
	fake(attrs, parent) as unknown as Element;

describe('brushHandleAt', () => {
	it('reads the handle a press is on', () => {
		const overlay = fake({});
		expect(brushHandleAt(el({ 'data-brush-handle': 'move' }, overlay))).toEqual({
			handle: 'move',
			owner: null
		});
		expect(brushHandleAt(el({ 'data-brush-handle': 'ne' }, overlay))?.handle).toBe('ne');
	});

	it("reads the overlay's owner, for charts with several brushes", () => {
		const overlay = fake({ 'data-brush-owner': 'bill_length' });
		expect(brushHandleAt(el({ 'data-brush-handle': 'top' }, overlay))).toEqual({
			handle: 'top',
			owner: 'bill_length'
		});
	});

	it('is null off the brush', () => {
		expect(brushHandleAt(el({}))).toBeNull();
		expect(brushHandleAt(null)).toBeNull();
	});
});
