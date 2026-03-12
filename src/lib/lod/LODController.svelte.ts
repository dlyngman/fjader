// =============================================================================
// LODController — JS-side LOD policy for all mark types
//
// Two modes:
//
// LINE MODE (Phase 0):
//   Owns density measurement via DuckDB count queries and LOD evaluation.
//   Controls M4 decimation mode and spring-animated dot radius.
//   All per-frame work lives in a single frame callback — no Svelte effects.
//
// BINNED MODE (Phase 1):
//   Owns adaptive re-binning for marks with bin() channels. Replaces Effect 8
//   in MarkLifecycle. Derives bin metrics geometrically from data + scale state.
//   No DuckDB queries, no spring, no GPU writes — just metric derivation and
//   re-bin triggering via frame callback.
//
// Frame callback contract: LODController runs as a post-render frame callback
// via GPUCoordinator.addFrameCallback(). LOD state updates are next-frame
// policy updates, not same-frame render control. The 1-frame lag is intentional
// and imperceptible — LOD is a policy decision, not a frame-perfect requirement.
//
// Decimation mode ownership (line mode only): LODController controls M4's
// decimation mode only while attached. LineMark owns the default ('decimate')
// and restores it when the controller detaches.
// =============================================================================

import { Query, column as sqlColumn, sql, and } from '@uwdata/mosaic-sql';
import type { ExprValue } from '@uwdata/mosaic-sql';
import { Priority } from '@uwdata/mosaic-core';
import type { Coordinator } from '@uwdata/mosaic-core';
import { Spring, DT } from '$lib/animation/Spring';
import type { ChartContext, LODChangeState } from '$lib/types';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import type { M4Decimator } from '$lib/gpu/decimation/M4Decimator.svelte';
import type { MarkLifecycle } from '$lib/components/marks/lifecycle/MarkLifecycle.svelte';

// JS implementation of GLSL smoothstep (Hermite interpolation)
function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

// ---- Config types ----

export interface LineConfig {
	mode: 'line';
	table: string;
	xField: string;
	baseR: number;
	setup?: { currentFilter: unknown[] } | null;
	dotsEnabled?: boolean;
	dotsThreshold?: number;
	decimate?: boolean | 'auto';
	densityThreshold?: number;
	countDebounceMs?: number;
	domainChangeThreshold?: number;
	onLODChange?: ((state: LODChangeState) => void) | null;
}

export interface BinnedConfig {
	mode: 'binned';
	markLifecycle: MarkLifecycle;
	binAxes: ('x' | 'y')[];
	binningThreshold?: number; // domain ratio threshold for re-bin (default 1.25)
}

export type LODControllerConfig = LineConfig | BinnedConfig;

export class LODController {
	// --- Shared state ---
	#gpuCoordinator: GPUCoordinator;
	#chartContext: ChartContext;
	#mode: 'line' | 'binned';
	#frameCallback: ((isAnimating: boolean) => void) | null = null;
	#destroyed = false;

	// --- Line mode state ---
	#coordinator: Coordinator | null = null;
	#table: string = '';
	#xField: string = '';
	#baseR: number = 0;
	#setup: { currentFilter: unknown[] } | null = null;
	#m4Decimator: M4Decimator | null = null;
	#dotsEnabled: boolean = true;
	#dotsThreshold: number = 18;
	#decimate: boolean | 'auto' = 'auto';
	#densityThreshold: number = 4;
	#decimateHysteresis: number = 0.5;
	#countDebounceMs: number = 150;
	#domainChangeThreshold: number = 2.0;
	#lastCountTime: number = 0;
	#lastCountDomain: [number, number] = [0, 0];
	#countQueryPending: boolean = false;
	#querySequence: number = 0;
	#dotRadiusSpring: Spring | null = null;
	#lastSpringTime: number = 0;
	#writeDotRadius: ((r: number) => void) | null = null;
	#invalidateLayer: (() => void) | null = null;
	#onLODChange: ((state: LODChangeState) => void) | null = null;
	#prevDecimating: boolean = false;
	#prevDotsVisible: boolean = false;

	// --- Binned mode state ---
	#markLifecycle: MarkLifecycle | null = null;
	#binAxes: ('x' | 'y')[] = ['x'];
	#prevMultiplier: number = 1.0;
	#lastReBinDomain: { x: [number, number]; y: [number, number] } = {
		x: [0, 0],
		y: [0, 0]
	};
	#binningThreshold: number = 1.25;
	#rebinTimeout: ReturnType<typeof setTimeout> | null = null;

	// --- Diagnostic state (plain properties, NOT reactive — polled by test page) ---
	// Line mode diagnostics
	visibleCount: number = 0;
	queryLatencyMs: number = 0;
	timeSinceLastQuery: number = 0;
	dotRadius: number = 0;
	shouldDecimate: boolean = false;
	queriesIssued: number = 0;

	// Binned mode diagnostics
	binStep: number = 0;
	numVisibleBins: number = 0;
	binWidthPx: number = 0;

	// Shared diagnostics
	frameCallbackCount: number = 0;

	// --- Derived ---
	get mode(): 'line' | 'binned' {
		return this.#mode;
	}

	get density(): number {
		const pw = this.pixelWidth;
		if (pw <= 0) return 0;
		if (this.#mode === 'line') {
			return this.visibleCount / pw;
		}
		return this.numVisibleBins / pw;
	}

	get pixelWidth(): number {
		const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
		return this.#chartContext.innerWidth * dpr;
	}

	constructor(
		coordinator: Coordinator | null,
		gpuCoordinator: GPUCoordinator,
		chartContext: ChartContext,
		config: LODControllerConfig
	) {
		this.#gpuCoordinator = gpuCoordinator;
		this.#chartContext = chartContext;
		this.#mode = config.mode;

		if (config.mode === 'line') {
			this.#coordinator = coordinator!;
			this.#table = config.table;
			this.#xField = config.xField;
			this.#baseR = config.baseR;
			this.#setup = config.setup ?? null;
			this.#dotsEnabled = config.dotsEnabled ?? true;
			this.#dotsThreshold = config.dotsThreshold ?? 18;
			this.#decimate = config.decimate ?? 'auto';
			this.#densityThreshold = config.densityThreshold ?? 4;
			this.#countDebounceMs = config.countDebounceMs ?? 150;
			this.#domainChangeThreshold = config.domainChangeThreshold ?? 2.0;
			this.#onLODChange = config.onLODChange ?? null;
			this.#dotRadiusSpring = this.#dotsEnabled ? new Spring(0, 400) : null;
			this.#lastSpringTime = performance.now();
		} else {
			// Binned mode
			this.#markLifecycle = config.markLifecycle;
			this.#binAxes = config.binAxes;
			this.#binningThreshold = config.binningThreshold ?? 1.25;
			this.#prevMultiplier = chartContext.binStepMultiplier ?? 1.0;
		}

		// Both modes use frame callbacks
		this.#frameCallback = (_isAnimating: boolean) => this.#onFrame();
		this.#gpuCoordinator.addFrameCallback(this.#frameCallback);
	}

	// =========================================================================
	// LINE MODE — GPU write target (set by LineMark after renderer init)
	// =========================================================================

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

	/**
	 * Update the M4 decimator reference. Called when M4 is created/destroyed
	 * independently of this controller's lifecycle.
	 */
	setM4Decimator(decimator: M4Decimator | null): void {
		this.#m4Decimator = decimator;
		// Sync current decimation state to the new decimator
		if (decimator) {
			decimator.setDecimationMode(this.shouldDecimate ? 'decimate' : 'passthrough');
		}
	}

	// =========================================================================
	// SHARED — resolution control (shift+scroll routing target)
	// =========================================================================

	/**
	 * Adjust resolution. Called by ChartCell when shift+scroll targets this mark.
	 * For binned mode: adjusts binStepMultiplier on the chart context.
	 * For line mode: adjusts density threshold offset (future).
	 */
	adjustResolution(deltaY: number): void {
		if (this.#mode === 'binned') {
			const delta = deltaY < 0 ? 0.025 : -0.025;
			this.#chartContext.adjustBinMultiplier?.(delta);
		}
		// Line mode: future — adjust density threshold offset
	}

	// =========================================================================
	// FRAME CALLBACK — dispatches to mode-specific handler
	// =========================================================================

	#onFrame(): void {
		if (this.#destroyed) return;
		this.frameCallbackCount++;

		if (this.#mode === 'line') {
			this.#onFrameLine();
		} else {
			this.#onFrameBinned();
		}
	}

	// =========================================================================
	// LINE MODE — count query scheduling + spring + GPU write
	// =========================================================================

	#onFrameLine(): void {
		this.timeSinceLastQuery = performance.now() - this.#lastCountTime;
		this.#checkDomainAndQuery();
		this.#stepSpringAndWrite();
	}

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

	async #issueCountQuery(lo: number, hi: number): Promise<void> {
		if (this.#countQueryPending || this.#destroyed || !this.#coordinator) return;

		this.#countQueryPending = true;
		const seq = ++this.#querySequence;
		const t0 = performance.now();

		try {
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

			if (seq !== this.#querySequence || this.#destroyed) return;

			const row = Array.from(result)[0] as { cnt: number } | undefined;
			const count = Number(row?.cnt ?? 0);

			this.visibleCount = count;
			this.queryLatencyMs = t1 - t0;
			this.queriesIssued++;
			this.#lastCountTime = t1;
			this.#lastCountDomain = [lo, hi];

			this.#evaluateLOD();
		} catch (e) {
			console.warn('[LODController] Count query failed:', e);
		} finally {
			if (seq === this.#querySequence) {
				this.#countQueryPending = false;
			}
		}
	}

	#evaluateLOD(): void {
		const pw = this.pixelWidth;
		if (pw <= 0) return;

		const count = this.visibleCount;
		const ppp = count / pw;

		// Decimation decision: respect explicit decimate config
		let newShouldDecimate: boolean;
		if (this.#decimate === true) {
			newShouldDecimate = true;
		} else if (this.#decimate === false) {
			newShouldDecimate = false;
		} else {
			// 'auto': hysteresis — decimate at threshold, un-decimate at threshold - margin
			newShouldDecimate = this.shouldDecimate
				? ppp >= this.#densityThreshold - this.#decimateHysteresis
				: ppp >= this.#densityThreshold;
		}

		if (newShouldDecimate !== this.shouldDecimate) {
			this.shouldDecimate = newShouldDecimate;
			if (this.#m4Decimator) {
				this.#m4Decimator.setDecimationMode(
					newShouldDecimate ? 'decimate' : 'passthrough'
				);
			}
		}

		// Dots: compute target radius (0 when disabled)
		if (this.#dotsEnabled) {
			const avgSpacing = pw / Math.max(count, 1);
			const targetR = this.#baseR * smoothstep(8, this.#dotsThreshold, avgSpacing);
			this.#dotRadiusSpring?.setTarget(targetR);
		}

		// Fire onLODChange on state transitions
		this.#fireChangeIfNeeded();
	}

	#fireChangeIfNeeded(): void {
		if (!this.#onLODChange) return;
		const decimating = this.shouldDecimate;
		const dotsVisible = this.dotRadius > 0;
		if (decimating !== this.#prevDecimating || dotsVisible !== this.#prevDotsVisible) {
			this.#prevDecimating = decimating;
			this.#prevDotsVisible = dotsVisible;
			this.#onLODChange({
				decimating,
				dotRadius: this.dotRadius,
				visibleCount: this.visibleCount,
				density: this.density
			});
		}
	}

	#stepSpringAndWrite(): void {
		if (!this.#dotRadiusSpring || this.#dotRadiusSpring.isAtRest()) return;

		const now = performance.now();
		const elapsed = now - this.#lastSpringTime;
		this.#lastSpringTime = now;

		const steps = Math.min(Math.floor(elapsed / (DT * 1000)), 20);
		for (let i = 0; i < steps; i++) {
			this.#dotRadiusSpring.step();
		}

		const r = this.#dotRadiusSpring.current;
		this.#writeDotRadius?.(r);
		this.#invalidateLayer?.();
		this.dotRadius = r;
	}

	// =========================================================================
	// BINNED MODE — geometric metric derivation + re-bin triggering
	// =========================================================================

	#onFrameBinned(): void {
		if (!this.#markLifecycle) return;

		// 1. Check multiplier changes BEFORE data gate — shift+scroll must
		//    trigger re-bins even while a previous query is in-flight (data is
		//    temporarily null during query). Without this, scroll events that
		//    arrive while waiting for results are silently dropped.
		//    Uses the first binned axis for the domain snapshot.
		const multiplier = this.#chartContext.binStepMultiplier ?? 1.0;
		if (multiplier !== this.#prevMultiplier) {
			this.#prevMultiplier = multiplier;
			const domain = this.#readDomain(this.#binAxes[0]);
			if (domain) {
				this.#markLifecycle.triggerReBin(this.#binAxes[0], domain);
			}
			return;
		}

		// 2. Derive bin metrics from data (may be null during query)
		const data = this.#markLifecycle.data;
		if (!data || data.length < 1) return;

		// Use first binned axis for diagnostic metrics
		const primaryAxis = this.#binAxes[0];
		const ch1 = primaryAxis === 'x' ? 'x1' : 'y1';
		const ch2 = primaryAxis === 'x' ? 'x2' : 'y2';
		const col1 = data.getColumn(ch1);
		const col2 = data.getColumn(ch2);
		if (col1 && col2) {
			this.binStep = Math.abs(Number(col2[0]) - Number(col1[0]));
			if (this.binStep > 0) {
				const domain = this.#readDomain(primaryAxis);
				if (domain) {
					const viewportWidth = domain[1] - domain[0];
					this.numVisibleBins = viewportWidth / this.binStep;
					const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
					const pixelExtent =
						primaryAxis === 'x'
							? this.#chartContext.innerWidth * dpr
							: this.#chartContext.innerHeight * dpr;
					this.binWidthPx = this.numVisibleBins > 0 ? pixelExtent / this.numVisibleBins : 0;
				}
			}
		}

		// 3. Check domain threshold for each binned axis independently
		for (const axis of this.#binAxes) {
			const domain = this.#readDomain(axis);
			if (domain && this.#shouldReBin(axis, domain)) {
				this.#debouncedReBin(axis);
			}
		}
	}

	/** Read the current domain [lo, hi] for an axis, or null if unavailable. */
	#readDomain(axis: 'x' | 'y'): [number, number] | null {
		const scaleState =
			axis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;
		if (!scaleState || !('domain' in scaleState)) return null;
		const domain = (scaleState as { domain?: { target?: [number, number] } }).domain;
		if (!domain?.target) return null;
		const [lo, hi] = domain.target;
		if (!isFinite(lo) || !isFinite(hi) || lo >= hi) return null;
		return [lo, hi];
	}

	#shouldReBin(axis: 'x' | 'y', domain: [number, number]): boolean {
		const [lastLo, lastHi] = this.#lastReBinDomain[axis];
		const lastWidth = lastHi - lastLo;
		if (lastWidth <= 0) {
			// First run — seed the baseline from current domain
			this.#lastReBinDomain[axis] = domain;
			return false;
		}

		const currentWidth = domain[1] - domain[0];
		if (currentWidth <= 0) return false;

		const ratio = lastWidth / currentWidth;
		return ratio > this.#binningThreshold || ratio < 1 / this.#binningThreshold;
	}

	#debouncedReBin(axis: 'x' | 'y'): void {
		if (this.#rebinTimeout !== null) return; // Already scheduled
		this.#rebinTimeout = setTimeout(() => {
			this.#rebinTimeout = null;
			if (this.#destroyed || !this.#markLifecycle) return;
			// Read live domain at execution time — during fast zoom the domain
			// may have moved significantly since the re-bin was scheduled.
			const liveDomain = this.#readDomain(axis);
			if (!liveDomain) return;
			this.#lastReBinDomain[axis] = liveDomain;
			this.#markLifecycle.triggerReBin(axis, liveDomain);
		}, 16);
	}

	// =========================================================================
	// LIFECYCLE
	// =========================================================================

	destroy(): void {
		this.#destroyed = true;

		if (this.#frameCallback) {
			this.#gpuCoordinator.removeFrameCallback(this.#frameCallback);
			this.#frameCallback = null;
		}

		if (this.#rebinTimeout !== null) {
			clearTimeout(this.#rebinTimeout);
			this.#rebinTimeout = null;
		}

		this.#markLifecycle = null;

		this.#writeDotRadius = null;
		this.#invalidateLayer = null;
	}
}
