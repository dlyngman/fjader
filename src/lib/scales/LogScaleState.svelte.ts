// =============================================================================
// LogScaleState.svelte.ts - Logarithmic scale with GPU vertex shader transform
// =============================================================================

import { scaleLog } from 'd3-scale';
import type { ScaleLogarithmic } from 'd3-scale';
import { format } from 'd3-format';
import { LinearScaleState } from './LinearScaleState.svelte';
import type { LinearScaleOptions, GpuScaleState } from './LinearScaleState.svelte';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';

const LOG_MIN_CLAMP = 1e-10;

/**
 * LogScaleState extends LinearScaleState with logarithmic mapping.
 *
 * GPU: pre-computes log(domainMin), log(domainMax), 1/(log(max)-log(min))
 * and writes to the SSBO. The vertex shader applies log() per vertex.
 *
 * Domain must be strictly positive.
 */
export class LogScaleState extends LinearScaleState {
	override get scaleType(): 'log' {
		return 'log' as const;
	}

	#logScale: ScaleLogarithmic<number, number> = scaleLog();
	static #pointFormat = format('.4~s');

	constructor(
		name: string,
		extent: [number, number] = [1, 100],
		type: string = 'log',
		zoomLimits: [number, number] = [10, 100],
		options: LinearScaleOptions = {},
		gpuCoordinator: GPUCoordinator | null = null
	) {
		// Clamp extent to positive
		const safeExtent: [number, number] = [
			Math.max(extent[0], LOG_MIN_CLAMP),
			Math.max(extent[1], LOG_MIN_CLAMP)
		];
		super(name, safeExtent, type ?? 'log', zoomLimits, options, gpuCoordinator);
		this._reinitScale();
	}

	// ===========================================================================
	// TEMPLATE METHOD OVERRIDES
	// ===========================================================================

	protected override toSpringSpace(value: number): number {
		return Math.log(Math.max(value, LOG_MIN_CLAMP));
	}

	protected override fromSpringSpace(value: number): number {
		return Math.exp(value);
	}

	protected override transformForGpu(min: number, max: number, out: GpuScaleState): void {
		const logMin = Math.log(Math.max(min, LOG_MIN_CLAMP));
		const logMax = Math.log(Math.max(max, LOG_MIN_CLAMP));
		const logRange = logMax - logMin;
		out.domainMin = logMin;
		out.domainMax = logMax;
		out.domainScale = logRange === 0 ? 0 : 1 / logRange;
		out.p4 = 0;
	}

	protected override normalizeValue(value: number, min: number, max: number): number {
		const logMin = Math.log(Math.max(min, LOG_MIN_CLAMP));
		const logMax = Math.log(Math.max(max, LOG_MIN_CLAMP));
		const logVal = Math.log(Math.max(value, LOG_MIN_CLAMP));
		const logRange = logMax - logMin;
		return logRange === 0 ? 0 : (logVal - logMin) / logRange;
	}

	protected override denormalizeValue(t: number, min: number, max: number): number {
		const logMin = Math.log(Math.max(min, LOG_MIN_CLAMP));
		const logMax = Math.log(Math.max(max, LOG_MIN_CLAMP));
		return Math.exp(logMin + t * (logMax - logMin));
	}

	// ===========================================================================
	// D3 SCALE INTERFACE
	// ===========================================================================

	override getBaseScale(axis: string, size: number): ScaleLogarithmic<number, number> {
		this.#logScale.range(axis === 'x' ? [0, size] : [size, 0]);
		return this.#logScale;
	}

	override getTicks(count: number = 5): number[] {
		this._version;
		const [min, max] = this.domainForReactivity;
		return scaleLog()
			.domain([Math.max(min, LOG_MIN_CLAMP), Math.max(max, LOG_MIN_CLAMP)])
			.ticks(count);
	}

	/**
	 * Format a single value for point display (crosshair, tooltip).
	 * Unlike tickFormat(), always returns a readable string — D3 log
	 * tickFormat returns '' for non-significant values (non-powers-of-10).
	 */
	override formatValue(value: number): string {
		return LogScaleState.#pointFormat(value);
	}

	override tickFormat(count: number = 5): (value: number) => string {
		this._version;
		const [min, max] = this.domainForReactivity;
		return scaleLog()
			.domain([Math.max(min, LOG_MIN_CLAMP), Math.max(max, LOG_MIN_CLAMP)])
			.tickFormat(count) as (value: number) => string;
	}

	// ===========================================================================
	// EXTENT MANAGEMENT (clamp to positive)
	// ===========================================================================

	override addMark(range: number[], identifier: string, options: { instant?: boolean } = {}): this {
		// Clamp to positive for log scale
		const clamped = range.map((v) => Math.max(v, LOG_MIN_CLAMP));
		return super.addMark(clamped, identifier, options);
	}

	override resetDomainLimits(): void {
		const [min, max] = this.effectiveExtent;
		const logMin = Math.log(Math.max(min, LOG_MIN_CLAMP));
		const logMax = Math.log(Math.max(max, LOG_MIN_CLAMP));
		const logRange = logMax - logMin;

		// Pan boundaries in log space (multiplicative expansion)
		this.domainLimits.min = Math.exp(logMin - this.zoomLimits.max * logRange);
		this.domainLimits.max = Math.exp(logMax + this.zoomLimits.max * logRange);
		// minWidth unused — zoom depth enforced in visual space by base class
		this.domainLimits.minWidth = 0;
	}

	override updateExtentFromExtents(nice: boolean = true, instant: boolean = false): void {
		// Let parent compute raw extent from marks (no nice rounding)
		super.updateExtentFromExtents(false, instant);

		if (nice) {
			const [rawMin, rawMax] = this.effectiveExtent;
			if (!isFinite(rawMin) || !isFinite(rawMax) || rawMin >= rawMax) return;

			// Apply log-aware nice (rounds to powers of 10)
			const niceDomain = scaleLog()
				.domain([Math.max(rawMin, LOG_MIN_CLAMP), Math.max(rawMax, LOG_MIN_CLAMP)])
				.nice()
				.domain();
			this._setExtent(niceDomain[0], niceDomain[1]);
			this.resetDomainLimits();
			this.resetZoom(instant);
		}
	}
}
