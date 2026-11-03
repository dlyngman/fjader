import { describe, it, expect } from 'vitest';
import { createPanModeHandlers } from './brush-utils';

const key = (code: string) => ({ code }) as KeyboardEvent;

describe('createPanModeHandlers', () => {
	function setup() {
		const state = { active: false };
		const handlers = createPanModeHandlers((active) => {
			state.active = active;
		});
		return { state, ...handlers };
	}

	it('is active while Space is held', () => {
		const { state, handleKeyDown, handleKeyUp } = setup();
		handleKeyDown(key('Space'));
		expect(state.active).toBe(true);
		handleKeyUp(key('Space'));
		expect(state.active).toBe(false);
	});

	it('ignores other keys', () => {
		const { state, handleKeyDown } = setup();
		handleKeyDown(key('KeyA'));
		expect(state.active).toBe(false);
	});

	it('ends when the window loses focus with Space still down', () => {
		const { state, handleKeyDown, handleBlur } = setup();
		handleKeyDown(key('Space'));
		handleBlur();
		expect(state.active).toBe(false);
	});
});
