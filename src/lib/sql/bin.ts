import type { ExprNode, ExprValue, BinHistogramOptions, BinDateOptions } from '@uwdata/mosaic-sql';
import { binDate, binHistogram, binSpec, column, interval, timeInterval } from '@uwdata/mosaic-sql';
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
		binStepMultiplier: number = 1.0
	): ExprNode {
		const { col, min, max, isTemporal, binOptions } = this.#plan(
			fieldInfo,
			scaleType,
			currentDomain,
			binStepMultiplier
		);
		return isTemporal
			? binDate(col, [min, max], binOptions)
			: binHistogram(col, [min, max], binOptions);
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
		t0: number | null = null
	): BinPadding | null {
		const { min, max, isTemporal, binOptions } = this.#plan(
			fieldInfo,
			scaleType,
			currentDomain,
			binStepMultiplier
		);
		const offset = binOptions.offset ?? 0;
		if (isTemporal) {
			if (t0 === null) return null;
			// binDate's own choice of unit and step.
			const { unit, step = 1 } = binOptions.interval
				? { unit: binOptions.interval, step: binOptions.step }
				: timeInterval(min, max, binOptions.steps || 40);
			const width = (UNIT_MS[unit] ?? UNIT_MS.day) * step;
			return {
				kind: 'time',
				interval: String(interval(unit, step)),
				minMs: min,
				maxMs: max,
				t0,
				count: Math.ceil((max - min) / width) + 2,
				offset
			};
		}
		if (max === min) return null;
		// binHistogram's own derivation, with the linear transform it is given.
		const b = binSpec(min, max, binOptions);
		const alpha = (b.max - b.min) / b.steps || 1;
		return {
			kind: 'number',
			min: b.min,
			alpha,
			count: Math.floor((max - b.min) / alpha) + 1,
			offset
		};
	}

	/** The column, extent and options both `resolve` and `padding` bin with. */
	#plan(
		fieldInfo: Record<string, FieldInfo>,
		scaleType: string,
		currentDomain: [number, number] | null,
		binStepMultiplier: number
	): { col: ExprValue; min: number; max: number; isTemporal: boolean; binOptions: BinOptions } {
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

		const isTemporal =
			this.options.interval !== undefined || type === 'date' || isTemporalScale(scaleType);

		let binOptions = { ...this.options };

		// Default to 30 steps when no step/steps/interval specified,
		// so dynamic re-binning on zoom always works
		if (!binOptions.steps && !binOptions.step && !binOptions.interval) {
			binOptions.steps = 30;
		}

		if (currentDomain && binOptions.steps && !binOptions.step && !binOptions.interval) {
			const viewportWidth = currentDomain[1] - currentDomain[0];
			const globalWidth = isTemporal
				? (new Date(max).getTime() - new Date(min).getTime()) / 1000
				: max - min;

			if (viewportWidth > 0 && globalWidth > 0) {
				const viewportFraction = viewportWidth / globalWidth;
				const scaledSteps = Math.max(1, Math.round(binOptions.steps / viewportFraction));
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

		return { col, min, max, isTemporal, binOptions };
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

export function expandBinForExtent(
	binExpr: AutoBinNode | unknown,
	channel: string,
	markType: string
): Record<string, unknown> {
	if (!isBinExpression(binExpr)) {
		return { [channel]: binExpr };
	}

	const needsExtent = ['rect', 'rectX', 'rectY', 'rule', 'ruleX', 'ruleY'].includes(markType);

	if (!needsExtent) {
		return { [channel]: binExpr };
	}

	return {
		[`${channel}1`]: binExpr,
		[`${channel}2`]: binExpr.withOffset(1)
	};
}
