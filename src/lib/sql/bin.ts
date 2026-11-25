import type { ExprNode, ExprValue, BinHistogramOptions, BinDateOptions } from '@uwdata/mosaic-sql';
import {
	binDate,
	binHistogram,
	binSpec,
	column,
	interval,
	sql,
	timeInterval
} from '@uwdata/mosaic-sql';
import { isTemporalScale } from '$lib/scales/scale-categories';
import type { BinPadding } from '$lib/types';

type BinOptions = BinHistogramOptions & BinDateOptions;

interface FieldStats {
	column: string;
	stats: ('min' | 'max' | 'count' | 'nulls' | 'distinct')[];
}

interface FieldInfo {
	min?: number;
	max?: number;
	type?: string;
}

/**
 * Numeric bins over [min, max]: binHistogram's own derivation (binSpec, with
 * the linear transform it is given), as the first edge and the width.
 */
function numericBins(
	min: number,
	max: number,
	options: BinOptions
): { min: number; alpha: number } {
	const b = binSpec(min, max, options);
	return { min: b.min, alpha: (b.max - b.min) / b.steps || 1 };
}

/**
 * How many bins `options` gives over [min, max], as `padding` counts them: the
 * numeric bins exactly; time buckets as their estimate (months and years are
 * not a fixed width), with the two an end can straddle.
 */
function binCount(min: number, max: number, isTemporal: boolean, options: BinOptions): number {
	if (isTemporal) {
		const { unit, step = 1 } = options.interval
			? { unit: options.interval, step: options.step }
			: timeInterval(min, max, options.steps || 40);
		const width = (UNIT_MS[unit] ?? UNIT_MS.day) * (step ?? 1);
		return Math.ceil((max - min) / width) + 2;
	}
	const { min: lo, alpha } = numericBins(min, max, options);
	return Math.floor((max - lo) / alpha) + 1;
}

/**
 * The edge of numeric bin `index` (SQL), `min + alpha * (index + offset)`, in
 * DOUBLE arithmetic. The one formula both `bin()` and `dense()`'s padding
 * write, so a bin's edge is the same bits whichever produced it: a padded row
 * then merges with a real one, and a mark's rows are the same bits whether
 * they came from the base table or a preagg table.
 */
export function numericBinEdgeSQL(
	min: number,
	alpha: number,
	offset: number,
	index: string
): string {
	return `(${sqlDouble(min)} + ${sqlDouble(alpha)} * (${index} + ${offset}))`;
}

/**
 * A bin's key (SQL): what a row is grouped by, once, whatever number of edges
 * the mark draws of it. A numeric bin's index, `floor((source - min) / alpha)`,
 * a DOUBLE; a time bin's bucket start, `time_bucket(interval, source)`. Every
 * edge of the bin is `binEdgeSQL` of it.
 */
export function binKeySQL(bin: BinPadding): string {
	if (bin.kind === 'number') return numericBinIndexSQL(bin.source, bin.min, bin.alpha);
	return `time_bucket(${bin.interval}, ${bin.source})`;
}

/** The index of the numeric bin a value of `source` falls in (SQL, a DOUBLE). */
function numericBinIndexSQL(source: string, min: number, alpha: number): string {
	return `floor((CAST(${source} AS DOUBLE) - ${sqlDouble(min)}) / ${sqlDouble(alpha)})`;
}

/**
 * Bin `k`'s edge as the REAL the query draws, `k` a bin key (`binKeySQL`) or
 * the padding's enumeration of one. Numeric: `min + alpha * (k + offset)`, in
 * DOUBLE arithmetic. Time: the bucket's edge (`timeBinEdgeSQL`), as seconds
 * from `t0`, the form the mark's time channels take.
 */
export function binEdgeSQL(bin: BinPadding, k: string): string {
	if (bin.kind === 'number') {
		return `CAST(${numericBinEdgeSQL(bin.min, bin.alpha, bin.offset, k)} AS REAL)`;
	}
	return `CAST((epoch(${timeBinEdgeSQL(k, bin.interval, bin.offset)}) - ${bin.t0}) AS REAL)`;
}

/**
 * The edge of a time bucket (SQL, a timestamp): `offset` intervals after the
 * bucket's `start`. The one formula both `bin()` and `dense()`'s padding
 * write, as numericBinEdgeSQL is for numeric bins.
 *
 * A whole offset steps by the interval: offset 1 is the next bucket's start,
 * whatever the month's length. A FRACTIONAL offset is that share of the way
 * between the two edges around it, so 0.5 is the middle of the bucket's own
 * span: where a bar over the bucket has its centre. Half the interval is not
 * that (half of `INTERVAL 1 month` is 15 days, in a month of 31), and
 * `INTERVAL 0.5 month` is not SQL at all.
 */
export function timeBinEdgeSQL(start: string, interval: string, offset: number): string {
	const whole = Math.floor(offset);
	const share = offset - whole;
	if (share === 0) return `${start} + (${interval}) * ${offset}`;
	// As timestamps: a DATE minus a DATE is a count of days, not an interval.
	const lower = `CAST(${start} + (${interval}) * ${whole} AS TIMESTAMP)`;
	const upper = `CAST(${start} + (${interval}) * ${whole + 1} AS TIMESTAMP)`;
	return `${lower} + (${upper} - ${lower}) * ${share}`;
}

/**
 * The ratio between two rebin levels: a view this much narrower than another
 * has this many times the bins over the field's extent.
 */
export const REBIN_RATIO = 1.5;
const LOG_REBIN_RATIO = Math.log(REBIN_RATIO);

/**
 * The rebin level of a view `viewWidth` wide on a field `extentWidth` wide:
 * 0 for a view of the whole extent, one more for each REBIN_RATIO it is
 * narrower, rounded to the nearest.
 *
 * A view WIDER than the extent is one level less only for each whole
 * REBIN_RATIO it is wider. An axis is niced and padded past its data (a delay
 * of -60 to 180 is drawn on -100 to 200, a quarter wider), and that is not a
 * zoom out: rounded to the nearest, such an axis halved its histogram's bins
 * on the first frame. Normally under a whole ratio, not always: an axis with
 * few ticks, a domain set wider than the data, or another mark's wider range on
 * the same axis can put the first view a level or more out, and the mark then
 * re-bins after its first result, since its first query is of the whole extent.
 *
 * View-scaled bins are resolved from the
 * level, not from the view's width itself, and a mark re-bins when the level of
 * its view changes. So the bins are a function of the view alone: two marks on
 * one field have the same bins on every frame, whenever each of them last
 * re-binned, and a pan (the width does not change) never re-bins.
 */
export function rebinLevel(viewWidth: number, extentWidth: number): number {
	if (!(viewWidth > 0) || !(extentWidth > 0)) return 0;
	const levels = Math.log(extentWidth / viewWidth) / LOG_REBIN_RATIO;
	// Wider than the extent: toward zero (less a rounding error, so exactly one
	// ratio wider is one level). + 0: -0 is 0.
	return (levels >= 0 ? Math.round(levels) : Math.ceil(levels - 1e-9)) + 0;
}

/** A JS number as a DOUBLE literal: a bare 0.1 would be read as a DECIMAL. */
function sqlDouble(n: number): string {
	return `CAST(${JSON.stringify(n)} AS DOUBLE)`;
}

/** Engine-built SQL text as an expression node. Never user input. */
function sqlFragment(text: string): ExprNode {
	return sql([text] as unknown as TemplateStringsArray);
}

/** A time unit's typical length, for estimating a bucket count. */
const UNIT_MS: Record<string, number> = {
	year: 365 * 86_400_000,
	quarter: 91 * 86_400_000,
	month: 30 * 86_400_000,
	day: 86_400_000,
	hour: 3_600_000,
	minute: 60_000,
	second: 1000,
	millisecond: 1,
	microsecond: 0.001
};

/**
 * A time bin's nominal width in ms, from its SQL interval (`INTERVAL 6 hour`):
 * a month as 30 days, a year as 365. For snapping a window near the grid, which
 * the SQL then snaps exactly. Null for a form it does not read.
 */
export function intervalWidthMs(sqlInterval: string): number | null {
	const m = /INTERVAL\s+(\d+(?:\.\d+)?)\s+(\w+?)s?\b/i.exec(sqlInterval);
	if (!m) return null;
	const unit = UNIT_MS[m[2].toLowerCase()];
	return unit ? Number(m[1]) * unit : null;
}

export function bin(field: string | ExprNode, options: BinOptions = {}): AutoBinNode {
	return new AutoBinNode(field, options);
}

export class AutoBinNode {
	field: string | ExprNode;
	options: BinOptions;
	isAutoBinNode = true as const;

	constructor(field: string | ExprNode, options: BinOptions = {}) {
		this.field = field;
		this.options = options;
	}

	get stats(): FieldStats {
		const fieldName = typeof this.field === 'string' ? this.field : this.field.toString();
		return {
			column: fieldName,
			stats: ['min', 'max']
		};
	}

	resolve(
		fieldInfo: Record<string, FieldInfo>,
		scaleType: string,
		timeOffset: number | null = null,
		currentDomain: [number, number] | null = null,
		binStepMultiplier: number = 1.0,
		maxBins: number = Infinity,
		minSteps: number = 1
	): ExprNode {
		const { col, min, max, isTemporal, binOptions } = this.#plan(
			fieldInfo,
			scaleType,
			currentDomain,
			binStepMultiplier,
			maxBins,
			minSteps
		);
		if (isTemporal) {
			const offset = binOptions.offset ?? 0;
			if (Number.isInteger(offset)) return binDate(col, [min, max], binOptions);
			// A point inside the bucket (its centre): from its two edges, in the
			// formula the padding writes (timeBinEdgeSQL). binDate's own choice of
			// unit and step, as `padding` takes it.
			const { unit, step = 1 } = binOptions.interval
				? { unit: binOptions.interval, step: binOptions.step }
				: timeInterval(min, max, binOptions.steps || 40);
			const start = binDate(col, [min, max], { ...binOptions, offset: 0 });
			return sqlFragment(timeBinEdgeSQL(String(start), String(interval(unit, step)), offset));
		}
		// A single value: binHistogram floors it rather than binning.
		if (max === min) return binHistogram(col, [min, max], binOptions);
		// binHistogram's bins, written with the formula dense() pads with, so a
		// real row's edge and a padded row's are the same bits (see
		// numericBinEdgeSQL).
		const { min: lo, alpha } = numericBins(min, max, binOptions);
		const index = numericBinIndexSQL(String(col), lo, alpha);
		return sqlFragment(numericBinEdgeSQL(lo, alpha, binOptions.offset ?? 0, index));
	}

	/**
	 * Whether the bins follow the view: a `bin()` given `steps` (or none, the
	 * default) has that many across the view. One given a `step` or an `interval`
	 * keeps it at any zoom.
	 */
	get followsView(): boolean {
		return !this.options.step && !this.options.interval;
	}

	/**
	 * The field's extent in the units of the axis's domain (seconds on a time
	 * axis), which a view's width is compared with for its rebin level
	 * (`rebinLevel`). NaN without the field's statistics.
	 */
	extentWidth(fieldInfo: Record<string, FieldInfo>, scaleType: string): number {
		const fieldName = typeof this.field === 'string' ? this.field : this.field.toString();
		const { min, max, type } = fieldInfo[fieldName] || {};
		if (min === undefined || max === undefined) return NaN;
		return this.#isTemporal(type, scaleType)
			? (new Date(max).getTime() - new Date(min).getTime()) / 1000
			: max - min;
	}

	#isTemporal(type: string | undefined, scaleType: string): boolean {
		return this.options.interval !== undefined || type === 'date' || isTemporalScale(scaleType);
	}

	/**
	 * The bins `resolve` produces with the same arguments: every bin a value of
	 * the field can fall in. What `dense()` pads a histogram from, so a bin
	 * emptied by a filter stays as a zero row and the bars can morph.
	 *
	 * Numeric bins as numbers, edge k at `min + alpha * (k + offset)`. Time
	 * buckets as the interval `time_bucket` steps by, and the field's extent;
	 * those need `t0`, the time scale's origin in epoch seconds, because a time
	 * channel is drawn as seconds from it, and are null without it (before the
	 * scale has one, the channel is not rewritten either).
	 *
	 * Null for a field with a single value, which binHistogram floors instead
	 * of binning.
	 */
	padding(
		fieldInfo: Record<string, FieldInfo>,
		scaleType: string,
		currentDomain: [number, number] | null = null,
		binStepMultiplier: number = 1.0,
		t0: number | null = null,
		maxBins: number = Infinity,
		minSteps: number = 1
	): BinPadding | null {
		const { col, min, max, isTemporal, binOptions } = this.#plan(
			fieldInfo,
			scaleType,
			currentDomain,
			binStepMultiplier,
			maxBins,
			minSteps
		);
		const offset = binOptions.offset ?? 0;
		const source = String(col);
		if (isTemporal) {
			if (t0 === null) return null;
			// binDate's own choice of unit and step.
			const { unit, step = 1 } = binOptions.interval
				? { unit: binOptions.interval, step: binOptions.step }
				: timeInterval(min, max, binOptions.steps || 40);
			const width = (UNIT_MS[unit] ?? UNIT_MS.day) * step;
			return {
				kind: 'time',
				source,
				interval: String(interval(unit, step)),
				minMs: min,
				maxMs: max,
				t0,
				count: Math.ceil((max - min) / width) + 2,
				offset
			};
		}
		if (max === min) return null;
		const { min: lo, alpha } = numericBins(min, max, binOptions);
		return {
			kind: 'number',
			source,
			min: lo,
			alpha,
			count: Math.floor((max - lo) / alpha) + 1,
			offset
		};
	}

	/**
	 * Whether the bins these arguments resolve are held at a bound: `finest` at
	 * `maxBins` (the view or the step multiplier asks for more than may be
	 * padded), `coarsest` at `minSteps`. For the palette, since a bound stops
	 * shift+scroll and zoom without saying so.
	 */
	held(
		fieldInfo: Record<string, FieldInfo>,
		scaleType: string,
		currentDomain: [number, number] | null,
		binStepMultiplier: number,
		maxBins: number,
		minSteps: number = 1
	): 'finest' | 'coarsest' | null {
		return this.#plan(fieldInfo, scaleType, currentDomain, binStepMultiplier, maxBins, minSteps)
			.held;
	}

	/**
	 * The column, extent and options both `resolve` and `padding` bin with.
	 *
	 * `maxBins` bounds bins that follow the view (`followsView`): a mark that is
	 * only right when padded (a path) must keep its bins × series × facets under
	 * the padding's row limit, which finer bins over the whole extent pass. The
	 * steps come down until the bins they give fit; a `step` or an `interval` of
	 * the mark's own is not touched.
	 *
	 * `minSteps` is the fewest steps across the view such bins may have (across
	 * the field's extent, for a view wider than it): the step multiplier and a
	 * view far wider than the data would otherwise take a line down to two
	 * points, which is not a line of anything. `maxBins` wins where both hold.
	 */
	#plan(
		fieldInfo: Record<string, FieldInfo>,
		scaleType: string,
		currentDomain: [number, number] | null,
		binStepMultiplier: number,
		maxBins: number = Infinity,
		minSteps: number = 1
	): {
		col: ExprValue;
		min: number;
		max: number;
		isTemporal: boolean;
		binOptions: BinOptions;
		held: 'finest' | 'coarsest' | null;
	} {
		const fieldName = typeof this.field === 'string' ? this.field : this.field.toString();
		const info = fieldInfo[fieldName] || {};
		const { min, max, type } = info;

		if (min === undefined || max === undefined) {
			throw new Error(
				`Cannot auto-bin field "${fieldName}": missing min/max statistics. ` +
					`This may happen if the field contains only NULL values or doesn't exist in the table.`
			);
		}

		const col: ExprValue = typeof this.field === 'string' ? column(this.field) : this.field;

		const isTemporal = this.#isTemporal(type, scaleType);

		let binOptions = { ...this.options };

		// Default to 30 steps when no step/steps/interval specified,
		// so dynamic re-binning on zoom always works
		if (!binOptions.steps && !binOptions.step && !binOptions.interval) {
			binOptions.steps = 30;
		}

		let level = 0;
		if (currentDomain && binOptions.steps && !binOptions.step && !binOptions.interval) {
			const viewportWidth = currentDomain[1] - currentDomain[0];
			const globalWidth = this.extentWidth(fieldInfo, scaleType);

			if (viewportWidth > 0 && globalWidth > 0) {
				// From the view's level, not its width: see rebinLevel.
				level = rebinLevel(viewportWidth, globalWidth);
				const scaledSteps = Math.max(1, Math.round(binOptions.steps * REBIN_RATIO ** level));
				binOptions = { ...binOptions, steps: scaledSteps };
			}
		}

		if (binStepMultiplier !== 1.0) {
			if (binOptions.steps) {
				binOptions.steps = Math.max(1, Math.round(binOptions.steps * binStepMultiplier));
			}
			if (binOptions.step) {
				// A time interval counts whole units: `INTERVAL 6.78 day` is not SQL.
				binOptions.step = binOptions.interval
					? Math.max(1, Math.round(binOptions.step / binStepMultiplier))
					: binOptions.step / binStepMultiplier;
			}
		}

		let floored = false;
		if (minSteps > 1 && binOptions.steps && this.followsView) {
			const floor = Math.round(minSteps * REBIN_RATIO ** Math.max(level, 0));
			if (binOptions.steps < floor) {
				binOptions = { ...binOptions, steps: floor };
				floored = true;
			}
		}

		let capped = false;
		if (Number.isFinite(maxBins) && binOptions.steps && this.followsView && max !== min) {
			// Against the bins the steps actually give: a nice step can give more
			// bins than were asked for.
			let steps = binOptions.steps;
			// Down by a fifth at least each time: a step one smaller often rounds to
			// the same nice step, and the same count.
			for (let i = 0; i < 200 && steps > 1; i++) {
				const count = binCount(min, max, isTemporal, { ...binOptions, steps });
				if (count <= maxBins) break;
				capped = true;
				steps = Math.max(1, Math.floor(steps * Math.min(maxBins / count, 0.8)));
			}
			if (capped) binOptions = { ...binOptions, steps };
		}

		return {
			col,
			min,
			max,
			isTemporal,
			binOptions,
			held: capped ? 'finest' : floored ? 'coarsest' : null
		};
	}

	withOffset(offset: number): AutoBinNode {
		return new AutoBinNode(this.field, {
			...this.options,
			offset
		});
	}
}

export function isBinExpression(expr: unknown): expr is AutoBinNode {
	return (
		typeof expr === 'object' &&
		expr !== null &&
		'isAutoBinNode' in expr &&
		expr.isAutoBinNode === true
	);
}
