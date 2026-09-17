// =============================================================================
// RollingAvgNode — lazy window expression for LOD smoothing overlay
//
// Like AutoBinNode, this is a "recipe" that defers SQL expression construction
// to query-building time. The window size and mode may be getters, read each
// time the expression is built: the mark resolves its select in a $derived, so
// reading them there tracks whatever they read, and a change re-queries the
// existing mark rather than recreating it. Same as topN's count.
// =============================================================================

import {
	avg,
	frameRows,
	preceding,
	following,
	currentRow,
	isAggregateExpression,
	type AggregateNode
} from '@uwdata/mosaic-sql';

export type SmoothMode = 'centered' | 'trailing' | 'leading';

/**
 * Inner expression for the rolling average. Either:
 *   - a column name (string) — wrapped in avg() automatically
 *   - an AggregateNode (e.g. avg(...), sum(...)) — used as-is, the window
 *     smooths the per-group result
 */
export type RollingAvgInner = string | AggregateNode;

export class RollingAvgNode {
	/** The column or aggregate expression to roll. */
	inner: RollingAvgInner;
	/** The column to ORDER BY in the window frame. */
	orderByField: string;
	/** Optional PARTITION BY column (series grouping). */
	partitionByField: string | null;
	/** Type marker for detection. */
	isRollingAvgNode = true as const;

	#window: () => number;
	#mode: () => SmoothMode;

	constructor(
		inner: RollingAvgInner,
		orderByField: string,
		partitionByField: string | null,
		windowSize: number | (() => number) = 1,
		mode: SmoothMode | (() => SmoothMode) = 'centered'
	) {
		this.inner = inner;
		this.orderByField = orderByField;
		this.partitionByField = partitionByField;
		this.#window = typeof windowSize === 'number' ? () => windowSize : windowSize;
		this.#mode = typeof mode === 'function' ? mode : () => mode;
	}

	/** Rows in each direction for centered, total for trailing. */
	get windowSize(): number {
		return this.#window();
	}

	/** 'centered' (±N), 'trailing' (←N) or 'leading' (→N). */
	get mode(): SmoothMode {
		return this.#mode();
	}

	/** Resolve to a Mosaic window expression with current parameters. */
	resolve() {
		const w = this.windowSize;
		const frame =
			this.mode === 'trailing'
				? frameRows([preceding(w), currentRow()])
				: this.mode === 'leading'
					? frameRows([currentRow(), following(w)])
					: frameRows([preceding(w), following(w)]);
		// String inner → wrap in avg() (raw column smoothing).
		// AggregateNode inner → use as-is (smooth the aggregated value).
		const base =
			typeof this.inner === 'string' || !isAggregateExpression(this.inner)
				? avg(this.inner as string)
				: this.inner;
		const windowed = this.partitionByField
			? base.partitionby(this.partitionByField).orderby(this.orderByField)
			: base.orderby(this.orderByField);
		return windowed.frame(frame);
	}
}

export function isRollingAvgExpression(expr: unknown): expr is RollingAvgNode {
	return typeof expr === 'object' && expr !== null && (expr as any).isRollingAvgNode === true;
}
