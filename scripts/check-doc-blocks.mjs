// A doc block followed directly by another doc block is always a mistake here:
// a member inserted between an existing JSDoc and the declaration it belongs to
// (it happened in #53, #56 and #64), or a doc whose code has gone. The first
// block then documents nothing, or the wrong thing. Run by `npm run lint`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const hits = [];
(function walk(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path);
		else if (/\.(ts|svelte)$/.test(name)) {
			const text = readFileSync(path, 'utf8');
			const stacked = /\*\/\n[ \t]*\/\*\*/g;
			let match;
			while ((match = stacked.exec(text))) {
				hits.push(`${path}:${text.slice(0, match.index).split('\n').length}`);
			}
		}
	}
})('src/lib');

if (hits.length > 0) {
	console.error(
		'A doc block is followed directly by another (it documents nothing, or the wrong member):'
	);
	for (const hit of hits) console.error(`  ${hit}`);
	process.exit(1);
}
