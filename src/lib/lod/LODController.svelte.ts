// =============================================================================
// LODController — JS-side LOD policy for LineMark (Phase 0)
//
// Owns density measurement (DuckDB count queries) and LOD evaluation.
// All per-frame work lives in a single frame callback — no Svelte effects in
// the hot path. Matches the existing animation pipeline pattern where springs
// are stepped imperatively and GPU buffers are written directly.
//
// Frame callback contract: LODController runs as a post-render frame callback
// via GPUCoordinator.addFrameCallback(). This means LOD state updates (count
// query scheduling, spring stepping, GPU buffer writes) are next-frame policy
// updates, not same-frame render control. The 1-frame lag is intentional and
// imperceptible — LOD is a policy decision, not a frame-perfect requirement.
//
// Decimation mode ownership: LODController controls M4's decimation mode only
// while attached. LineMark owns the default ('decimate') and restores it when
// the controller detaches. LODController.destroy() does not touch M4 state.
// =============================================================================

import { Query, column as sqlColumn, sql, and } from '@uwdata/mosaic-sql';
import type { ExprValue } from '@uwdata/mosaic-sql';
import { Priority } from '@uwdata/mosaic-core';
import type { Coordinator } from '@uwdata/mosaic-core';
import { Spring, DT } from '$lib/animation/Spring';
import type { ChartContext } from '$lib/types';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import type { M4Decimator } from '$lib/gpu/decimation/M4Decimator.svelte';

// JS implementation of GLSL smoothstep (Hermite interpolation)
function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

export interface LODControllerConfig {
	table: string;
	xField: string;
	baseR: number;
	setup?: { currentFilter: unknown[] } | null;
	m4Decimator?: M4Decimator | null;
	densityThreshold?: number; // points per pixel to trigger decimation (default 4)
	countDebounceMs?: number; // minimum ms between count queries (default 150)
	domainChangeThreshold?: number; // domain width ratio to trigger early query (default 2.0)
}

export class LODController {
	// --- Configuration ---
	#coordinator: Coordinator;
	#gpuCoordinator: GPUCoordinator;
	#chartContext: ChartContext;
	#table: string;
	#xField: string;
	#baseR: number;
	#setup: { currentFilter: unknown[] } | null;
	#m4Decimator: M4Decimator | null;
	#densityThreshold: number;
	#countDebounceMs: number;
	#domainChangeThreshold: number;

	// --- Count query state ---
	#lastCountTime: number = 0;
	#lastCountDomain: [number, number] = [0, 0];
	#countQueryPending: boolean = false;
	#querySequence: number = 0;

	// --- Spring ---
	#dotRadiusSpring: Spring;
	#lastSpringTime: number = 0;

	// --- GPU write target ---
	// Set by LineMark after renderer init. Closure writes dotRadius directly
	// to the markConstants GPU buffer — no Svelte reactivity in the hot path.
	#writeDotRadius: ((r: number) => void) | null = null;
	#invalidateLayer: (() => void) | null = null;

	// --- Frame callback ---
	#frameCallback: ((isAnimating: boolean) => void) | null = null;

	// --- Diagnostic state (plain properties, NOT reactive — polled by test page) ---
	// Using plain properties avoids Svelte scheduling overhead on every frame.
	visibleCount: number = 0;
	queryLatencyMs: number = 0;
	timeSinceLastQuery: number = 0;
	dotRadius: number = 0;
	shouldDecimate: boolean = false;
	frameCallbackCount: number = 0;
	queriesIssued: number = 0;

	// --- Derived ---
	get density(): number {
		const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
		const pixelWidth = this.#chartContext.innerWidth * dpr;
		return pixelWidth > 0 ? this.visibleCount / pixelWidth : 0;
	}

	get pixelWidth(): number {
		const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
		return this.#chartContext.innerWidth * dpr;
	}

	// --- Cleanup ---
	#destroyed = false;

	constructor(
		coordinator: Coordinator,
		gpuCoordinator: GPUCoordinator,
		chartContext: ChartContext,
		config: LODControllerConfig
	) {
		this.#coordinator = coordinator;
		this.#gpuCoordinator = gpuCoordinator;
		this.#chartContext = chartContext;
		this.#table = config.table;
		this.#xField = config.xField;
		this.#baseR = config.baseR;
		this.#setup = config.setup ?? null;
		this.#m4Decimator = config.m4Decimator ?? null;
		this.#densityThreshold = config.densityThreshold ?? 4;
		this.#countDebounceMs = config.countDebounceMs ?? 150;
		this.#domainChangeThreshold = config.domainChangeThreshold ?? 2.0;

		// Spring for dot radius — stiffness 400 (default preset, critically damped)
		this.#dotRadiusSpring = new Spring(0, 400);
		this.#lastSpringTime = performance.now();

		// Single frame callback handles everything: domain polling, query scheduling,
		// spring stepping, and GPU buffer writes. No Svelte effects in the hot path.
		this.#frameCallback = (_isAnimating: boolean) => this.#onFrame();
		this.#gpuCoordinator.addFrameCallback(this.#frameCallback);
	}

	/**
	 * Set the GPU write target. Called by LineMark after the renderer is initialized.
	 * The closure writes dotRadius directly to the markConstants buffer at the right offset.
	 */
	setRenderTarget(
		writeDotRadius: (r: number) => void,
		invalidateLayer: () => void
	): void {
		this.#writeDotRadius = writeDotRadius;
		this.#invalidateLayer = invalidateLayer;
	}

	clearRenderTarget(): void {
		this.#writeDotRadius = null;
		this.#invalidateLayer = null;
	}

	// =========================================================================
	// FRAME CALLBACK — all per-frame LOD work in one place
	// =========================================================================

	#onFrame(): void {
		if (this.#destroyed) return;

		this.frameCallbackCount++;
		this.timeSinceLastQuery = performance.now() - this.#lastCountTime;

		// 1. Poll viewport domain and schedule count query if needed
		this.#checkDomainAndQuery();

		// 2. Step the spring and write to GPU
		this.#stepSpringAndWrite();
	}

	// =========================================================================
	// COUNT QUERY SCHEDULING — imperative, no $effect
	// =========================================================================

	#checkDomainAndQuery(): void {
		const xState = this.#chartContext.xScaleState;
		if (!xState || !('domain' in xState)) return;

		const domain = (xState as { domain?: { target?: [number, number] } }).domain;
		if (!domain || !domain.target) return;

		const [lo, hi] = domain.target;
		if (typeof lo !== 'number' || typeof hi !== 'number') return;
		if (!isFinite(lo) || !isFinite(hi) || lo >= hi) return;

		if (this.#shouldQueryCount(lo, hi)) {
			this.#issueCountQuery(lo, hi);
		}
	}

	#shouldQueryCount(lo: number, hi: number): boolean {
		const now = performance.now();
		const elapsed = now - this.#lastCountTime;

		// Time-based debounce
		if (elapsed > this.#countDebounceMs) return true;

		// Domain-change threshold
		const [lastLo, lastHi] = this.#lastCountDomain;
		const lastWidth = lastHi - lastLo;
		if (lastWidth <= 0) return true; // First query

		const currentWidth = hi - lo;
		const ratio = lastWidth / currentWidth;
		if (ratio > this.#domainChangeThreshold || ratio < 1 / this.#domainChangeThreshold) {
			return true;
		}

		return false;
	}

	async #issueCountQuery(lo: number, hi: number): Promise<void> {
		if (this.#countQueryPending || this.#destroyed) return;

		this.#countQueryPending = true;
		const seq = ++this.#querySequence;
		const t0 = performance.now();

		try {
			// Build WHERE clause: viewport BETWEEN + optional crossfilter predicates
			const xCol = sqlColumn(this.#xField);
			const viewportClause = sql`${xCol} BETWEEN ${lo} AND ${hi}`;

			const filters: ExprValue[] = [viewportClause];
			if (this.#setup) {
				const crossfilter = this.#setup.currentFilter;
				if (crossfilter.length > 0) {
					filters.push(...(crossfilter as ExprValue[]));
				}
			}

			const q = Query.from(this.#table)
				.select({ cnt: sql`COUNT(*)` })
				.where(and(filters));

			const result = await this.#coordinator.query(q, { priority: Priority.Low });
			const t1 = performance.now();

			// Discard stale results
			if (seq !== this.#querySequence || this.#destroyed) return;

			const row = Array.from(result)[0] as { cnt: number } | undefined;
			const count = Number(row?.cnt ?? 0);

			// Update diagnostic state (reactive, for test page display only)
			this.visibleCount = count;
			this.queryLatencyMs = t1 - t0;
			this.queriesIssued++;
			this.#lastCountTime = t1;
			this.#lastCountDomain = [lo, hi];

			// Evaluate LOD state from new count
			this.#evaluateLOD();
		} catch (e) {
			// Count query failures are non-critical — log and continue
			console.warn('[LODController] Count query failed:', e);
		} finally {
			if (seq === this.#querySequence) {
				this.#countQueryPending = false;
			}
		}
	}

	// =========================================================================
	// LOD EVALUATION
	// =========================================================================

	#evaluateLOD(): void {
		const pw = this.pixelWidth;
		if (pw <= 0) return;

		const count = this.visibleCount;

		// --- shouldDecimate ---
		const ppp = count / pw; // points per pixel
		const newShouldDecimate = ppp >= this.#densityThreshold;

		if (newShouldDecimate !== this.shouldDecimate) {
			this.shouldDecimate = newShouldDecimate;
			if (this.#m4Decimator) {
				this.#m4Decimator.setDecimationMode(
					newShouldDecimate ? 'decimate' : 'passthrough'
				);
			}
		}

		// --- dotRadius target ---
		const avgSpacing = pw / Math.max(count, 1);
		const targetR = this.#baseR * smoothstep(8, 18, avgSpacing);
		this.#dotRadiusSpring.setTarget(targetR);
	}

	// =========================================================================
	// SPRING + GPU WRITE — direct buffer write, no reactive chain
	// =========================================================================

	#stepSpringAndWrite(): void {
		if (this.#dotRadiusSpring.isAtRest()) return;

		const now = performance.now();
		const elapsed = now - this.#lastSpringTime;
		this.#lastSpringTime = now;

		// Step for accumulated dt (clamped to prevent spiral on tab-away)
		const steps = Math.min(Math.floor(elapsed / (DT * 1000)), 20);
		for (let i = 0; i < steps; i++) {
			this.#dotRadiusSpring.step();
		}

		const r = this.#dotRadiusSpring.current;

		// Write directly to GPU buffer — no Svelte reactivity
		this.#writeDotRadius?.(r);

		// Keep the chart rendering while the spring is active
		this.#invalidateLayer?.();

		// Update diagnostic state (for test page only)
		this.dotRadius = r;
	}

	// =========================================================================
	// LIFECYCLE
	// =========================================================================

	destroy(): void {
		this.#destroyed = true;

		// Remove frame callback
		if (this.#frameCallback) {
			this.#gpuCoordinator.removeFrameCallback(this.#frameCallback);
			this.#frameCallback = null;
		}

		// LODController does not reset decimation mode on teardown.
		// LineMark owns the default and restores it when the controller detaches.

		this.#writeDotRadius = null;
		this.#invalidateLayer = null;
	}
}
