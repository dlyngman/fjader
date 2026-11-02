import license from 'rollup-plugin-license';
import fs from 'fs';
import path from 'path';

/** Reads a vendored license text from licenses/. */
function vendored(file) {
	return fs.readFileSync(path.join('licenses', file), 'utf-8');
}

/**
 * Packages that ship without a LICENSE file, so the plugin finds only their
 * SPDX id; their texts are vendored from the upstream repositories.
 */
const MISSING_TEXTS = {
	'@duckdb/duckdb-wasm': 'duckdb.txt',
	'streamlit-component-lib': 'streamlit-component-lib.txt'
};

/**
 * Writes THIRD_PARTY_LICENSES.txt next to a bundle: the name, version and full
 * license text of every package compiled into it. The Python wheels ship these
 * bundles, and MIT, ISC and BSD all require the notice to travel with copies.
 *
 * `extra` lists code a bundle carries that is not an npm package.
 */
export function thirdPartyLicenses(outDir, extra = []) {
	return license({
		thirdParty: {
			output: {
				file: path.join(outDir, 'THIRD_PARTY_LICENSES.txt'),
				template(dependencies) {
					const entries = [
						...dependencies.map((dep) => ({
							title: `${dep.name}@${dep.version}`,
							license: dep.license,
							url: dep.homepage || dep.repository?.url,
							text:
								dep.licenseText ||
								(MISSING_TEXTS[dep.name] ? vendored(MISSING_TEXTS[dep.name]) : null),
							notice: dep.noticeText
						})),
						...extra
					].sort((a, b) => a.title.localeCompare(b.title));
					const missing = entries.filter((e) => !e.text).map((e) => e.title);
					if (missing.length > 0) {
						throw new Error(`No license text for bundled ${missing.join(', ')}`);
					}
					const header =
						`fjader bundles the third-party software listed below. ` +
						`Its own license is in LICENSE, and notices for the work it adapts are in NOTICE.\n`;
					const body = entries.map((e) =>
						[
							'-'.repeat(80),
							`${e.title} (${e.license})`,
							e.url ? e.url : null,
							'',
							e.text.trim(),
							e.notice ? `\n${e.notice.trim()}` : null
						]
							.filter((line) => line !== null)
							.join('\n')
					);
					return `${header}\n${body.join('\n\n')}\n`;
				}
			}
		}
	});
}
