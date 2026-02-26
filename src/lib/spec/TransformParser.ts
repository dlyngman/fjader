/**
 * Converts TransformSpec objects from JSON specs into Transform instances
 * that marks accept in their `transforms` prop.
 */

import { sql } from '@uwdata/mosaic-sql';
import {
	filter,
	having,
	limit,
	orderby,
	topN,
	stackY,
	stackX,
	normalize,
	dodge
} from '$lib/transforms';
import type { Transform } from '$lib/types';
import type { TransformSpec } from './types';

/**
 * Convert a raw SQL string into a Mosaic SQL expression node.
 * Uses the sql tagged template by constructing a TemplateStringsArray.
 */
function rawSql(str: string) {
	const strings = Object.assign([str], { raw: [str] }) as TemplateStringsArray;
	return sql(strings);
}

export function parseTransforms(specs: TransformSpec[]): Transform[] {
	return specs.map(parseTransform);
}

function parseTransform(spec: TransformSpec): Transform {
	switch (spec.transform) {
		case 'filter':
			return filter(rawSql(spec.condition));
		case 'having':
			return having(rawSql(spec.condition));
		case 'limit':
			return limit(spec.value);
		case 'orderby':
			return orderby(...spec.fields.map((f) => rawSql(f)));
		case 'topN':
			return topN(spec.n, { by: spec.by, includeOthers: spec.includeOthers });
		case 'stackY':
			return stackY({ offset: spec.offset ?? undefined });
		case 'stackX':
			return stackX({ offset: spec.offset ?? undefined });
		case 'normalize':
			return normalize();
		case 'dodge':
			return dodge({ bandwidth: spec.bandwidth });
		default:
			throw new Error(`Unknown transform type: ${(spec as TransformSpec).transform}`);
	}
}
