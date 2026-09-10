/**
 * How many facet cells are too many (§29.11).
 *
 * Separate from the dim's limits, which answer a different question.
 * `MAX_IDENTITY_CARDINALITY` (10000) is sized for the shared slot buffer and
 * `WARN_IDENTITY_CARDINALITY` (1000) for how thin a BAR gets — both statements
 * about a band axis. A facet cell is not a bar: it is a component with its own
 * scales, its own layout and its own draw, so the number a page can hold is
 * three orders of magnitude smaller and the dim's gate waves it straight
 * through.
 *
 * That gap is reachable from ordinary use. Faceting on a TIMESTAMP gives one
 * cell per distinct value, which at second resolution is roughly one per row —
 * a 6k-row table passes `#checkCardinality` comfortably and hangs the tab. The
 * column type does not predict this and only the count does, which is the same
 * conclusion §16.6 reached for band axes.
 */

/** Refuse above this. A grid this wide is not a chart anyone can read. */
export const MAX_FACET_CELLS = 50;
/** Warn above this: still renders, but every cell is a sliver. */
export const WARN_FACET_CELLS = 20;

export interface FacetCellCheck {
	/** False when the grid must not be rendered. */
	ok: boolean;
	/** Set when the user should be told something, whether ok or not. */
	message: string | null;
}

/**
 * Decide whether a facet grid of `count` cells may render.
 *
 * Pure, and returns the message rather than logging it, so the refusal can be
 * shown ON the chart — a console warning for a blank area is the failure mode
 * §16.6's refusals were written to avoid.
 *
 * `field` is only quoted into the message; it is the identity key, so an
 * expression-backed facet names itself readably.
 */
export function checkFacetCells(count: number, field: string): FacetCellCheck {
	if (count > MAX_FACET_CELLS) {
		return {
			ok: false,
			message:
				`Faceting on ${field} produces ${count} cells, over the ${MAX_FACET_CELLS} this ` +
				`grid will render. Each cell is a full chart, not a bar. Facet by a coarser ` +
				`value — for a date or timestamp that means truncating it, e.g. ` +
				`fx={sql\`date_trunc('month', ...)\`} — or filter the categories down first.`
		};
	}
	if (count > WARN_FACET_CELLS) {
		return {
			ok: true,
			message:
				`Faceting on ${field} produces ${count} cells; above ~${WARN_FACET_CELLS} each one ` +
				`is too small to read on most screens.`
		};
	}
	return { ok: true, message: null };
}
