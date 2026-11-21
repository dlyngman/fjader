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
	it('keeps one list in registration order, and reads each kind from it', () => {
		const registry = new DeclarationRegistry();
		const bottom = axis('axis-bottom-1', 'bottom');
		const left = axis('axis-left-1', 'left');
		const parallel: ParallelAxesSpec = { id: 'parallel-1', ticksNumber: 5, tickFormat: null };
		const frame: FrameSpec = { id: 'frame-1' };

		registry.register({ kind: 'axis', spec: bottom });
		registry.register({ kind: 'frame', spec: frame });
		registry.register({ kind: 'axis', spec: left });
		registry.register({ kind: 'parallel', spec: parallel });

		expect(registry.declarations.map((d) => [d.kind, 'id' in d.spec ? d.spec.id : ''])).toEqual([
			['axis', 'axis-bottom-1'],
			['frame', 'frame-1'],
			['axis', 'axis-left-1'],
			['parallel', 'parallel-1']
		]);
		expect(registry.axes).toEqual([bottom, left]);
		expect(registry.parallel).toEqual([parallel]);
		expect(registry.frames).toEqual([frame]);
	});

	it('unregistering replaces the list and removes only that declaration', () => {
		const registry = new DeclarationRegistry();
		const initial = registry.declarations;
		const frame: ChartDeclaration = { kind: 'frame', spec: { id: 'frame-1' } };
		const unregisterFrame = registry.register(frame);
		const afterRegister = registry.declarations;
		expect(afterRegister).not.toBe(initial);

		const unregisterAxis = registry.register({ kind: 'axis', spec: axis('axis-1') });
		unregisterFrame();
		expect(registry.declarations).not.toBe(afterRegister);
		expect(registry.frames).toEqual([]);
		expect(registry.axes.map((s) => s.id)).toEqual(['axis-1']);

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

	it('lists a slot’s overlays only, in draw order', () => {
		const registry = new DeclarationRegistry();
		const crosshair = overlay('clipped');
		const readout = overlay('margins');
		const above = overlay('clipped', 1);
		const brush = overlay('interactors');
		registry.register({ kind: 'overlay', spec: above });
		registry.register({ kind: 'overlay', spec: crosshair });
		registry.register({ kind: 'overlay', spec: readout });
		registry.register({ kind: 'overlay', spec: brush });
		expect(registry.overlays('clipped')).toEqual([crosshair, above]);
		expect(registry.overlays('margins')).toEqual([readout]);
		expect(registry.overlays('interactors')).toEqual([brush]);
	});
});
