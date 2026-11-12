import { describe, it, expect } from 'vitest';
import { FilterGroupRegistry } from './FilterGroupRegistry.svelte';

describe('FilterGroupRegistry: reading groups without creating them', () => {
	it('has() and isActive() create nothing, and say no for a group no chart made', () => {
		const registry = new FilterGroupRegistry();
		expect(registry.has('brush')).toBe(false);
		expect(registry.isActive('brush')).toBe(false);
		expect(registry.groupCount).toBe(0);
		expect(registry.names).toEqual([]);
	});

	it('get() creates the group, and has() sees it at once', () => {
		const registry = new FilterGroupRegistry();
		registry.get('brush');
		expect(registry.has('brush')).toBe(true);
		expect(registry.groupCount).toBe(1);
	});

	it('the default group is the one a missing name means', () => {
		const registry = new FilterGroupRegistry();
		expect(registry.has()).toBe(false);
		registry.get();
		expect(registry.has()).toBe(true);
		expect(registry.has('default')).toBe(true);
	});

	it("isActive() follows the group's clauses", () => {
		const registry = new FilterGroupRegistry();
		const handle = registry.get('brush').register('brush-x', {});
		expect(registry.isActive('brush')).toBe(false);
		handle.update('x > 0', null);
		expect(registry.isActive('brush')).toBe(true);
		handle.clear();
		expect(registry.isActive('brush')).toBe(false);
	});
});

describe('FilterGroupRegistry: find', () => {
	it('returns the group once made, and creates nothing before', () => {
		const registry = new FilterGroupRegistry();
		expect(registry.find('brush')).toBeUndefined();
		expect(registry.groupCount).toBe(0);
		const brush = registry.get('brush');
		expect(registry.find('brush')).toBe(brush);
		expect(registry.find()).toBeUndefined();
	});
});

describe('FilterGroupRegistry: names and groups', () => {
	it('list the groups in creation order at once', () => {
		const registry = new FilterGroupRegistry();
		const a = registry.get('a');
		const b = registry.get('b');
		registry.get('a'); // again: no new group
		expect(registry.names).toEqual(['a', 'b']);
		expect(registry.groups).toEqual([a, b]);
	});

	it('keep each group its creation index', () => {
		const registry = new FilterGroupRegistry();
		for (const name of ['a', 'b', 'c']) registry.get(name);
		expect(registry.groups.map((g) => g.index)).toEqual([0, 1, 2]);
	});
});
