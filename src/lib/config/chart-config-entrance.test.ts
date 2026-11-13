import { describe, it, expect } from 'vitest';
import { ChartConfig } from './ChartConfig.svelte';

/**
 * A data mark holds its chart's entrance from mount — registerMark, which runs
 * synchronously in the mark's script — not from its lifecycle, which is built
 * later in an effect. Held only from the lifecycle, a chart looked empty in
 * between, entered on its first drawable layer, and its axes sprang from the
 * placeholder domain once the real extents arrived.
 */
describe('ChartConfig entrance holds', () => {
	it('holds from registerMark for a mark with a table', () => {
		const config = new ChartConfig();
		config.registerMark('bar-1', 'bary', { table: () => 'penguins' });
		expect(config.entrance.canEnter).toBe(false);
	});

	it('does not hold for a constant mark or one that opts out', () => {
		const config = new ChartConfig();
		config.registerMark('rule-1', 'ruley', { table: () => undefined });
		config.registerMark('slow-1', 'ruley', {
			table: () => 'slow',
			holdsEntrance: () => false
		});
		expect(config.entrance.canEnter).toBe(true);
	});

	it('releases on unregister, so a mark gone before its data never stalls the chart', () => {
		const config = new ChartConfig();
		config.registerMark('a', 'bary', { table: () => 't' });
		config.registerMark('b', 'bary', { table: () => 't' });
		config.unregisterMark('a');
		expect(config.entrance.opened).toBe(false);
		config.unregisterMark('b');
		expect(config.entrance.opened).toBe(true);
	});
});
