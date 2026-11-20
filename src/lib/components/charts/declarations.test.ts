import { describe, it, expect } from 'vitest';
import {
	DeclarationRegistry,
	orderOverlays,
	type ChartDeclaration,
	type FrameSpec,
	type OverlaySpec
} from './declarations.svelte';
import type { AxisSpec, ParallelAxesSpec } from '../axes/axis-spec';

function axis(id: string, side: 'bottom' | 'left' = 'bottom'): AxisSpec {
	return {
		id,
		side,
		ticksNumber: 5,
		tickFormat: null,
		title: true,
		titleAnchor: 'center',
		titleOffset: 32,
		titlePlacement: 'side'
	};
}

describe('DeclarationRegistry', () => {
	it('keeps one list in registration order, and a cell reads each kind from it', () => {
		const registry = new DeclarationRegistry();
		const bottom = axis('axis-bottom-1', 'bottom');
		const left = axis('axis-left-1', 'left');
		const parallel: ParallelAxesSpec = { id: 'parallel-1', ticksNumber: 5, tickFormat: null };
		const frame: FrameSpec = { id: 'frame-1' };

		registry.register({ kind: 'axis', spec: bottom, cellId: null });
		registry.register({ kind: 'frame', spec: frame, cellId: null });
		registry.register({ kind: 'axis', spec: left, cellId: null });
		registry.register({ kind: 'parallel', spec: parallel, cellId: null });

		expect(registry.declarations.map((d) => [d.kind, 'id' in d.spec ? d.spec.id : ''])).toEqual([
			['axis', 'axis-bottom-1'],
			['frame', 'frame-1'],
			['axis', 'axis-left-1'],
			['parallel', 'parallel-1']
		]);
		const cell = registry.forCell('cell-a');
		expect(cell.axes).toEqual([bottom, left]);
		expect(cell.parallel).toEqual([parallel]);
		expect(cell.frames).toEqual([frame]);
	});

	it('a cell draws the declarations for every cell and its own, not another cell’s', () => {
		const registry = new DeclarationRegistry();
		const shared = axis('shared');
		const a = axis('only-a');
		const b = axis('only-b');
		registry.register({ kind: 'axis', spec: shared, cellId: null });
		registry.register({ kind: 'axis', spec: a, cellId: 'cell-a' });
		registry.register({ kind: 'axis', spec: b, cellId: 'cell-b' });

		expect(registry.forCell('cell-a').axes).toEqual([shared, a]);
		expect(registry.forCell('cell-b').axes).toEqual([shared, b]);
		expect(registry.forCell('cell-c').axes).toEqual([shared]);
	});

	it('a facet grid’s per-cell snippets give one declaration per cell, each drawn once', () => {
		// The same <Frame /> in a per-cell snippet, rendered once per cell.
		const registry = new DeclarationRegistry();
		const cells = ['fx-0', 'fx-1', 'fx-2'];
		for (const cellId of cells) {
			registry.register({ kind: 'frame', spec: { id: `frame-${cellId}` }, cellId });
		}
		for (const cellId of cells) {
			expect(registry.forCell(cellId).frames.map((f) => f.id)).toEqual([`frame-${cellId}`]);
		}
	});

	it('unregistering replaces the list and removes only that declaration', () => {
		const registry = new DeclarationRegistry();
		const initial = registry.declarations;
		const frame: ChartDeclaration = { kind: 'frame', spec: { id: 'frame-1' }, cellId: null };
		const unregisterFrame = registry.register(frame);
		const afterRegister = registry.declarations;
		expect(afterRegister).not.toBe(initial);

		const unregisterAxis = registry.register({ kind: 'axis', spec: axis('axis-1'), cellId: 'c' });
		unregisterFrame();
		expect(registry.declarations).not.toBe(afterRegister);
		expect(registry.forCell('c').frames).toEqual([]);
		expect(registry.forCell('c').axes.map((s) => s.id)).toEqual(['axis-1']);

		unregisterAxis();
		expect(registry.declarations).toEqual([]);
	});
});

describe('overlays', () => {
	// The snippet is never rendered here: only the specs' identity and order matter.
	const snippet = (() => {}) as unknown as OverlaySpec['snippet'];
	const overlay = (slot: OverlaySpec['slot'], zIndex = 0): OverlaySpec => ({
		snippet,
		slot,
		zIndex
	});

	it('orders by zIndex, registration order breaking ties, and keeps the specs', () => {
		const a = overlay('clipped');
		const b = overlay('clipped', -1);
		const c = overlay('clipped');
		const d = overlay('clipped', 2);
		const ordered = orderOverlays([a, b, c, d]);
		expect(ordered).toEqual([b, a, c, d]);
		// The same objects, so a keyed {#each} keeps each mounted.
		expect(ordered[1]).toBe(a);
	});

	it('a cell draws its slot only: every cell’s and its own, not another cell’s', () => {
		const registry = new DeclarationRegistry();
		const crosshair = overlay('clipped');
		const readout = overlay('margins');
		const own = overlay('clipped', 1);
		const other = overlay('clipped');
		registry.register({ kind: 'overlay', spec: crosshair, cellId: null });
		registry.register({ kind: 'overlay', spec: readout, cellId: null });
		registry.register({ kind: 'overlay', spec: own, cellId: 'cell-a' });
		registry.register({ kind: 'overlay', spec: other, cellId: 'cell-b' });
		const cell = registry.forCell('cell-a');
		expect(cell.overlays('clipped')).toEqual([crosshair, own]);
		expect(cell.overlays('margins')).toEqual([readout]);
	});
});
