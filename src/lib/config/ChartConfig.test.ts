import { describe, it, expect } from 'vitest';
import { ChartConfig } from './ChartConfig.svelte';

function createTestConfig() {
	const config = new ChartConfig();
	const entry = config.registerMark('dot-test', 'dot', {
		table: () => 'penguins',
		fill: () => 'species',
		opacity: () => 0.5
	});
	return { config, entry };
}

describe('ChartConfig', () => {
	describe('setMarkProp / revertMarkProp', () => {
		it('overrides a property via setMarkProp', () => {
			const { config, entry } = createTestConfig();
			expect(entry.fill).toBe('species');

			config.setMarkProp('dot-test', 'fill', 'island');
			expect(entry.fill).toBe('island');
		});

		it('reverts a property via revertMarkProp', () => {
			const { config, entry } = createTestConfig();
			config.setMarkProp('dot-test', 'fill', 'island');
			expect(entry.fill).toBe('island');

			config.revertMarkProp('dot-test', 'fill');
			expect(entry.fill).toBe('species');
		});

		it('reverts all properties via revertMark', () => {
			const { config, entry } = createTestConfig();
			config.setMarkProp('dot-test', 'fill', 'island');
			config.setMarkProp('dot-test', 'opacity', 0.9);

			config.revertMark('dot-test');
			expect(entry.fill).toBe('species');
			expect(entry.opacity).toBe(0.5);
		});
	});

	describe('setMarkProp on unregistered key', () => {
		it('should not create a plain property for an unregistered key', () => {
			const { config, entry } = createTestConfig();

			// 'bogus' was never registered as a prop getter
			config.setMarkProp('dot-test', 'bogus', 'surprise');

			// Bug: currently creates a plain property, so this will be 'surprise'
			// After fix: entry.bogus should remain undefined
			expect((entry as Record<string, unknown>).bogus).toBe(undefined);
		});

		it('revertMarkProp on unregistered key should be safe', () => {
			const { config } = createTestConfig();
			// Should not throw
			config.revertMarkProp('dot-test', 'bogus');
		});
	});

	describe('re-registration returns existing entry', () => {
		it('returns the same entry on re-register', () => {
			const { config, entry } = createTestConfig();
			config.setMarkProp('dot-test', 'fill', 'island');

			const entry2 = config.registerMark('dot-test', 'dot', {
				table: () => 'penguins',
				fill: () => 'species',
				opacity: () => 0.5
			});

			expect(entry2).toBe(entry);
			// Override should persist across re-registration
			expect(entry2.fill).toBe('island');
		});
	});

	describe('unregisterMark', () => {
		it('removes the entry', () => {
			const { config } = createTestConfig();
			expect(config.entries.size).toBe(1);

			config.unregisterMark('dot-test');
			expect(config.entries.size).toBe(0);
		});
	});

	describe('preview', () => {
		it('beginPreview applies value, cancelPreview reverts', () => {
			const { config, entry } = createTestConfig();
			expect(entry.fill).toBe('species');

			config.beginPreview('dot-test', 'fill', 'island');
			expect(entry.fill).toBe('island');
			expect(config.previewing).toBe(true);

			config.cancelPreview();
			expect(entry.fill).toBe('species');
			expect(config.previewing).toBe(false);
		});

		it('commitPreview keeps the value', () => {
			const { config, entry } = createTestConfig();

			config.beginPreview('dot-test', 'fill', 'island');
			expect(entry.fill).toBe('island');

			config.commitPreview();
			expect(entry.fill).toBe('island');
			expect(config.previewing).toBe(false);
		});

		it('stacks multiple previews and reverts in order', () => {
			const { config, entry } = createTestConfig();

			config.beginPreview('dot-test', 'fill', 'island');
			config.beginPreview('dot-test', 'opacity', 0.9);
			expect(entry.fill).toBe('island');
			expect(entry.opacity).toBe(0.9);

			config.cancelPreview();
			expect(entry.fill).toBe('species');
			expect(entry.opacity).toBe(0.5);
		});

		it('ignores unregistered keys', () => {
			const { config, entry } = createTestConfig();

			config.beginPreview('dot-test', 'bogus', 'surprise');
			expect((entry as Record<string, unknown>).bogus).toBe(undefined);
			expect(config.previewing).toBe(false);
		});
	});

	describe('undo / redo', () => {
		it('checkpoint + undo restores previous state', () => {
			const { config, entry } = createTestConfig();
			expect(config.canUndo).toBe(false);

			config.checkpoint('before color change');
			config.setMarkProp('dot-test', 'fill', 'island');
			expect(entry.fill).toBe('island');
			expect(config.canUndo).toBe(true);

			config.undo();
			expect(entry.fill).toBe('species');
			expect(config.canUndo).toBe(false);
		});

		it('redo restores undone state', () => {
			const { config, entry } = createTestConfig();

			config.checkpoint();
			config.setMarkProp('dot-test', 'fill', 'island');

			config.undo();
			expect(entry.fill).toBe('species');
			expect(config.canRedo).toBe(true);

			config.redo();
			expect(entry.fill).toBe('island');
			expect(config.canRedo).toBe(false);
		});

		it('new checkpoint clears redo stack', () => {
			const { config, entry } = createTestConfig();

			config.checkpoint();
			config.setMarkProp('dot-test', 'fill', 'island');

			config.undo();
			expect(config.canRedo).toBe(true);

			config.checkpoint();
			config.setMarkProp('dot-test', 'fill', 'sex');
			expect(config.canRedo).toBe(false);
		});

		it('multiple checkpoints create undo chain', () => {
			const { config, entry } = createTestConfig();

			config.checkpoint('step 1');
			config.setMarkProp('dot-test', 'fill', 'island');

			config.checkpoint('step 2');
			config.setMarkProp('dot-test', 'fill', 'sex');
			expect(entry.fill).toBe('sex');

			config.undo();
			expect(entry.fill).toBe('island');

			config.undo();
			expect(entry.fill).toBe('species');
		});

		it('undo returns false when stack is empty', () => {
			const { config } = createTestConfig();
			expect(config.undo()).toBe(false);
		});

		it('redo returns false when stack is empty', () => {
			const { config } = createTestConfig();
			expect(config.redo()).toBe(false);
		});
	});
});
