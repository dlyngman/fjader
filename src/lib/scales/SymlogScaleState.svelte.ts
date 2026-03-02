// =============================================================================
// SymlogScaleState.svelte.ts - Symmetric log scale (handles zero and negatives)
// =============================================================================

import { scaleSymlog, scaleLog } from 'd3-scale';
import type { ScaleSymLog } from 'd3-scale';
import { format } from 'd3-format';
import { LinearScaleState } from './LinearScaleState.svelte';
import type { LinearScaleOptions, GpuScaleState } from './LinearScaleState.svelte';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';

export interface SymlogScaleOptions extends LinearScaleOptions {
	constant?: number;
}

/**
 * SymlogScaleState extends LinearScaleState with symmetric log mapping.
 *
 * Transform: sign(x) * log(1 + |x / C|) where C is the constant parameter.
 * Handles zero and negative values — no domain restrictions.
 *
 * GPU: pre-computes symlog(domainMin), symlog(domainMax), scale, and passes C in p4.
 */
export class SymlogScaleState extends LinearScaleState {
	override get scaleType(): 'symlog' {
		return 'symlog' as const;
	}

	#constant: number;
	#symlogScale: ScaleSymLog<number, number>;
	static #pointFormat = format('.4~s');

	constructor(
		name: string,
		extent: [number, number] = [0, 100],
		type: string = 'symlog',
		zoomLimits: [number, number] = [10, 100],
		options: SymlogScaleOptions = {},
		gpuCoordinator: GPUCoordinator | null = null
	) {
		super(name, extent, type ?? 'symlog', zoomLimits, options, gpuCoordinator);
		this.#constant = options.constant ?? 1;
		this.#symlogScale = scaleSymlog().constant(this.#constant);
		this._reinitScale();
	}

	/** The C parameter for the symlog transform. */
	get constant(): number {
		return this.#constant;
	}

	// ===========================================================================
	// SYMLOG MATH
	// ===========================================================================

	#symlog(value: number): number {
		const c = this.#constant;
		return Math.sign(value) * Math.log1p(Math.abs(value / c));
	}

	#symexp(value: number): number {
		const c = this.#constant;
		return Math.sign(value) * c * (Math.exp(Math.abs(value)) - 1);
	}

	// ===========================================================================
	// TEMPLATE METHOD OVERRIDES
	// ===========================================================================

	protected override toSpringSpace(value: number): number {
		return this.#symlog(value);
	}

	protected override fromSpringSpace(value: number): number {
		return this.#symexp(value);
	}

	protected override transformForGpu(min: number, max: number, out: GpuScaleState): void {
		const sMin = this.#symlog(min);
		const sMax = this.#symlog(max);
		const sRange = sMax - sMin;
		out.domainMin = sMin;
		out.domainMax = sMax;
		out.domainScale = sRange === 0 ? 0 : 1 / sRange;
		out.p4 = this.#constant; // symlog constant C
	}

	protected override normalizeValue(value: number, min: number, max: number): number {
		const sMin = this.#symlog(min);
		const sMax = this.#symlog(max);
		const sVal = this.#symlog(value);
		const sRange = sMax - sMin;
		return sRange === 0 ? 0 : (sVal - sMin) / sRange;
	}

	protected override denormalizeValue(t: number, min: number, max: number): number {
		const sMin = this.#symlog(min);
		const sMax = this.#symlog(max);
		return this.#symexp(sMin + t * (sMax - sMin));
	}

	// ===========================================================================
	// D3 SCALE INTERFACE
	// ===========================================================================

	/**
	 * Format a single value for point display (crosshair, tooltip).
	 * Unlike tickFormat(), always returns a readable string — D3 log
	 * tickFormat returns '' for non-significant values.
	 */
	override formatValue(value: number): string {
		return SymlogScaleState.#pointFormat(value);
	}

	override getBaseScale(axis: string, size: number): ScaleSymLog<number, number> {
		this.#symlogScale.range(axis === 'x' ? [0, size] : [size, 0]);
		return this.#symlogScale;
	}

	/** D3 log domain for the positive half. */
	#logDomain(min: number, max: number): { hasZero: boolean; hasPos: boolean; hasNeg: boolean; posDomain: [number, number]; negDomain: [number, number] } {
		const c = this.#constant;
		return {
			hasZero: min <= 0 && max >= 0,
			hasPos: max > c,
			hasNeg: min < -c,
			posDomain: max > c ? [Math.max(c, min > 0 ? min : c), max] : [c, c],
			negDomain: min < -c ? [Math.max(c, max < 0 ? -max : c), -min] : [c, c]
		};
	}

	override getTicks(count: number = 10): number[] {
		this._version;
		const [min, max] = this.domainForReactivity;
		if (!isFinite(min) || !isFinite(max) || min >= max) return [];

		// D3 symlog .ticks() uses linear spacing — useless for a log-like scale.
		// Delegate to D3 log's ticks() for each half — it dynamically adapts:
		// few decades → full 1-9 sub-decade, many decades → powers of 10 only.
		// Pass count directly to each half (no splitting) so both halves get
		// the same density as a standalone D3 log scale.
		const { hasZero, hasPos, hasNeg, posDomain, negDomain } = this.#logDomain(min, max);
		const ticks: number[] = [];

		if (hasZero) ticks.push(0);

		if (hasPos) {
			for (const t of scaleLog().domain(posDomain).ticks(count)) {
				if (t > 0 && t >= min && t <= max) ticks.push(t);
			}
		}
		if (hasNeg) {
			for (const t of scaleLog().domain(negDomain).ticks(count)) {
				if (t > 0 && -t >= min && -t <= max) ticks.push(-t);
			}
		}

		return [...new Set(ticks)].sort((a, b) => a - b);
	}

	override tickFormat(count: number = 10): (value: number) => string {
		this._version;
		const [min, max] = this.domainForReactivity;
		const { hasPos, posDomain } = this.#logDomain(min, max);

		// Use D3 log's tickFormat — handles SI prefixes (k, M, G) and label thinning
		const logFmt = hasPos
			? (scaleLog().domain(posDomain).tickFormat(count) as (v: number) => string)
			: String;

		return (value: number) => {
			if (value === 0) return '0';
			if (value > 0) return logFmt(value);
			// Negative: format absolute value, prepend minus
			const label = logFmt(-value);
			return label ? '\u2212' + label : '';
		};
	}

	// ===========================================================================
	// EXTENT MANAGEMENT
	// ===========================================================================

	override resetDomainLimits(): void {
		const [min, max] = this.effectiveExtent;
		const sMin = this.#symlog(min);
		const sMax = this.#symlog(max);
		const sRange = sMax - sMin;

		// Pan boundaries in symlog space
		this.domainLimits.min = this.#symexp(sMin - this.zoomLimits.max * sRange);
		this.domainLimits.max = this.#symexp(sMax + this.zoomLimits.max * sRange);
		// minWidth unused — zoom depth enforced in visual space by base class
		this.domainLimits.minWidth = 0;
	}

	override updateExtentFromExtents(nice: boolean = true, instant: boolean = false): void {
		// Let parent compute raw extent from marks (no nice rounding)
		super.updateExtentFromExtents(false, instant);

		if (nice) {
			const [rawMin, rawMax] = this.effectiveExtent;
			if (!isFinite(rawMin) || !isFinite(rawMax) || rawMin >= rawMax) return;

			// Apply symlog-aware nice
			const niceDomain = scaleSymlog()
				.constant(this.#constant)
				.domain([rawMin, rawMax])
				.nice()
				.domain();
			this._setExtent(niceDomain[0], niceDomain[1]);
			this.resetDomainLimits();
			this.resetZoom(instant);
		}
	}
}
