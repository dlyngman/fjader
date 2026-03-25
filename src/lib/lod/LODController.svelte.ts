// =============================================================================
// LODController — JS-side LOD policy for all mark types
//
// Two modes:
//
// LINE MODE:
//   Delegates density measurement to DensityHost. Consumes DensityHost.ctx
//   and shouldDecimate reactively via $derived/$effect. Dot radius spring
//   is stepped by GPUCoordinator's 360Hz physics loop. Frame callback does
//   GPU writes only (read spring.current → writeDotRadius → invalidateLayer).
//
// BINNED MODE:
//   Owns adaptive re-binning for marks with bin() channels. Derives bin
//   metrics geometrically from data + scale state. No DuckDB queries, no
//   spring, no GPU writes — just metric derivation and re-bin triggering
//   via frame callback.
//
// Decimation mode ownership (line mode only): LODController controls M4's
// decimation mode only while attached. LineMark owns the default ('decimate')
// and restores it when the controller detaches.
// =============================================================================

import type { Query } from '@uwdata/mosaic-sql';
import { Spring } from '$lib/animation/Spring';
import type { ChartContext, LODChangeState } from '$lib/types';
import type { SmoothMode } from '$lib/sql/rolling-avg';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import type { M4Decimator } from '$lib/gpu/decimation/M4Decimator.svelte';
import type { MarkLifecycle } from '$lib/components/marks/lifecycle/MarkLifecycle.svelte';
import { DensityHost } from './DensityHost.svelte';

// JS implementation of GLSL smoothstep (Hermite interpolation)
function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

// ---- Config types ----

export interface LineConfig {
	mode: 'line';
	baseR: number;
	/**
	 * Builds viewport count query by wrapping the mark's assembled query as a
	 * derived table: SELECT COUNT(*) FROM (mark_query) WHERE x/y BETWEEN ...
	 * Handles type coercion (time scales), aggregates, bins — one path for all marks.
	 */
	countQueryBuilder: (xLo: number, xHi: number, yLo: number, yHi: number) => Query | null;
	dotsEnabled?: boolean;
	dotsThreshold?: number;
	decimate?: boolean | 'auto';
	densityThreshold?: number;
	countDebounceMs?: number;
	domainChangeThreshold?: number;
	/** Initial smoothing window size (from persisted config). Default: 0 (off). */
	smoothWindow?: number;
	/** Initial smooth mode. Default: 'centered'. */
	smoothMode?: SmoothMode;
	onLODChange?: ((state: LODChangeState) => void) | null;
	/** Fired when a tunable value changes (shift+scroll, programmatic). Lets the mark persist to ChartConfig. */
	onTunableChange?: ((key: string, value: number | string) => void) | null;
}

export interface BinnedConfig {
	mode: 'binned';
	markLifecycle: MarkLifecycle;
	binAxes: ('x' | 'y')[];
	binningThreshold?: number; // domain ratio threshold for re-bin (default 1.25)
	/** Fired when multiplier changes (shift+scroll). Lets the mark persist to ChartConfig. */
	onTunableChange?: ((key: 'multiplier', value: number) => void) | null;
}

export type LODControllerConfig = LineConfig | BinnedConfig;

/** Reactive LOD state — palette reads this, updated at well-defined moments. */
export interface LODState {
	mode: 'line' | 'binned';
	density: number;
	// Line mode — diagnostic
	visibleCount: number;
	shouldDecimate: boolean;
	dotsVisible: boolean;
	// Line mode — tunable
	dotsThreshold: number;
	baseRadius: number;
	// Line mode — smoothing overlay
	smoothWindow: number;
	smoothActive: boolean;
	smoothMode: SmoothMode;
	// Binned mode — diagnostic
	binStep: number;
	numVisibleBins: number;
	binWidthPx: number;
	// Binned mode — tunable
	binMultiplier: number;
}

export class LODController {
	// --- Shared state ---
	#gpuCoordinator: GPUCoordinator;
	#chartContext: ChartContext;
	#mode: 'line' | 'binned';
	#frameCallback: ((isAnimating: boolean) => void) | null = null;
	#destroyed = false;

	// --- Line mode state ---
	#densityHost: DensityHost | null = null;
	#dotRadiusSpring: Spring | null = null;
	#physicsCallback: (() => void) | null = null;
	#writeDotRadius: ((r: number) => void) | null = null;
	#invalidateLayer: (() => void) | null = null;
	#m4Decimator: M4Decimator | null = null;
	#baseR: number = $state(0);
	#dotsEnabled: boolean = true;
	#dotsThreshold: number = $state(18);
	#onLODChange: ((state: LODChangeState) => void) | null = null;
	#onTunableChange: ((key: string, value: number | string) => void) | null = null;
	#prevDecimating: boolean = false;
	#prevDotsVisible: boolean = false;
	#smoothWindow: number = 0;
	#smoothMode: SmoothMode = 'centered';
	#smoothScrollAccum: number = 0;

	// --- Line mode — reactive spring target from DensityHost.ctx ---
	#springTarget = $derived.by(() => {
		if (!this.#dotsEnabled || !this.#densityHost) return 0;
		const { avgSpacing } = this.#densityHost.ctx;
		return this.#baseR * smoothstep(8, this.#dotsThreshold, avgSpacing);
	});

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
	#lastPublishedBinStep: number = 0;

	// --- Diagnostic state (plain properties, NOT reactive — polled by test page) ---
	// Line mode diagnostics — forwarded from DensityHost
	get visibleCount(): number {
		return this.#densityHost?.visibleCount ?? 0;
	}
	get queryLatencyMs(): number {
		return this.#densityHost?.queryLatencyMs ?? 0;
	}
	get timeSinceLastQuery(): number {
		return this.#densityHost?.timeSinceLastQuery ?? 0;
	}
	get queriesIssued(): number {
		return this.#densityHost?.queriesIssued ?? 0;
	}
	dotRadius: number = 0;
	shouldDecimate: boolean = false;

	// Binned mode diagnostics
	binStep: number = 0;
	numVisibleBins: number = 0;
	binWidthPx: number = 0;

	// Shared diagnostics
	get frameCallbackCount(): number {
		if (this.#mode === 'line') {
			return this.#densityHost?.frameCallbackCount ?? 0;
		}
		return this.#binnedFrameCallbackCount;
	}
	#binnedFrameCallbackCount: number = 0;

	// --- Reactive display state — palette reads this ---
	readonly state: LODState = $state({
		mode: 'line' as 'line' | 'binned',
		density: 0,
		visibleCount: 0,
		shouldDecimate: false,
		dotsVisible: false,
		dotsThreshold: 18,
		baseRadius: 0,
		smoothWindow: 0,
		smoothActive: false,
		smoothMode: 'centered' as SmoothMode,
		binStep: 0,
		numVisibleBins: 0,
		binWidthPx: 0,
		binMultiplier: 1.0
	});

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
		coordinator: import('@uwdata/mosaic-core').Coordinator | null,
		gpuCoordinator: GPUCoordinator,
		chartContext: ChartContext,
		config: LODControllerConfig
	) {
		this.#gpuCoordinator = gpuCoordinator;
		this.#chartContext = chartContext;
		this.#mode = config.mode;
		this.state.mode = config.mode;

		if (config.mode === 'line') {
			// Create DensityHost — owns count queries + decimation hysteresis
			this.#densityHost = new DensityHost(gpuCoordinator, chartContext, coordinator!, {
				countQueryBuilder: config.countQueryBuilder,
				decimate: config.decimate,
				densityThreshold: config.densityThreshold,
				countDebounceMs: config.countDebounceMs,
				domainChangeThreshold: config.domainChangeThreshold
			});

			this.#baseR = config.baseR;
			this.#dotsEnabled = config.dotsEnabled ?? true;
			this.#dotsThreshold = config.dotsThreshold ?? 18;
			this.#onLODChange = config.onLODChange ?? null;
			this.#onTunableChange = config.onTunableChange ?? null;
			this.#smoothWindow = config.smoothWindow ?? 0;
			this.#smoothMode = config.smoothMode ?? 'centered';
			this.state.dotsThreshold = this.#dotsThreshold;
			this.state.baseRadius = this.#baseR;
			this.state.smoothWindow = this.#smoothWindow;
			this.state.smoothActive = this.#smoothWindow > 0;
			this.state.smoothMode = this.#smoothMode;

			// Create dot radius spring, step via GPUCoordinator's 360Hz physics loop
			if (this.#dotsEnabled) {
				this.#dotRadiusSpring = new Spring(0, 400);
				this.#physicsCallback = () => this.#dotRadiusSpring!.step();
				gpuCoordinator.addPhysicsCallback(this.#physicsCallback);
			}

			// Bridge derived spring target → spring.setTarget()
			$effect(() => {
				this.#dotRadiusSpring?.setTarget(this.#springTarget);
			});

			// M4 sync from reactive shouldDecimate
			$effect(() => {
				if (!this.#m4Decimator || !this.#densityHost) return;
				const should = this.#densityHost.shouldDecimate;
				this.#m4Decimator.setDecimationMode(should ? 'decimate' : 'passthrough');
			});

			// LODState publication from reactive ctx
			$effect(() => {
				if (!this.#densityHost) return;
				const { visibleCount, density } = this.#densityHost.ctx;
				const shouldDecimate = this.#densityHost.shouldDecimate;
				this.shouldDecimate = shouldDecimate;
				this.state.visibleCount = visibleCount;
				this.state.density = density;
				this.state.shouldDecimate = shouldDecimate;
				this.#fireChangeIfNeeded();
			});

			// Frame callback for GPU spring writes only (once per RAF)
			this.#frameCallback = (_isAnimating: boolean) => this.#onFrameLine();
			this.#gpuCoordinator.addFrameCallback(this.#frameCallback);
		} else {
			// Binned mode — unchanged
			this.#markLifecycle = config.markLifecycle;
			this.#binAxes = config.binAxes;
			this.#binningThreshold = config.binningThreshold ?? 1.25;
			this.#onTunableChange = config.onTunableChange ?? null;
			this.#prevMultiplier = chartContext.binStepMultiplier ?? 1.0;
			this.state.binMultiplier = this.#prevMultiplier;

			this.#frameCallback = (_isAnimating: boolean) => this.#onFrameBinned();
			this.#gpuCoordinator.addFrameCallback(this.#frameCallback);
		}
	}

	// =========================================================================
	// LINE MODE — GPU write target (set by LineMark after renderer init)
	// =========================================================================

	setRenderTarget(writeDotRadius: (r: number) => void, invalidateLayer: () => void): void {
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
		if (decimator && this.#densityHost) {
			decimator.setDecimationMode(this.#densityHost.shouldDecimate ? 'decimate' : 'passthrough');
		}
	}

	// =========================================================================
	// SHARED — resolution control (shift+scroll routing target)
	// =========================================================================

	/**
	 * Adjust resolution. Called by ChartCell when shift+scroll targets this mark.
	 * For binned mode: adjusts binStepMultiplier on the chart context.
	 * For line mode: density-contextual routing along a single resolution axis:
	 *   scroll down (decrease detail) → add/increase smoothing
	 *   scroll up (increase detail) → reduce smoothing, then control dots
	 */
	adjustResolution(deltaY: number): void {
		if (this.#mode === 'binned') {
			const delta = deltaY < 0 ? 0.025 : -0.025;
			this.#chartContext.adjustBinMultiplier?.(delta);
		} else {
			const decreaseDetail = deltaY > 0;

			if (this.#smoothWindow > 0 || (decreaseDetail && this.visibleCount > 50)) {
				// Smoothing active or starting — accumulate scroll before stepping
				this.#smoothScrollAccum += deltaY;
				const threshold = 60; // px of scroll per window step
				if (Math.abs(this.#smoothScrollAccum) >= threshold) {
					const steps = Math.trunc(this.#smoothScrollAccum / threshold);
					this.#smoothScrollAccum -= steps * threshold;
					this.setSmoothWindow(this.#smoothWindow + steps);
				}
			} else {
				// Control dots threshold
				const step = deltaY < 0 ? -1 : 1;
				this.setDotsThreshold(this.#dotsThreshold + step);
			}
		}
	}

	// =========================================================================
	// PALETTE — tunable value setters
	// =========================================================================

	/** Set dots average-spacing threshold (line mode). Range: 10–100. */
	setDotsThreshold(value: number): void {
		if (this.#mode !== 'line') return;
		const clamped = Math.max(10, Math.min(100, value));
		if (clamped === this.#dotsThreshold) return;
		this.#dotsThreshold = clamped;
		this.state.dotsThreshold = clamped;
		this.#onTunableChange?.('dotsThreshold', clamped);
	}

	/** Set base dot radius in px (line mode). Range: 0.5–20. */
	setBaseRadius(value: number): void {
		if (this.#mode !== 'line') return;
		const clamped = Math.max(0.5, Math.min(20, value));
		if (clamped === this.#baseR) return;
		this.#baseR = clamped;
		this.state.baseRadius = clamped;
		this.#onTunableChange?.('baseRadius', clamped);
	}

	/** Set bin step multiplier (binned mode). Range: 0.1–20. */
	setBinMultiplier(value: number): void {
		if (this.#mode !== 'binned') return;
		this.#chartContext.setBinStepMultiplier?.(value);
		this.#onTunableChange?.('multiplier', value);
	}

	/** Set rolling average smoothing window (line mode). Range: 0–100. 0 = off. */
	setSmoothWindow(value: number): void {
		if (this.#mode !== 'line') return;
		const clamped = Math.max(0, Math.min(100, value));
		if (clamped === this.#smoothWindow) return;
		this.#smoothWindow = clamped;
		this.state.smoothWindow = clamped;
		this.state.smoothActive = clamped > 0;
		this.#onTunableChange?.('smoothWindow', clamped);
	}

	/** Set smooth mode: 'centered' (±N) or 'trailing' (←N). */
	setSmoothMode(mode: SmoothMode): void {
		if (this.#mode !== 'line') return;
		if (mode === this.#smoothMode) return;
		this.#smoothMode = mode;
		this.state.smoothMode = mode;
		this.#onTunableChange?.('smoothMode', mode as string);
	}

	// =========================================================================
	// LINE MODE — frame callback (GPU spring write only)
	// =========================================================================

	#onFrameLine(): void {
		if (this.#destroyed) return;
		if (!this.#dotRadiusSpring || this.#dotRadiusSpring.isAtRest()) return;

		const r = this.#dotRadiusSpring.current;
		this.#writeDotRadius?.(r);
		this.#invalidateLayer?.();
		this.dotRadius = r;

		// Publish dotsVisible on threshold crossing (not every frame)
		const nowVisible = r > 0;
		if (nowVisible !== this.state.dotsVisible) {
			this.state.dotsVisible = nowVisible;
		}
	}

	// =========================================================================
	// LINE MODE — onLODChange fire
	// =========================================================================

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
				density: this.density,
				smoothingWindow: this.#smoothWindow
			});
		}
	}

	// =========================================================================
	// BINNED MODE — geometric metric derivation + re-bin triggering
	// =========================================================================

	#onFrameBinned(): void {
		if (this.#destroyed) return;
		this.#binnedFrameCallbackCount++;
		if (!this.#markLifecycle) return;

		// 1. Check multiplier changes BEFORE data gate — shift+scroll must
		//    trigger re-bins even while a previous query is in-flight (data is
		//    temporarily null during query). Without this, scroll events that
		//    arrive while waiting for results are silently dropped.
		//    Uses the first binned axis for the domain snapshot.
		const multiplier = this.#chartContext.binStepMultiplier ?? 1.0;
		if (multiplier !== this.#prevMultiplier) {
			this.#prevMultiplier = multiplier;
			this.state.binMultiplier = multiplier;
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

			// Publish to reactive state when bin step changes (new data arrived)
			if (this.binStep !== this.#lastPublishedBinStep) {
				this.#lastPublishedBinStep = this.binStep;
				this.state.binStep = this.binStep;
				this.state.numVisibleBins = this.numVisibleBins;
				this.state.binWidthPx = this.binWidthPx;
				this.state.density = this.density;
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

		// Line mode: clean up DensityHost + physics callback + frame callback
		if (this.#densityHost) {
			this.#densityHost.destroy();
			this.#densityHost = null;
		}

		if (this.#physicsCallback) {
			this.#gpuCoordinator.removePhysicsCallback(this.#physicsCallback);
			this.#physicsCallback = null;
		}

		if (this.#frameCallback) {
			this.#gpuCoordinator.removeFrameCallback(this.#frameCallback);
			this.#frameCallback = null;
		}

		// Binned mode cleanup
		if (this.#rebinTimeout !== null) {
			clearTimeout(this.#rebinTimeout);
			this.#rebinTimeout = null;
		}

		this.#markLifecycle = null;
		this.#writeDotRadius = null;
		this.#invalidateLayer = null;
	}
}
