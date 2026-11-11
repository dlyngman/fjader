/**
 * Where an axis title sits relative to its tick labels.
 *
 * The left axis puts its tick labels right-anchored 9px from the axis line and
 * its title, rotated, to the left of them. A fixed offset is right for short
 * labels and runs into wide ones (`40,000`, a band name). `'auto'` places the
 * title clear of the widest label, within the margin the chart gave it.
 */

/** Where the tick labels end, from the axis line: AxisLeft's text x and BandAxisTicks' labelGap. */
const TICK_GAP = 9;
/** Between the widest label and the title's baseline; the title's descenders reach into it. */
const CLEARANCE = 12;
/** A rotated title's glyphs sit on the far side of its baseline, away from the axis. */
const TITLE_BODY = 10;
/** The title's offset when nothing says otherwise, and the least `'auto'` uses. */
export const DEFAULT_TITLE_OFFSET = 32;

const FONT = '10px system-ui, sans-serif';
const FALLBACK_CHAR_WIDTH = 6;
const CACHE_LIMIT = 2000;

let context: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/**
 * The width of a tick label in px. Measured on a canvas, once per distinct
 * string (a band axis has the same labels frame after frame); 6px a character
 * where there is no document. An estimate by design: the page's own font can
 * differ a little, and CLEARANCE covers that.
 */
export function textWidth(text: string): number {
	const known = widths.get(text);
	if (known !== undefined) return known;
	if (context === undefined) {
		context =
			typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
		if (context) context.font = FONT;
	}
	const width = context ? context.measureText(text).width : text.length * FALLBACK_CHAR_WIDTH;
	if (widths.size >= CACHE_LIMIT) widths.clear();
	widths.set(text, width);
	return width;
}

/**
 * How far left of the axis line the title's baseline goes, clear of a label
 * `widest` px wide: never less than the default, and never so far that its body
 * leaves the margin. A margin too narrow for the labels leaves them overlapping,
 * and only a wider margin fixes that.
 */
export function clearTitleOffset(widest: number, marginLeft: number): number {
	const wanted = Math.max(TICK_GAP + widest + CLEARANCE, DEFAULT_TITLE_OFFSET);
	return Math.max(0, Math.min(wanted, marginLeft - TITLE_BODY));
}

/**
 * Whether two tick lists are the same ticks: equal values, or band ticks of the
 * same key. A loop with no allocation, to skip re-measuring labels when a pan
 * moved the ticks but did not change them.
 */
export function sameTicks(a: ArrayLike<unknown> | null, b: ArrayLike<unknown>): boolean {
	if (!a || a.length !== b.length) return false;
	for (let i = 0; i < b.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x === y) continue;
		if (
			typeof x === 'object' &&
			typeof y === 'object' &&
			x !== null &&
			y !== null &&
			(x as { key?: unknown }).key !== undefined &&
			(x as { key?: unknown }).key === (y as { key?: unknown }).key
		)
			continue;
		return false;
	}
	return true;
}
