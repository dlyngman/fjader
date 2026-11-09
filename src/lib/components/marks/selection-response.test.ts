import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A backstop: every mark passes selectionResponse to its lifecycle next to
 * selection, so routing and the group index see it. The behaviour itself is
 * tested in activity-reads.test.ts.
 */
const dir = fileURLToPath(new URL('.', import.meta.url));

describe('selectionResponse plumbing', () => {
	const marks = readdirSync(dir).filter(
		(f) => f.endsWith('Mark.svelte') || /Mark[XY]\.svelte$/.test(f)
	);

	it.each(marks)('%s passes selectionResponse', (file) => {
		const source = readFileSync(dir + file, 'utf8');
		expect(source).toMatch(/selectionResponse = undefined,/);
		if (source.includes('selection: () => selection,')) {
			expect(source).toMatch(/selectionResponse: \(\) => selectionResponse,/);
		} else {
			// TextMark builds its reactive config from its own getters.
			expect(source).toMatch(/get selectionResponse\(\) \{\s*return selectionResponse;/);
		}
	});
});
