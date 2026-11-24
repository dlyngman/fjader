import { describe, it, expect } from 'vitest';
import { backgroundBehind, schemeOfColor } from './hostScheme';

describe('schemeOfColor', () => {
	it('reads light and dark backgrounds', () => {
		expect(schemeOfColor(255, 255, 255)).toBe('light');
		expect(schemeOfColor(0, 0, 0)).toBe('dark');
		// JupyterLab's dark theme and marimo's dark background
		expect(schemeOfColor(0x11, 0x11, 0x11)).toBe('dark');
		expect(schemeOfColor(0x18, 0x18, 0x1b)).toBe('dark');
		// a light grey page
		expect(schemeOfColor(0xf5, 0xf5, 0xf5)).toBe('light');
	});

	it('splits at about mid grey', () => {
		expect(schemeOfColor(0x80, 0x80, 0x80)).toBe('light');
		expect(schemeOfColor(0x70, 0x70, 0x70)).toBe('dark');
	});
});

describe('backgroundBehind', () => {
	// A fake tree: each node names its parent and its background.
	type Node = { name: string; up: Node | null; bg: [number, number, number, number] };
	const clear: [number, number, number, number] = [0, 0, 0, 0];
	const node = (name: string, up: Node | null, bg = clear): Node => ({ name, up, bg });
	const walk = (el: Node) =>
		backgroundBehind<Node>(
			el,
			(n) => n.bg,
			(n) => n.up
		);

	it('takes the first ancestor with a background, not the element itself', () => {
		const page = node('body', null, [24, 24, 27, 255]);
		const cell = node('output', page);
		const widget = node('widget', cell, [255, 255, 255, 255]);
		expect(walk(widget)).toEqual([24, 24, 27]);
	});

	it('steps past transparent ancestors, as across a shadow root to its host', () => {
		const page = node('body', null, [255, 255, 255, 255]);
		const host = node('marimo-anywidget', page);
		const shadowChild = node('div', host);
		expect(walk(node('widget', shadowChild))).toEqual([255, 255, 255]);
	});

	it('is null when nothing behind has a background', () => {
		expect(walk(node('widget', node('body', null)))).toBeNull();
	});
});
