// =============================================================================
// AdaptiveBinRung — adaptive query modifier rung for histogram re-binning
//
// Owns domain watching, re-bin triggering, and bin metric derivation.
// Frame callback provides proven post-render timing semantics.
// Multiplier changes flow through chartContext.setBinStepMultiplier →
// AutoBinNode reads at resolve time — rung and node are decoupled.
//
// No DensityHost — bin metrics are derived geometrically from data.
// =============================================================================

import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import type { ChartContext } from '$lib/types';
import type { LODRung } from './rung-types';

export interface AdaptiveBinRungConfig {
	/** Which axes have bin channels. */
	binAxes: ('x' | 'y')[];
	/** Domain ratio threshold for re-bin triggering. Default 1.25. */
	binningThreshold?: number;
	/** Write-back when multiplier changes (persists to entry for spec export). */
	setParam: (key: string, value: number) => void;
	/** Getter for mark data (MarkLifecycle.data). */
	getData: () => { getColumn(ch: string): ArrayLike<unknown> | null; length: number } | null;
	/** Trigger re-bin on MarkLifecycle. */
	triggerReBin: (axis: string, domain: number[]) => void;
}

export class AdaptiveBinRung implements LODRung {
	readonly name = 'bins';
	readonly kind = 'adaptive' as const;
	destroyed: boolean = false;

	// Always active for histogram marks
	readonly active = true;

	// --- Dependencies ---
	#gpuCoordinator: GPUCoordinator;
	#chartContext: ChartContext;
	#binAxes: ('x' | 'y')[];
	#binningThreshold: number;
	#setParam: (key: string, value: number) => void;
	#getData: () => { getColumn(ch: string): ArrayLike<unknown> | null; length: number } | null;
	#triggerReBin: (axis: string, domain: number[]) => void;

	// --- Internal state ---
	#frameCallback: ((isAnimating: boolean) => void) | null;
	#prevMultiplier: number;
	#lastReBinDomain: { x: [number, number]; y: [number, number] } = {
		x: [0, 0],
		y: [0, 0]
	};
	#rebinTimeout: ReturnType<typeof setTimeout> | null = null;

	// --- Diagnostics (non-reactive, polled) ---
	binStep: number = 0;
	numVisibleBins: number = 0;
	binWidthPx: number = 0;
	frameCallbackCount: number = 0;

	get props(): Record<string, unknown> {
		return {
			binStep: this.binStep,
			numVisibleBins: this.numVisibleBins,
			binWidthPx: this.binWidthPx,
			multiplier: this.#chartContext.binStepMultiplier ?? 1.0
		};
	}

	constructor(
		gpuCoordinator: GPUCoordinator,
		chartContext: ChartContext,
		config: AdaptiveBinRungConfig
	) {
		this.#gpuCoordinator = gpuCoordinator;
		this.#chartContext = chartContext;
		this.#binAxes = config.binAxes;
		this.#binningThreshold = config.binningThreshold ?? 1.25;
		this.#setParam = config.setParam;
		this.#getData = config.getData;
		this.#triggerReBin = config.triggerReBin;
		this.#prevMultiplier = chartContext.binStepMultiplier ?? 1.0;

		// Frame callback for domain watching + metric derivation
		this.#frameCallback = (_isAnimating: boolean) => this.#onFrame();
		gpuCoordinator.addFrameCallback(this.#frameCallback);
	}

	// =========================================================================
	// Frame callback — metric derivation + re-bin triggering
	// =========================================================================

	#onFrame(): void {
		if (this.destroyed) return;
		this.frameCallbackCount++;

		// 1. Check multiplier changes BEFORE data gate — shift+scroll must
		//    trigger re-bins even while a previous query is in-flight.
		const multiplier = this.#chartContext.binStepMultiplier ?? 1.0;
		if (multiplier !== this.#prevMultiplier) {
			this.#prevMultiplier = multiplier;
			const domain = this.#readDomain(this.#binAxes[0]);
			if (domain) {
				this.#triggerReBin(this.#binAxes[0], domain);
			}
			return;
		}

		// 2. Derive bin metrics from data (may be null during query)
		const data = this.#getData();
		if (!data || data.length < 1) return;

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

	// =========================================================================
	// Domain reading + re-bin threshold
	// =========================================================================

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
		if (this.#rebinTimeout !== null) return;
		this.#rebinTimeout = setTimeout(() => {
			this.#rebinTimeout = null;
			if (this.destroyed) return;
			// Read live domain at execution time — during fast zoom the domain
			// may have moved significantly since the re-bin was scheduled.
			const liveDomain = this.#readDomain(axis);
			if (!liveDomain) return;
			this.#lastReBinDomain[axis] = liveDomain;
			this.#triggerReBin(axis, liveDomain);
		}, 16);
	}

	// =========================================================================
	// Shift+scroll — adjust multiplier
	// =========================================================================

	adjustResolution(deltaY: number): void {
		const delta = deltaY < 0 ? 0.035 : -0.035;
		// Apply to chartContext — frame callback detects the change and triggers re-bin
		this.#chartContext.adjustBinMultiplier?.(delta);
		// Persist to entry for spec export / undo
		const newMultiplier = this.#chartContext.binStepMultiplier ?? 1.0;
		this.#setParam('multiplier', newMultiplier);
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	destroy(): void {
		this.destroyed = true;

		if (this.#frameCallback) {
			this.#gpuCoordinator.removeFrameCallback(this.#frameCallback);
			this.#frameCallback = null;
		}

		if (this.#rebinTimeout !== null) {
			clearTimeout(this.#rebinTimeout);
			this.#rebinTimeout = null;
		}
	}
}
