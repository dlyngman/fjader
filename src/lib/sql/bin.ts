import type { ExprNode, ExprValue, BinHistogramOptions, BinDateOptions } from '@uwdata/mosaic-sql';
import { binDate, binHistogram, column } from '@uwdata/mosaic-sql';
import { isTemporalScale } from '$lib/scales/scale-categories';

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
				binOptions.step = binOptions.step / binStepMultiplier;
			}
		}

		return isTemporal
			? binDate(col, [min, max], binOptions)
			: binHistogram(col, [min, max], binOptions);
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
