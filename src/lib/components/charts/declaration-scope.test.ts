import { describe, it, expect, vi } from 'vitest';
import { render } from 'svelte/server';
import ScopeHarness from '../../../test-fixtures/declarations/ScopeHarness.svelte';
import { DeclarationRegistry, type ChartDeclaration } from './declarations.svelte';

describe('DeclarationScope', () => {
	it('scopes declarations to its cell, or to every cell; children warn as overlays', () => {
		// Server rendering runs onDestroy at the end, which unregisters: keep what
		// was registered, and look at the registry as it stood then.
		const registry = new DeclarationRegistry();
		const registered: ChartDeclaration[] = [];
		const register = registry.register.bind(registry);
		registry.register = (d) => {
			registered.push(d);
			return register(d);
		};
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		let warnings: unknown[][];
		try {
			render(ScopeHarness, { props: { registry } });
		} finally {
			warnings = [...warn.mock.calls];
			warn.mockRestore();
		}
		expect(registry.declarations).toEqual([]);
		registry.register = register;
		for (const d of registered) registry.register(d);

		expect(registered.map((d) => [d.spec.id, d.cellId])).toEqual([
			['bare', null],
			['in-cell-a', 'cell-a'],
			['in-children', null]
		]);
		// A cell sees every-cell declarations and its own; another cell not cell-a's.
		expect(registry.forCell('cell-a').frames.map((f) => f.id)).toEqual([
			'bare',
			'in-cell-a',
			'in-children'
		]);
		expect(registry.forCell('cell-b').frames.map((f) => f.id)).toEqual(['bare', 'in-children']);
		// Only the probe placed in the chart's children is told to move.
		expect(warnings).toHaveLength(1);
		expect(String(warnings[0][0])).toContain('<ScopeProbe>');
		expect(String(warnings[0][0])).toContain('`foreground`');
	});
});
