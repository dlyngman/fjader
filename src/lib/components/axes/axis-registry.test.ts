import { describe, it, expect } from 'vitest';
import {
	AxisRegistry,
	type AxisSpec,
	type FrameSpec,
	type ParallelAxesSpec
} from './axis-registry.svelte';

function makeAxis(id: string, side: 'bottom' | 'left' = 'bottom'): AxisSpec {
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

describe('AxisRegistry', () => {
	it('stores all declarations in one kind-keyed list and filters them by kind', () => {
		const registry = new AxisRegistry();
		const bottom = makeAxis('axis-bottom-1', 'bottom');
		const left = makeAxis('axis-left-1', 'left');
		const parallel: ParallelAxesSpec = { id: 'parallel-1', ticksNumber: 5, tickFormat: null };
		const frame: FrameSpec = { id: 'frame-1' };

		registry.register(bottom);
		registry.registerFrame(frame);
		registry.register(left);
		registry.registerParallel(parallel);

		expect(registry.declarations.map((d) => [d.kind, d.spec.id])).toEqual([
			['axis', 'axis-bottom-1'],
			['frame', 'frame-1'],
			['axis', 'axis-left-1'],
			['parallel', 'parallel-1']
		]);
		expect(registry.axes).toEqual([bottom, left]);
		expect(registry.parallel).toEqual([parallel]);
		expect(registry.frames).toEqual([frame]);
	});

	it('replaces the declarations array on register and unregister', () => {
		const registry = new AxisRegistry();
		const initial = registry.declarations;

		const unregisterFrame = registry.registerFrame({ id: 'frame-1' });
		const afterRegister = registry.declarations;
		expect(afterRegister).not.toBe(initial);
		expect(registry.frames).toHaveLength(1);

		const unregisterAxis = registry.register(makeAxis('axis-1'));
		expect(registry.axes).toHaveLength(1);
		expect(registry.frames).toHaveLength(1);

		unregisterFrame();
		expect(registry.declarations).not.toBe(afterRegister);
		expect(registry.frames).toEqual([]);
		expect(registry.axes.map((a) => a.id)).toEqual(['axis-1']);

		unregisterAxis();
		expect(registry.declarations).toEqual([]);
		expect(registry.axes).toEqual([]);
	});
});
