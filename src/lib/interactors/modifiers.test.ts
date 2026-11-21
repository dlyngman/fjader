import { describe, it, expect } from 'vitest';
import { isContextPress, isMultiSelect } from './modifiers';

const click = (mods: Partial<PointerEvent>) =>
	({ button: 0, shiftKey: false, metaKey: false, ctrlKey: false, ...mods }) as PointerEvent;

describe('modifiers by platform', () => {
	it('multi-select: Shift everywhere; Cmd on a Mac, Ctrl elsewhere', () => {
		expect(isMultiSelect(click({ shiftKey: true }), true)).toBe(true);
		expect(isMultiSelect(click({ shiftKey: true }), false)).toBe(true);
		expect(isMultiSelect(click({ metaKey: true }), true)).toBe(true);
		expect(isMultiSelect(click({ ctrlKey: true }), true)).toBe(false);
		expect(isMultiSelect(click({ ctrlKey: true }), false)).toBe(true);
		expect(isMultiSelect(click({ metaKey: true }), false)).toBe(false);
		expect(isMultiSelect(click({}), false)).toBe(false);
	});

	it('context press: a non-primary button anywhere; Ctrl+click only on a Mac', () => {
		expect(isContextPress(click({ button: 2 }), false)).toBe(true);
		expect(isContextPress(click({ button: 1 }), true)).toBe(true);
		expect(isContextPress(click({ ctrlKey: true }), true)).toBe(true);
		expect(isContextPress(click({ ctrlKey: true }), false)).toBe(false);
		expect(isContextPress(click({}), true)).toBe(false);
	});
});
