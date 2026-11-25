// =============================================================================
// DensityHost — density measurement + decimation hysteresis
//
// Owns DuckDB count queries for viewport density and publishes results as
// reactive $state. Consumers (rung classes like DotsRung) read
// ctx and shouldDecimate via $derived/$effect.
//
// A mark that already holds its points (an aggregated result: a binned line's
// grid) counts them itself (`countInView`) and no query is sent: the count
// query runs the mark's whole query again, over the base table, to learn a
// number the result on screen has.
//
// Fire-and-forget: updates ctx and shouldDecimate, then it's done.
// No callbacks, no hooks, no spring concerns.
//
// Frame callback: registered with GPUCoordinator for post-render query
// scheduling. Domain change detection + debounce before issuing count query.
// =============================================================================

import type { ChartContext } from '$lib/types';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import type { QueryEngine } from '$lib/query-engine/QueryEngine';

// ---- Public types ----

export interface DensityContext {
	visibleCount: number;
	pixelWidth: number;
	density: number; // points per pixel
	avgSpacing: number; // pixels per point
	shouldDecimate: boolean;
}

/** A mark's own count of its points in a view, or why it has none (DensityHostConfig.countInView). */
export type HeldCount = number | 'ask' | 'wait';

export interface DensityHostConfig {
	/** Unique identifier for cancel-on-supersede in QueryEngine (use markId). */
	callerId: string;
	countQueryBuilder: (xLo: number, xHi: number, yLo: number, yHi: number) => string | null;
	/**
	 * The points in the view, when the mark holds them all and can count them
	 * (see `countRowsInView`). `'ask'`: it does not, the database counts.
	 * `'wait'`: it will once its first result is in, so nothing is asked
	 * meanwhile. With it, `version` says when the rows changed, so the count
	 * follows a new result under a view that did not move.
	 */
	countInView?: (xLo: number, xHi: number, yLo: number, yHi: number) => HeldCount;
	version?: () => number;
	decimate?: boolean | 'auto';
	densityThreshold?: number; // default 4
	hysteresis?: number; // default 0.5
	countDebounceMs?: number; // default 150
	domainChangeThreshold?: number; // default 2.0
}

// ---- Class ----

export class DensityHost {
	// --- Dependencies ---
	#gpuCoordinator: GPUCoordinator;
	#chartContext: ChartContext;
	#queryEngine: QueryEngine;
	#callerId: string;
	#countQueryBuilder: (xLo: number, xHi: number, yLo: number, yHi: number) => string | null;
	#countInView: ((xLo: number, xHi: number, yLo: number, yHi: number) => HeldCount) | null;
	#version: (() => number) | null;
	/** The rows' version the last held count was of. */
	#countedVersion = -1;

	// --- Decimation config ---
	#decimate: boolean | 'auto';
	#densityThreshold: number;
	#hysteresis: number;

	// --- Query scheduling ---
	#countDebounceMs: number;
	#domainChangeThreshold: number;
	#lastCountTime: number = 0;
	#lastCountDomainLo: number = 0;
	#lastCountDomainHi: number = 0;
	#countQueryPending: boolean = false;
	#querySequence: number = 0;

	// --- Fast-path domain change detection (avoid full check when domain unchanged) ---
	#lastSeenLo: number = NaN;
	#lastSeenHi: number = NaN;

	// --- Frame callback ---
	#frameCallback: ((isAnimating: boolean) => void) | null = null;
	#destroyed = false;

	// --- Reactive output ---
	readonly ctx: DensityContext = $state({
		visibleCount: 0,
		pixelWidth: 0,
		density: 0,
		avgSpacing: Infinity,
		shouldDecimate: false
	});

	// --- Diagnostics (non-reactive, polled by test pages) ---
	visibleCount: number = 0;
	queryLatencyMs: number = 0;
	queriesIssued: number = 0;
	frameCallbackCount: number = 0;
	timeSinceLastQuery: number = 0;

	constructor(
		gpuCoordinator: GPUCoordinator,
		chartContext: ChartContext,
		queryEngine: QueryEngine,
		config: DensityHostConfig
	) {
		this.#gpuCoordinator = gpuCoordinator;
		this.#chartContext = chartContext;
		this.#queryEngine = queryEngine;
		this.#callerId = `lod-${config.callerId}`;
		this.#countQueryBuilder = config.countQueryBuilder;
		this.#countInView = config.countInView ?? null;
		this.#version = config.version ?? null;
		this.#decimate = config.decimate ?? 'auto';
		this.#densityThreshold = config.densityThreshold ?? 4;
		this.#hysteresis = config.hysteresis ?? 0.5;
		this.#countDebounceMs = config.countDebounceMs ?? 150;
		this.#domainChangeThreshold = config.domainChangeThreshold ?? 2.0;

		this.#frameCallback = (_isAnimating: boolean) => this.#onFrame();
		this.#gpuCoordinator.addFrameCallback(this.#frameCallback);
	}

	// =========================================================================
	// Frame callback — query scheduling only
	// =========================================================================

	#onFrame(): void {
		if (this.#destroyed) return;
		this.frameCallbackCount++;

		// Fast path: read x domain target directly, skip everything if unchanged.
		// Two number comparisons — no property chain traversal, no allocations.
		const xState = this.#chartContext.xScaleState;
		if (!xState) return;
		const target = (xState as { domain?: { target?: [number, number] } }).domain?.target;
		if (!target) return;
		const lo = target[0];
		const hi = target[1];
		if (lo === this.#lastSeenLo && hi === this.#lastSeenHi) {
			// The same view: nothing to count again, unless the mark counts its own
			// rows and they are other rows now (a new result).
			if (this.#version && this.#version() !== this.#countedVersion) this.#countHeld(lo, hi);
			return;
		}

		// Domain changed — run full check.
		// Only update lastSeen after a successful query attempt — if the
		// query builder returns null (setup not complete), we must re-detect
		// this domain on the next frame.
		this.timeSinceLastQuery = performance.now() - this.#lastCountTime;
		this.#checkDomainAndQuery(lo, hi);
	}

	// =========================================================================
	// Domain checking + count query scheduling
	// =========================================================================

	#checkDomainAndQuery(lo: number, hi: number): void {
		if (!isFinite(lo) || !isFinite(hi) || lo >= hi) return;

		// Read y domain if available (continuous y scale)
		let yLo = -Infinity;
		let yHi = Infinity;
		const yState = this.#chartContext.yScaleState;
		if (yState) {
			const yTarget = (yState as { domain?: { target?: [number, number] } }).domain?.target;
			if (yTarget) {
				const y0 = yTarget[0];
				const y1 = yTarget[1];
				if (typeof y0 === 'number' && typeof y1 === 'number' && isFinite(y0) && isFinite(y1)) {
					yLo = y0;
					yHi = y1;
				}
			}
		}

		// Held by the mark: counted on every change of the view, with no query.
		if (this.#countHeldIn(lo, hi, yLo, yHi)) return;

		if (this.#shouldQueryCount(lo, hi)) {
			this.#issueCountQuery(lo, hi, yLo, yHi);
		}
	}

	/** The y view, then #countHeldIn: for a frame whose view did not move. */
	#countHeld(lo: number, hi: number): boolean {
		if (!isFinite(lo) || !isFinite(hi) || lo >= hi) return false;
		let yLo = -Infinity;
		let yHi = Infinity;
		const yTarget = (this.#chartContext.yScaleState as { domain?: { target?: unknown[] } } | null)
			?.domain?.target;
		if (yTarget) {
			const y0 = yTarget[0];
			const y1 = yTarget[1];
			if (typeof y0 === 'number' && typeof y1 === 'number' && isFinite(y0) && isFinite(y1)) {
				yLo = y0;
				yHi = y1;
			}
		}
		return this.#countHeldIn(lo, hi, yLo, yHi);
	}

	/**
	 * Take the count from the mark, when it holds its points. True when it did:
	 * no query is to be sent. One pass over the mark's rows, a grid's at most.
	 */
	#countHeldIn(lo: number, hi: number, yLo: number, yHi: number): boolean {
		const count = this.#countInView?.(lo, hi, yLo, yHi) ?? 'ask';
		// Its first result is on its way: asked again next frame, nothing sent.
		if (count === 'wait') return true;
		if (count === 'ask') {
			// Not asked again for these rows on a frame whose view did not move.
			this.#countedVersion = this.#version?.() ?? -1;
			return false;
		}
		// A query still out is of a result the mark no longer needs counted.
		this.#querySequence++;
		this.#countQueryPending = false;
		this.#lastSeenLo = lo;
		this.#lastSeenHi = hi;
		this.#countedVersion = this.#version?.() ?? -1;
		this.#applyCount(count, lo, hi);
		return true;
	}

	/** A count of the view [lo, hi]: the diagnostics, the context, the decimation. */
	#applyCount(count: number, lo: number, hi: number): void {
		this.visibleCount = count;
		this.#lastCountTime = performance.now();
		this.#lastCountDomainLo = lo;
		this.#lastCountDomainHi = hi;

		const pw = this.#getPixelWidth();
		const density = pw > 0 ? count / pw : 0;
		const avgSpacing = count > 0 ? pw / count : Infinity;

		this.ctx.visibleCount = count;
		this.ctx.pixelWidth = pw;
		this.ctx.density = density;
		this.ctx.avgSpacing = avgSpacing;

		// Evaluate decimation with hysteresis
		this.#evaluateDecimation(density);
	}

	#shouldQueryCount(lo: number, hi: number): boolean {
		const now = performance.now();
		const elapsed = now - this.#lastCountTime;
		if (elapsed > this.#countDebounceMs) return true;

		const lastWidth = this.#lastCountDomainHi - this.#lastCountDomainLo;
		if (lastWidth <= 0) return true;

		const currentWidth = hi - lo;
		const ratio = lastWidth / currentWidth;
		if (ratio > this.#domainChangeThreshold || ratio < 1 / this.#domainChangeThreshold) {
			return true;
		}

		return false;
	}

	// =========================================================================
	// Count query execution
	// =========================================================================

	async #issueCountQuery(lo: number, hi: number, yLo: number, yHi: number): Promise<void> {
		if (this.#countQueryPending || this.#destroyed) return;

		const sqlStr = this.#countQueryBuilder(lo, hi, yLo, yHi);
		if (!sqlStr) return; // Setup not ready — don't update lastSeen, retry next frame

		// Query builder succeeded — commit this domain as seen
		this.#lastSeenLo = lo;
		this.#lastSeenHi = hi;

		this.#countQueryPending = true;
		const seq = ++this.#querySequence;
		const t0 = performance.now();

		try {
			const result = await this.#queryEngine.query(sqlStr, { callerId: this.#callerId });
			const t1 = performance.now();

			if (seq !== this.#querySequence || this.#destroyed) return;

			// Iterator-based first row — avoids Array.from() allocation
			const iter = result[Symbol.iterator]();
			const row = iter.next().value as { cnt: number } | undefined;
			const count = Number(row?.cnt ?? 0);

			// Update diagnostics (non-reactive)
			this.queryLatencyMs = t1 - t0;
			this.queriesIssued++;
			this.#applyCount(count, lo, hi);
		} catch (e) {
			console.warn('[DensityHost] Count query failed:', e);
		} finally {
			if (seq === this.#querySequence) {
				this.#countQueryPending = false;
			}
		}
	}

	// =========================================================================
	// Decimation hysteresis
	// =========================================================================

	#evaluateDecimation(density: number): void {
		if (this.#decimate === true) {
			this.ctx.shouldDecimate = true;
		} else if (this.#decimate === false) {
			this.ctx.shouldDecimate = false;
		} else {
			// 'auto': hysteresis — decimate at threshold, un-decimate at threshold - margin
			this.ctx.shouldDecimate = this.ctx.shouldDecimate
				? density >= this.#densityThreshold - this.#hysteresis
				: density >= this.#densityThreshold;
		}
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	#getPixelWidth(): number {
		const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
		return this.#chartContext.innerWidth * dpr;
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	destroy(): void {
		this.#destroyed = true;

		if (this.#frameCallback) {
			this.#gpuCoordinator.removeFrameCallback(this.#frameCallback);
			this.#frameCallback = null;
		}
	}
}

/**
 * The rows of a result inside a view: `x` in [xLo, xHi] and, with a finite y
 * view, `y` in [yLo, yHi]. What the count query asks the database of the mark's
 * own query, for a mark whose result holds every point it draws. A NaN (a
 * padded row with no value) is in no range, as in SQL. One pass, no allocation.
 */
export function countRowsInView(
	x: ArrayLike<number>,
	y: ArrayLike<number> | null,
	xLo: number,
	xHi: number,
	yLo: number,
	yHi: number
): number {
	const withY = y !== null && isFinite(yLo) && isFinite(yHi);
	let count = 0;
	for (let i = 0; i < x.length; i++) {
		const xv = x[i];
		if (!(xv >= xLo && xv <= xHi)) continue;
		if (withY) {
			const yv = y[i];
			if (!(yv >= yLo && yv <= yHi)) continue;
		}
		count++;
	}
	return count;
}
