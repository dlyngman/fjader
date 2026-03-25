// =============================================================================
// DensityHost — density measurement + decimation hysteresis
//
// Owns DuckDB count queries for viewport density and publishes results as
// reactive $state. Consumers (LODController, future rung classes) read
// ctx and shouldDecimate via $derived/$effect.
//
// Fire-and-forget: updates ctx and shouldDecimate, then it's done.
// No callbacks, no hooks, no spring concerns.
//
// Frame callback: registered with GPUCoordinator for post-render query
// scheduling. Domain change detection + debounce before issuing count query.
// =============================================================================

import type { Query } from '@uwdata/mosaic-sql';
import { Priority } from '@uwdata/mosaic-core';
import type { Coordinator } from '@uwdata/mosaic-core';
import type { ChartContext } from '$lib/types';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';

// ---- Public types ----

export interface DensityContext {
	visibleCount: number;
	pixelWidth: number;
	density: number; // points per pixel
	avgSpacing: number; // pixels per point
}

export interface DensityHostConfig {
	countQueryBuilder: (xLo: number, xHi: number, yLo: number, yHi: number) => Query | null;
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
	#coordinator: Coordinator;
	#countQueryBuilder: (xLo: number, xHi: number, yLo: number, yHi: number) => Query | null;

	// --- Decimation config ---
	#decimate: boolean | 'auto';
	#densityThreshold: number;
	#hysteresis: number;

	// --- Query scheduling ---
	#countDebounceMs: number;
	#domainChangeThreshold: number;
	#lastCountTime: number = 0;
	#lastCountDomain: [number, number] = [0, 0];
	#countQueryPending: boolean = false;
	#querySequence: number = 0;

	// --- Frame callback ---
	#frameCallback: ((isAnimating: boolean) => void) | null = null;
	#destroyed = false;

	// --- Reactive output ---
	readonly ctx: DensityContext = $state({
		visibleCount: 0,
		pixelWidth: 0,
		density: 0,
		avgSpacing: Infinity
	});

	shouldDecimate: boolean = $state(false);

	// --- Diagnostics (non-reactive, polled by test pages) ---
	visibleCount: number = 0;
	queryLatencyMs: number = 0;
	queriesIssued: number = 0;
	frameCallbackCount: number = 0;
	timeSinceLastQuery: number = 0;

	constructor(
		gpuCoordinator: GPUCoordinator,
		chartContext: ChartContext,
		coordinator: Coordinator,
		config: DensityHostConfig
	) {
		this.#gpuCoordinator = gpuCoordinator;
		this.#chartContext = chartContext;
		this.#coordinator = coordinator;
		this.#countQueryBuilder = config.countQueryBuilder;
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
		this.timeSinceLastQuery = performance.now() - this.#lastCountTime;
		this.#checkDomainAndQuery();
	}

	// =========================================================================
	// Domain checking + count query scheduling
	// =========================================================================

	#checkDomainAndQuery(): void {
		const xState = this.#chartContext.xScaleState;
		if (!xState || !('domain' in xState)) return;

		const domain = (xState as { domain?: { target?: [number, number] } }).domain;
		if (!domain || !domain.target) return;

		const [lo, hi] = domain.target;
		if (typeof lo !== 'number' || typeof hi !== 'number') return;
		if (!isFinite(lo) || !isFinite(hi) || lo >= hi) return;

		// Read y domain if available (continuous y scale)
		let yLo = -Infinity,
			yHi = Infinity;
		const yState = this.#chartContext.yScaleState;
		if (yState && 'domain' in yState) {
			const yDomain = (yState as { domain?: { target?: [number, number] } }).domain;
			if (yDomain?.target) {
				const [y0, y1] = yDomain.target;
				if (typeof y0 === 'number' && typeof y1 === 'number' && isFinite(y0) && isFinite(y1)) {
					yLo = y0;
					yHi = y1;
				}
			}
		}

		if (this.#shouldQueryCount(lo, hi)) {
			this.#issueCountQuery(lo, hi, yLo, yHi);
		}
	}

	#shouldQueryCount(lo: number, hi: number): boolean {
		const now = performance.now();
		const elapsed = now - this.#lastCountTime;
		if (elapsed > this.#countDebounceMs) return true;

		const [lastLo, lastHi] = this.#lastCountDomain;
		const lastWidth = lastHi - lastLo;
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

		this.#countQueryPending = true;
		const seq = ++this.#querySequence;
		const t0 = performance.now();

		try {
			const q = this.#countQueryBuilder(lo, hi, yLo, yHi);
			if (!q) return;

			const result = await this.#coordinator.query(q, { priority: Priority.Low });
			const t1 = performance.now();

			if (seq !== this.#querySequence || this.#destroyed) return;

			const row = Array.from(result)[0] as { cnt: number } | undefined;
			const count = Number(row?.cnt ?? 0);

			// Update diagnostics (non-reactive)
			this.visibleCount = count;
			this.queryLatencyMs = t1 - t0;
			this.queriesIssued++;
			this.#lastCountTime = t1;
			this.#lastCountDomain = [lo, hi];

			// Update reactive context
			const pw = this.#getPixelWidth();
			const density = pw > 0 ? count / pw : 0;
			const avgSpacing = count > 0 ? pw / count : Infinity;

			this.ctx.visibleCount = count;
			this.ctx.pixelWidth = pw;
			this.ctx.density = density;
			this.ctx.avgSpacing = avgSpacing;

			// Evaluate decimation with hysteresis
			this.#evaluateDecimation(density);
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
			this.shouldDecimate = true;
		} else if (this.#decimate === false) {
			this.shouldDecimate = false;
		} else {
			// 'auto': hysteresis — decimate at threshold, un-decimate at threshold - margin
			this.shouldDecimate = this.shouldDecimate
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
