import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A mark's lifecycle requests identity for, and routes by, the channel its
 * config names as colorChannel ('fill' when none is named). A mark coloured by
 * stroke that does not say so gets no identity for its stroke, while routing
 * reads the shared colour scale's key: it dims by raw positions read as ids.
 * Every mark must name the channel it hands MarkColor.
 */
const dir = fileURLToPath(new URL('.', import.meta.url));

describe('mark colour channels', () => {
	const marks = readdirSync(dir).filter(
		(f) => f.endsWith('Mark.svelte') || /Mark[XY]\.svelte$/.test(f)
	);

	it.each(marks)('%s declares the channel it colours by', (file) => {
		const source = readFileSync(dir + file, 'utf8');
		const call = /new MarkColor\(([\s\S]*?)\n\t\);/.exec(source)?.[1];
		if (!source.includes('new MarkColor(')) return;
		// A MarkColor this cannot read is a failure, not a pass.
		const channel = call && /'(fill|stroke)'/.exec(call)?.[1];
		expect(channel).toMatch(/^(fill|stroke)$/);
		if (channel === 'stroke') expect(source).toMatch(/colorChannel: 'stroke'/);
		else expect(source).not.toMatch(/colorChannel: 'stroke'/);
	});
});
