// =============================================================================
// RollingAvgNode — lazy window expression for LOD smoothing overlay
//
// Like AutoBinNode, this is a "recipe" that defers SQL expression construction
// to query-building time. The windowSize can be mutated without recreating the
// MarkLifecycle — instead, an invalidation callback triggers a re-query using
// the same cache-invalidation pattern as triggerReBin.
// =============================================================================

import { avg, frameRows, preceding, following, currentRow } from '@uwdata/mosaic-sql';

export type SmoothMode = 'centered' | 'trailing' | 'leading';

export class RollingAvgNode {
	/** The column to average. */
	field: string;
	/** The column to ORDER BY in the window frame. */
	orderByField: string;
	/** Optional PARTITION BY column (series grouping). */
	partitionByField: string | null;
	/** Current window size (rows in each direction for centered, total for trailing). Mutable. */
	windowSize: number;
	/** Window mode: 'centered' (±N) or 'trailing' (←N, backward-only). */
	mode: SmoothMode;
	/** Type marker for detection. */
	isRollingAvgNode = true as const;

	#onInvalidate: (() => void) | null = null;

	constructor(
		field: string,
		orderByField: string,
		partitionByField: string | null,
		windowSize: number = 1,
		mode: SmoothMode = 'centered'
	) {
		this.field = field;
		this.orderByField = orderByField;
		this.partitionByField = partitionByField;
		this.windowSize = windowSize;
		this.mode = mode;
	}

	/** Update window size and fire invalidation callback (triggers re-query). */
	setWindowSize(size: number): void {
		if (size === this.windowSize) return;
		this.windowSize = size;
		this.#onInvalidate?.();
	}

	/** Update window mode and fire invalidation callback (triggers re-query). */
	setMode(mode: SmoothMode): void {
		if (mode === this.mode) return;
		this.mode = mode;
		this.#onInvalidate?.();
	}

	/** Register a callback fired when parameters change. Called by MarkLifecycle. */
	registerInvalidation(callback: () => void): void {
		this.#onInvalidate = callback;
	}

	/** Clear invalidation callback. Called on MarkLifecycle destroy. */
	clearInvalidation(): void {
		this.#onInvalidate = null;
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
		const base = avg(this.field);
		const windowed = this.partitionByField
			? base.partitionby(this.partitionByField).orderby(this.orderByField)
			: base.orderby(this.orderByField);
		return windowed.frame(frame);
	}
}

export function isRollingAvgExpression(expr: unknown): expr is RollingAvgNode {
	return typeof expr === 'object' && expr !== null && (expr as any).isRollingAvgNode === true;
}
