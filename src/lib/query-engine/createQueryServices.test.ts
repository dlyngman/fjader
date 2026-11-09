import { describe, it, expect, vi } from 'vitest';
import { createQueryServices } from './index';
import type { QueryEngine } from './QueryEngine';

/** The parts of QueryEngine a FilterGroup calls. */
function mockEngine() {
	return {
		activate: vi.fn(() => Promise.resolve()),
		onFilterChange: vi.fn(),
		onClauseChange: vi.fn(),
		forgetSource: vi.fn(),
		identitySqlFor: () => null
	};
}

describe('createQueryServices', () => {
	it('connects named groups to the engine, so a brush re-queries', () => {
		const engine = mockEngine();
		const { filterGroups } = createQueryServices(engine as unknown as QueryEngine);

		const group = filterGroups.get('brush');
		group.register('brush-x', {}).update('x > 0', null);

		expect(engine.onClauseChange).toHaveBeenCalledWith(
			group,
			'brush-x',
			undefined,
			expect.anything()
		);
	});

	it('connects the default group too', () => {
		const engine = mockEngine();
		const { filterGroups } = createQueryServices(engine as unknown as QueryEngine);

		const group = filterGroups.get();
		group.register('brush-x', {}).update('x > 0', null);

		expect(engine.onClauseChange).toHaveBeenCalledWith(
			group,
			'brush-x',
			undefined,
			expect.anything()
		);
	});
});
