/**
 * Downloads the example datasets into static/data/ from the upstream
 * repositories that publish them, pinned to a commit and checked by SHA-256.
 *
 * fjader does not redistribute these files: each one comes from its upstream
 * copy. Sources and licenses are in static/data/SOURCES.md.
 *
 *   npm run fetch-data
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const PLOT =
	'https://raw.githubusercontent.com/observablehq/plot/535723d5e433727720d9b673c31622821bb03210';
const MOSAIC =
	'https://raw.githubusercontent.com/uwdata/mosaic/c66d098dd6edd1f180d61193dcf74d87cfa1a993';

/** [local name, upstream URL, SHA-256] */
const DATASETS = [
	[
		'aapl.csv',
		`${PLOT}/test/data/aapl.csv`,
		'18dc8bf6542da26625d992544a619a5fc210d6dfc799e81ab7fb7f9edbc21f9a'
	],
	[
		'alphabet.csv',
		`${PLOT}/test/data/alphabet.csv`,
		'd62ce74dad83964bb0c463811933a29df888bff0624febbe7e63594931fa7e9e'
	],
	[
		'bls-industry-unemployment.csv',
		`${PLOT}/test/data/bls-industry-unemployment.csv`,
		'4cfc13b6ebe0f8c231b52895cee5f67670e5a1bad86460a8982716c3d86d835f'
	],
	[
		'cars.csv',
		`${PLOT}/test/data/cars.csv`,
		'eaad8395d37ee0f591ea143e8ce4f87d0909fb1daba085834b27c1da841f56af'
	],
	[
		'civilizations.csv',
		`${PLOT}/test/data/civilizations.csv`,
		'f1bc77f2ce024bb8917f7f8efcb308faaf4f68e11d84fffefdd62872675ecfce'
	],
	[
		'diamonds.csv',
		`${PLOT}/test/data/diamonds.csv`,
		'243996d7650e84e190a88d505b44c3a0be1bcfc7b4f32606d60d103a51494b9e'
	],
	[
		'driving.csv',
		`${PLOT}/test/data/driving.csv`,
		'3aced2fa41f2be51ee43f9da66d964d7c647dac27bcc37158d09098efad4ba4e'
	],
	[
		'gistemp.csv',
		`${PLOT}/test/data/gistemp.csv`,
		'08e51068e9866142250078e13bf4521b204f8f4b89eaad158e701792758a5b46'
	],
	[
		'olympians.csv',
		`${PLOT}/test/data/athletes.csv`,
		'29ff8d6298da8961d264be2849701614cce6ef939d6e52fb413f2071ec30f7ec'
	],
	[
		'sf-temperatures.csv',
		`${PLOT}/test/data/sf-temperatures.csv`,
		'1e90d4f9b2094bb32a4fd3f9d777478d0b5cb16f609c95e9be6eb2c245061cb4'
	],
	[
		'us-state-population-2010-2019.csv',
		`${PLOT}/test/data/us-state-population-2010-2019.csv`,
		'c915d8ffd29bdfa7132f0c939b4b7826cc7e4048287f03d7e34e14d6b50a083c'
	],
	[
		'flights-200k.parquet',
		`${MOSAIC}/data/flights-200k.parquet`,
		'6057fc59877fa24f0b9ece1e1807ec2709348cc7e687a871293a96b1040f4976'
	],
	[
		'penguins.parquet',
		`${MOSAIC}/data/penguins.parquet`,
		'8b76b6d1033bffc14bae5bc21dd7cc733c257b020275e0914fa24a94a3366c15'
	],
	[
		'seattle-weather.parquet',
		`${MOSAIC}/data/seattle-weather.parquet`,
		'054d29b59337d806bccf4e66d731020d3172c94c60cfd2e44d4086c6fc036a05'
	],
	[
		'travelers.parquet',
		`${MOSAIC}/data/travelers.parquet`,
		'30db33998b0c8852636076ade8714ddf3b5707fc75622d91454a1f4824f9205a'
	]
];

const DIR = path.resolve('static/data');

function sha256(buffer) {
	return createHash('sha256').update(buffer).digest('hex');
}

// Every dataset must be credited before it can be fetched.
const sources = fs.readFileSync(path.join(DIR, 'SOURCES.md'), 'utf-8');
const uncredited = DATASETS.filter(([name]) => !sources.includes(`\`${name}\``));
if (uncredited.length > 0) {
	console.error(`Not in static/data/SOURCES.md: ${uncredited.map(([n]) => n).join(', ')}`);
	process.exit(1);
}

let failed = 0;
for (const [name, url, hash] of DATASETS) {
	const file = path.join(DIR, name);
	if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === hash) {
		console.log(`  ok        ${name}`);
		continue;
	}
	const response = await fetch(url);
	if (!response.ok) {
		console.error(`  failed    ${name}: HTTP ${response.status} from ${url}`);
		failed++;
		continue;
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	if (sha256(buffer) !== hash) {
		console.error(`  mismatch  ${name}: upstream content changed, not written`);
		failed++;
		continue;
	}
	fs.writeFileSync(file, buffer);
	console.log(`  fetched   ${name}`);
}

process.exit(failed > 0 ? 1 : 0);
