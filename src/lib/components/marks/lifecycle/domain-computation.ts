import type { DataAccessor } from '$lib/data/DataAccessor';
import { isNode, isAggregateExpression } from '@uwdata/mosaic-sql';
import { isWindowExpression } from '$lib/sql/expression-utils';
import { isBinExpression } from '$lib/sql/bin';
import { isContinuousScale } from '$lib/scales/scale-categories';
import type { ScaleRequirement } from '$lib/scales/ScalePriorities';
import type { TransformCompiler } from '$lib/transforms/TransformCompiler';

// ---------------------------------------------------------------------------
// Pure functions — no instance state, no side effects
// ---------------------------------------------------------------------------

/**
 * Compute min/max extent from data for given channels.
 * Works with both DataAccessor (Arrow) and plain object arrays.
 */
export function computeExtentFromData(
	data: DataAccessor | Record<string, unknown>[],
	channels: string[]
): [number, number] | null {
	let min = Infinity;
	let max = -Infinity;

	const isAccessor = typeof (data as DataAccessor).getColumn === 'function';

	if (isAccessor) {
		const accessor = data as DataAccessor;
		for (const channel of channels) {
			const column = accessor.getColumn(channel);
			if (!column) continue;

			for (let i = 0; i < column.length; i++) {
				const value = column[i];
				if (typeof value === 'number' && !isNaN(value)) {
					if (value < min) min = value;
					if (value > max) max = value;
				}
			}
		}
	} else {
		for (const row of data as Record<string, unknown>[]) {
			for (const channel of channels) {
				const value = row[channel];
				if (typeof value === 'number' && !isNaN(value)) {
					if (value < min) min = value;
					if (value > max) max = value;
				}
			}
		}
	}

	if (min === Infinity || max === -Infinity) return null;
	return [min, max];
}

/**
 * Extract unique category values from a column in the data, preserving order.
 * Used to populate band scale domains from post-transform data (topN).
 */
export function extractCategoriesFromData(data: DataAccessor, axis: string): string[] {
	const col = data.getColumn(axis);
	if (!col) return [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (let i = 0; i < data.length; i++) {
		const val = String(col[i]);
		if (!seen.has(val)) {
			seen.add(val);
			result.push(val);
		}
	}
	return result;
}

/**
 * Unique identity ids present in a channel, in first-appearance order.
 *
 * The sibling of extractCategoriesFromData for band axes carrying dim ids
 * rather than raw values. -1 is skipped: it is the no-identity sentinel, not a
 * category, and a scale must never register it as one.
 */
export function extractIdsFromData(data: DataAccessor, axis: string): number[] {
	const col = data.getColumn(axis);
	if (!col) return [];
	const seen = new Set<number>();
	const result: number[] = [];
	for (let i = 0; i < data.length; i++) {
		const id = col[i] as number;
		if (id < 0 || seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result;
}

/**
 * Ids in the order a ranking transform ranked them, rather than the order the
 * rows arrived in.
 *
 * Band display order is first-appearance order over whatever this returns, so
 * for a topN axis this is what makes the axis read by the measure instead of by
 * dim id. It is deliberately NOT an ORDER BY on the query: a bar mark stacks by
 * default, so the ranked query is wrapped in a window partitioned by the band
 * column, and the row order does not survive that. A value does.
 *
 * Falls back to plain first-appearance order when the column is absent — a
 * grouped topN has no rank to publish, and every other mark has no ranking at
 * all. Absence is the normal case, not an error.
 *
 * Ties keep their first appearance, so a rank column that repeats a value (the
 * JS path's Other row cannot, but a future one might) degrades to row order
 * rather than to something arbitrary.
 */
export function extractIdsRankedFromData(
	data: DataAccessor,
	axis: string,
	rankColumn: string
): number[] {
	const col = data.getColumn(axis);
	if (!col) return [];
	const ranks = data.getColumn(rankColumn);
	if (!ranks) return extractIdsFromData(data, axis);

	const seen = new Map<number, number>();
	for (let i = 0; i < data.length; i++) {
		const id = col[i] as number;
		// Keep the BEST rank for an id, not the first row's. A grouped result has
		// several rows per category and they need not agree.
		if (id < 0) continue;
		const rank = Number(ranks[i]);
		// NaN means "returned, but not displayed" — a category the dense join
		// keeps a row for so its bar can shrink out, past topN's cutoff.
		// It must not reach the display order at all, and the test has to be
		// explicit: every comparison against NaN is false, so `rank < prev`
		// never fires, but the `prev === undefined` branch would still admit it
		// the first time the id is seen.
		if (!Number.isFinite(rank)) continue;
		const prev = seen.get(id);
		if (prev === undefined || rank < prev) seen.set(id, rank);
	}

	// Stable by construction: Map preserves insertion (= first appearance), and
	// a stable sort leaves equal ranks in it.
	return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/**
 * Detect which channels need their domain computed from query results.
 * This includes:
 * - Aggregate expressions (count, sum, etc.) on linear scales
 * - Aggregate expressions for continuous color scales
 * - Channels that will be generated by transforms (x0/x1, y0/y1)
 */
export function detectChannelsNeedingDataDomain(
	select: Record<string, unknown>,
	scaleRequirements: { x: ScaleRequirement | null; y: ScaleRequirement | null },
	transformCompiler: TransformCompiler
): Set<string> {
	const result = new Set<string>();

	// Check each channel in select for aggregates and bins
	for (const [channel, value] of Object.entries(select)) {
		if (value == null) continue;

		// AutoBinNodes need data-derived domains: bin boundaries depend on
		// nice rounding and can't be known until the query results arrive.
		// The sidecar query can't run before fieldInfo resolves bins to SQL.
		if (isBinExpression(value)) {
			if (channel === 'x' || channel === 'x1' || channel === 'x2') {
				result.add('x');
			} else if (channel === 'y' || channel === 'y1' || channel === 'y2') {
				result.add('y');
			}
			continue;
		}

		// Check if it's an aggregate or window expression
		const exprNode = isNode(value) ? value : null;
		if (!exprNode || !(isAggregateExpression(exprNode) || isWindowExpression(exprNode))) continue;

		// Determine channel type and whether it needs data-derived domain
		if (channel === 'x' || channel === 'x1' || channel === 'x2') {
			if (isContinuousScale(scaleRequirements?.x?.type)) {
				result.add('x');
			}
		} else if (channel === 'y' || channel === 'y1' || channel === 'y2') {
			if (isContinuousScale(scaleRequirements?.y?.type)) {
				result.add('y');
			}
		} else if (channel === 'fill' || channel === 'stroke') {
			// Aggregated color fields produce continuous (numeric) values
			// These need domain discovery for continuous color scales
			result.add(channel);
		}
	}

	// Also add channels that transforms will generate (SQL or JS stage — e.g. stack's y0/y1)
	for (const channel of transformCompiler.getAdditionalChannels()) {
		const baseChannel = channel.startsWith('x') ? 'x' : channel.startsWith('y') ? 'y' : null;
		if (baseChannel) {
			result.add(baseChannel);
		}
	}

	return result;
}
