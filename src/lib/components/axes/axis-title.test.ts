import { describe, it, expect } from 'vitest';
import { clearTitleOffset, textWidth, DEFAULT_TITLE_OFFSET } from './axis-title';

describe('clearTitleOffset', () => {
	it('keeps the default for short labels', () => {
		expect(clearTitleOffset(10, 75)).toBe(DEFAULT_TITLE_OFFSET);
	});

	it('moves out past the widest label, its gap and a clearance', () => {
		expect(clearTitleOffset(40, 75)).toBe(9 + 40 + 6);
	});

	it('stays inside the margin, with room for the title itself', () => {
		expect(clearTitleOffset(120, 75)).toBe(65);
	});

	it('never goes negative in a very narrow margin', () => {
		expect(clearTitleOffset(20, 4)).toBe(0);
	});
});

describe('textWidth', () => {
	it('measures a label, and the same label the same each time', () => {
		// No document under Node: the per-character estimate.
		expect(textWidth('40,000')).toBe(36);
		expect(textWidth('40,000')).toBe(36);
		expect(textWidth('')).toBe(0);
	});
});
