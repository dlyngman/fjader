// =============================================================================
// AdaptiveBinRung — adaptive query modifier rung for histogram re-binning
//
// Owns domain watching and re-bin triggering. Frame callback provides proven
// post-render timing semantics. Multiplier changes flow through
// chartContext.setBinStepMultiplier → AutoBinNode reads at resolve time —
// rung and node are decoupled.
//
// A re-bin is decided from the VIEW alone: its rebin level (sql/bin.ts,
// rebinLevel), against the level the mark's bins were last resolved at. No
// baseline of the rung's own, so two marks on one field re-bin on the same
// frame, whenever each was mounted or last re-binned.
//
// No DensityHost — bin metrics are derived geometrically from data.
// =============================================================================

import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import type { ChartContext } from '$lib/types';
import type { LODRung } from './rung-types';

export interface AdaptiveBinRungConfig {
	/** Which axes have bin channels. */
	binAxes: ('x' | 'y')[];
	/** Write-back when multiplier changes (persists to entry for spec export). */
	setParam: (key: string, value: number) => void;
	/** Getter for mark data (MarkLifecycle.data). */
	getData: () => { getColumn(ch: string): ArrayLike<unknown> | null; length: number } | null;
	/**
	 * The rebin level of a view [lo, hi] on a binned axis (rebinLevel over the
	 * binned field's extent). Called every frame: no allocation.
	 */
	levelOf: (axis: 'x' | 'y', lo: number, hi: number) => number;
	/**
	 * Whether the mark's bins, resolved at the view [lo, hi], differ from the
	 * ones it has. Asked only when the level changed: neighbouring levels often
	 * round to the same nice step, and a re-bin to the same bins changes nothing.
	 */
	binsDiffer: (axis: 'x' | 'y', lo: number, hi: number) => boolean;
	/** Trigger re-bin on MarkLifecycle. */
	triggerReBin: (axis: string, domain: number[]) => void;
	/**
	 * Each frame's viewport on a binned axis while no rebin is due, for the
	 * mark's bin window (bin-window.ts). Not called while a rebin is due: the
	 * rebin carries the window, and moving it first would query the old step.
	 * The domain is the rung's own buffer: read it, do not keep it.
	 */
	onViewport?: (axis: 'x' | 'y', domain: [number, number]) => void;
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
	#setParam: (key: string, value: number) => void;
	#getData: () => { getColumn(ch: string): ArrayLike<unknown> | null; length: number } | null;
	#levelOf: (axis: 'x' | 'y', lo: number, hi: number) => number;
	#binsDiffer: (axis: 'x' | 'y', lo: number, hi: number) => boolean;
	#triggerReBin: (axis: string, domain: number[]) => void;
	#onViewport: ((axis: 'x' | 'y', domain: [number, number]) => void) | null;

	// --- Internal state ---
	#frameCallback: ((isAnimating: boolean) => void) | null;
	#prevMultiplier: number;
	/**
	 * The level each axis's bins were last resolved at. 0 until a re-bin: a
	 * mark's first bins are of the field's whole extent.
	 */
	#level = { x: 0, y: 0 };
	/** The view read this frame, per axis: reused, so a frame allocates nothing. */
	#view: { x: [number, number]; y: [number, number] } = { x: [0, 0], y: [0, 0] };
	#rebinTimeout: ReturnType<typeof setTimeout> | null = null;

	// --- Diagnostics (non-reactive, polled) ---
	frameCallbackCount: number = 0;

	/** The first bin's width in data units, from the rows on screen. For the palette. */
	get binStep(): number {
		const data = this.#getData();
		if (!data || data.length < 1) return 0;
		const axis = this.#binAxes[0];
		const lower = data.getColumn(axis === 'x' ? 'x1' : 'y1');
		const upper = data.getColumn(axis === 'x' ? 'x2' : 'y2');
		if (!lower || !upper) return 0;
		return Math.abs(Number(upper[0]) - Number(lower[0]));
	}

	/** About how many bins the view holds. For the palette. */
	get numVisibleBins(): number {
		const step = this.binStep;
		const axis = this.#binAxes[0];
		if (!(step > 0) || !this.#readView(axis)) return 0;
		const view = this.#view[axis];
		return (view[1] - view[0]) / step;
	}

	/** A bin's width in device pixels. For the palette. */
	get binWidthPx(): number {
		const bins = this.numVisibleBins;
		if (!(bins > 0)) return 0;
		const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
		const extent =
			this.#binAxes[0] === 'x' ? this.#chartContext.innerWidth : this.#chartContext.innerHeight;
		return (extent * dpr) / bins;
	}

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
		this.#setParam = config.setParam;
		this.#getData = config.getData;
		this.#levelOf = config.levelOf;
		this.#binsDiffer = config.binsDiffer;
		this.#triggerReBin = config.triggerReBin;
		this.#onViewport = config.onViewport ?? null;
		this.#prevMultiplier = chartContext.binStepMultiplier ?? 1.0;

		// Frame callback for domain watching
		this.#frameCallback = (_isAnimating: boolean) => this.#onFrame();
		gpuCoordinator.addFrameCallback(this.#frameCallback);
	}

	// =========================================================================
	// Frame callback — re-bin triggering
	// =========================================================================

	#onFrame(): void {
		if (this.destroyed) return;
		this.frameCallbackCount++;

		// 1. Check multiplier changes BEFORE data gate — shift+scroll must
		//    trigger re-bins even while a previous query is in-flight.
		const multiplier = this.#chartContext.binStepMultiplier ?? 1.0;
		if (multiplier !== this.#prevMultiplier) {
			this.#prevMultiplier = multiplier;
			const axis = this.#binAxes[0];
			if (this.#readView(axis)) this.#reBin(axis);
			return;
		}

		// 2. Nothing to re-bin before the mark has rows (may be null during a query)
		const data = this.#getData();
		if (!data || data.length < 1) return;

		// 3. Each binned axis: a re-bin when its view is at another level
		for (const axis of this.#binAxes) {
			if (!this.#readView(axis)) continue;
			const view = this.#view[axis];
			if (this.#levelOf(axis, view[0], view[1]) !== this.#level[axis]) {
				this.#debouncedReBin(axis);
			} else {
				this.#onViewport?.(axis, view);
			}
		}
	}

	// =========================================================================
	// Domain reading + re-bin decision
	// =========================================================================

	/** The axis's target domain into `#view[axis]`; false when it has none. */
	#readView(axis: 'x' | 'y'): boolean {
		const scaleState =
			axis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;
		if (!scaleState || !('domain' in scaleState)) return false;
		const domain = (scaleState as { domain?: { target?: [number, number] } }).domain;
		if (!domain?.target) return false;
		const [lo, hi] = domain.target;
		if (!isFinite(lo) || !isFinite(hi) || lo >= hi) return false;
		const view = this.#view[axis];
		view[0] = lo;
		view[1] = hi;
		return true;
	}

	#debouncedReBin(axis: 'x' | 'y'): void {
		if (this.#rebinTimeout !== null) return;
		this.#rebinTimeout = setTimeout(() => {
			this.#rebinTimeout = null;
			if (this.destroyed) return;
			// Read live domain at execution time — during fast zoom the domain
			// may have moved significantly since the re-bin was scheduled.
			if (!this.#readView(axis)) return;
			const view = this.#view[axis];
			const level = this.#levelOf(axis, view[0], view[1]);
			if (level === this.#level[axis]) return;
			// The same bins at this level (a nice step spans several): nothing to
			// query. The level is taken, so the question is not asked every frame.
			if (!this.#binsDiffer(axis, view[0], view[1])) {
				this.#level[axis] = level;
				return;
			}
			this.#reBin(axis);
		}, 16);
	}

	/** Re-bin at the view in `#view[axis]`, and take its level. */
	#reBin(axis: 'x' | 'y'): void {
		const view = this.#view[axis];
		this.#level[axis] = this.#levelOf(axis, view[0], view[1]);
		this.#triggerReBin(axis, [view[0], view[1]]);
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
