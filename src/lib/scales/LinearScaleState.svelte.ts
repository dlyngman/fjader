// =============================================================================
// LinearScaleState.svelte.ts - Refactored with SpringPair physics
// =============================================================================

import { scaleLinear } from 'd3-scale';
import type { ScaleLinear } from 'd3-scale';
import { extent as d3Extent } from 'd3-array';
import { SpringPair, SPRING_PRESETS } from '$lib/animation';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';

// =============================================================================
// SPRING STIFFNESS PRESETS FOR SCALE INTERACTIONS
// =============================================================================
const SCALE_SPRING_PRESETS = {
	default: SPRING_PRESETS.default.stiffness, // 400 - general animations
	pan: SPRING_PRESETS.pan.stiffness, // 600 - responsive dragging
	zoom: SPRING_PRESETS.zoom.stiffness, // 400 - smooth zoom
	reset: SPRING_PRESETS.reset.stiffness, // 150 - gentle reset animation
	zoomIn: 200 // Initial zoom-in effect
};

// =============================================================================
// TYPES
// =============================================================================

interface LinearScaleOptions {
	disableZoom?: boolean;
	zoomInEffect?: boolean;
	zoomInFactor?: number;
	zoomInSpringConfig?: { stiffness?: number };
}

interface PanContext {
	initialMin: number;
	initialMax: number;
	domainWidth: number;
	screenToDataRatio: number;
	axis: 'x' | 'y';
	startScreenPos: number;
}

interface DomainAccessor {
	readonly current: Float64Array;
	readonly target: [number, number];
	set(newValue: [number, number], options?: { instant?: boolean }): void;
}

// =============================================================================
// LINEAR SCALE STATE CLASS
// =============================================================================
/**
 * LinearScaleState manages the animated domain of a linear scale.
 *
 * Uses SpringPair for physics simulation:
 * - springPair.a = domain minimum
 * - springPair.b = domain maximum
 *
 * Key features:
 * - Spring-based animation for smooth pan/zoom
 * - Shared across charts via ScaleRegistry
 * - GPU-ready state via gpuState object
 * - Domain limits and zoom constraints
 */
export class LinearScaleState {
	// --- Svelte Reactive State ---
	name: string = $state('');
	ready: boolean = $state(false);
	currentDataPoint: number | null = $state(null);

	// Reactivity trigger - bump when render state changes
	_version: number = $state(0);
	_targetVersion: number = $state(0); // Increments only when target changes, not every frame

	// --- Identity ---
	id: string;

	// --- Spring Physics ---
	#springPair: SpringPair;
	#springOutput: Float64Array = new Float64Array(2);

	//
	#domainCurrentBuffer: Float64Array = new Float64Array(2);
	#clampResult = { min: 0, max: 0 };

	// --- Cached Render Values (updated via updateRenderState) ---
	#renderMin: number = 0;
	#renderMax: number = 1;

	// --- Initial/Base Extent ---
	#initExtent: Float64Array = new Float64Array(2);
	#extent: Float64Array = new Float64Array(2);

	// --- D3 Scale (reused to avoid allocation) ---
	#sharedScale: ScaleLinear<number, number> = scaleLinear();
	#customFormat: string | ((value: number) => string) | null = $state(null);

	// --- GPU State (mutated in place for zero-alloc) ---
	gpuState = {
		domainMin: 0,
		domainMax: 1,
		domainScale: 1,
		categoryCount: 0
	};

	// --- Constraints ---
	domainLimits = { min: -Infinity, max: Infinity, minWidth: 1e-10 };
	zoomLimits = { max: 10, min: 100 }; // max = pan multiplier, min = zoom divisor
	disableZoom: boolean = false; // When true, user zoom/pan is ignored (for auto-scaling axes)

	// --- Mark Extent Tracking ---
	#extents: Map<string, [number, number]> = new Map();
	#enableUpdates: boolean = $state(true);
	#frozenExtent: [number, number] | null = null;

	// --- Animation State ---
	#isAnimating: boolean = false;
	#gpuCoordinator: GPUCoordinator | null = null;

	// --- Pan Context ---
	#panContext: PanContext | null = null;

	// --- Zoom Accumulator (for coalesced wheel events) ---
	#zoomAccumulator = {
		logScale: 0,
		center: 0,
		hasUpdates: false
	};

	// --- Zoom-In Effect Config ---
	zoomInEffect = {
		enabled: true,
		factor: 5,
		stiffness: SCALE_SPRING_PRESETS.zoomIn
	};

	// --- Affected Charts Cache (set by GPUCoordinator) ---
	_affectedChartsArray: string[] = [];

	// --- Domain Accessor ---
	domain!: DomainAccessor;

	constructor(
		name: string,
		extent: [number, number] = [0, 100],
		type: string = 'linear',
		zoomLimits: [number, number] = [10, 100],
		options: LinearScaleOptions = {},
		gpuCoordinator: GPUCoordinator | null = null
	) {
		this.id = crypto.randomUUID();
		this.name = name;
		this.#gpuCoordinator = gpuCoordinator;

		// Apply options
		if (options.disableZoom !== undefined) {
			this.disableZoom = options.disableZoom;
		}

		// Store initial extent
		this.#initExtent[0] = extent[0];
		this.#initExtent[1] = extent[1];
		this.#extent[0] = extent[0];
		this.#extent[1] = extent[1];

		// Initialize spring pair with default stiffness
		this.#springPair = new SpringPair(
			extent[0],
			extent[1],
			SCALE_SPRING_PRESETS.default,
			1e-6 // precision for isAtRest
		);

		// Sync render state
		this.#renderMin = extent[0];
		this.#renderMax = extent[1];
		this.#updateGpuState();

		// Store zoom limits
		this.zoomLimits.max = zoomLimits[0];
		this.zoomLimits.min = zoomLimits[1];

		// Zoom-in effect options
		if (options.zoomInEffect !== undefined) {
			this.zoomInEffect.enabled = options.zoomInEffect;
		}
		if (options.zoomInFactor !== undefined) {
			this.zoomInEffect.factor = options.zoomInFactor;
		}
		if (options.zoomInSpringConfig !== undefined) {
			this.zoomInEffect.stiffness =
				options.zoomInSpringConfig.stiffness || SCALE_SPRING_PRESETS.zoomIn;
		}

		// Create domain accessor object
		this.domain = this.#createDomainAccessor();
	}

	// ===========================================================================
	// DOMAIN ACCESSOR
	// ===========================================================================

	#createDomainAccessor(): DomainAccessor {
		const self = this;
		return {
			/** Current render domain (for reactive access) */
			get current() {
				self._version; // Register Svelte dependency
				self.#domainCurrentBuffer[0] = self.#renderMin;
				self.#domainCurrentBuffer[1] = self.#renderMax;
				return self.#domainCurrentBuffer;
			},

			/** Target domain (what we're animating toward) */
			get target(): [number, number] {
				self._targetVersion; // Register Svelte dependency (only changes on user input)
				return [self.#springPair.targetA, self.#springPair.targetB];
			},

			/** Set domain with optional instant mode */
			set(newValue: [number, number], options: { instant?: boolean } = {}) {
				if (options.instant) {
					self.#setInstant(newValue[0], newValue[1]);
				} else {
					self.#setTarget(newValue[0], newValue[1]);
				}
			}
		};
	}

	// ===========================================================================
	// PHYSICS INTERFACE (called by GPUCoordinator/AnimationLoop)
	// ===========================================================================

	/**
	 * Process accumulated input before physics step.
	 * Called by GPUCoordinator at the start of each frame.
	 */
	_applyInput(): void {
		// Process accumulated zoom
		if (this.#zoomAccumulator.hasUpdates) {
			const scaleFactor = Math.exp(this.#zoomAccumulator.logScale);
			this.#applyZoomToTarget(this.#zoomAccumulator.center, scaleFactor);

			// Reset accumulator
			this.#zoomAccumulator.logScale = 0;
			this.#zoomAccumulator.hasUpdates = false;
		}
	}

	/**
	 * Advance physics by one fixed timestep.
	 * Called by AnimationLoop at fixed rate (360Hz).
	 */
	step(): void {
		this.#springPair.step();
	}

	/**
	 * Update render state with extrapolation.
	 * Called once per frame by AnimationLoop.
	 */
	updateRenderState(extrapolationDt: number): void {
		// const rendered = this.#springPair.getRenderable(extrapolationDt);
		this.#springPair.getRenderableInto(extrapolationDt, this.#springOutput);
		this.#renderMin = this.#springOutput[0];
		this.#renderMax = this.#springOutput[1];
		// this.#renderMin = rendered.a;
		// this.#renderMax = rendered.b;
		this.#updateGpuState();

		// Trigger Svelte reactivity
		this._version++;
	}

	/**
	 * Check if spring is at rest.
	 * Used by AnimationLoop to determine when to stop.
	 */
	isAtRest(): boolean {
		return this.#springPair.isAtRest();
	}

	/**
	 * Called by GPUCoordinator when this scale stops animating.
	 */
	_markAtRest(): void {
		this.#isAnimating = false;
	}

	// ===========================================================================
	// INPUT METHODS
	// ===========================================================================

	/**
	 * Start a pan interaction.
	 */
	setPanContext(context: {
		screenToDataRatio: number;
		axis: 'x' | 'y';
		initialScreenPos: number;
	}): void {
		if (this.disableZoom) return; // Ignore pan for auto-scaling axes

		this.#panContext = {
			initialMin: this.#springPair.currentA,
			initialMax: this.#springPair.currentB,
			domainWidth: this.#springPair.currentB - this.#springPair.currentA,
			screenToDataRatio: context.screenToDataRatio,
			axis: context.axis,
			startScreenPos: context.initialScreenPos
		};

		this.#setStiffness(SCALE_SPRING_PRESETS.pan);
		this.#ensureAnimating();
	}

	/**
	 * Update pan position.
	 */
	updatePanPosition(screenX: number, screenY: number): void {
		if (!this.#panContext) return;

		const ctx = this.#panContext;
		let dataDelta = 0;

		if (ctx.axis === 'x') {
			const screenDelta = screenX - ctx.startScreenPos;
			dataDelta = -(screenDelta * ctx.screenToDataRatio);
		} else {
			const screenDelta = screenY - ctx.startScreenPos;
			dataDelta = screenDelta * ctx.screenToDataRatio;
		}

		let newMin = ctx.initialMin + dataDelta;
		let newMax = newMin + ctx.domainWidth;

		// Clamp to domain limits
		const clamped = this.#clampDomain(newMin, newMax);
		this.#setTarget(clamped.min, clamped.max);
	}

	/**
	 * End pan interaction.
	 */
	endPan(): void {
		this.#panContext = null;
		this.#setStiffness(SCALE_SPRING_PRESETS.default);
	}

	/**
	 * Accumulate zoom input (for coalesced wheel events).
	 */
	accumulateZoom(dataCenter: number, scaleFactor: number): void {
		if (this.disableZoom) return; // Ignore zoom for auto-scaling axes

		this.#zoomAccumulator.logScale += Math.log(scaleFactor);
		this.#zoomAccumulator.center = dataCenter;
		this.#zoomAccumulator.hasUpdates = true;
		this.#setStiffness(SCALE_SPRING_PRESETS.zoom);
		this.#ensureAnimating();
	}

	/**
	 * Reset zoom to show full extent.
	 */
	resetZoom(instant: boolean = false): void {
		const [min, max] = this.effectiveExtent;
		if (!isFinite(min) || !isFinite(max) || min === max) return;

		if (instant) {
			// Instant update - skip animation entirely
			this.#setInstant(min, max);
		} else if (!this.ready && this.zoomInEffect.enabled) {
			// First time - do zoom-in effect from expanded view
			this.#setStiffness(this.zoomInEffect.stiffness);

			const center = (min + max) / 2;
			const range = max - min;
			const factor = this.zoomInEffect.factor;
			const expandedMin = center - (range * factor) / 2;
			const expandedMax = center + (range * factor) / 2;

			// Set current position to expanded, target to actual
			this.#springPair.set(expandedMin, expandedMax);
			this.#setTarget(min, max);

			// Initialize render values so first frame renders correctly
			this.#renderMin = expandedMin;
			this.#renderMax = expandedMax;
			this.#updateGpuState();

			this.#ensureAnimating();
		} else {
			// Normal reset
			this.#setStiffness(SCALE_SPRING_PRESETS.reset);
			this.#setTarget(min, max);
		}
	}

	// ===========================================================================
	// D3 SCALE INTERFACE
	// ===========================================================================

	/**
	 * Get a D3 scale configured for the given axis and size.
	 * Reuses internal scale object to avoid allocation.
	 */
	getBaseScale(axis: string, size: number): ScaleLinear<number, number> {
		if (axis === 'x') {
			this.#sharedScale.range([0, size]);
		} else {
			this.#sharedScale.range([size, 0]);
		}
		return this.#sharedScale;
	}

	/**
	 * Generate tick values for grid lines and axes.
	 * Uses current animated domain (renderMin/renderMax) for smooth updates.
	 */
	getTicks(count: number = 5): number[] {
		this._version; // Register Svelte dependency for reactivity
		this.#sharedScale.domain([this.#renderMin, this.#renderMax]);
		return this.#sharedScale.ticks(count);
	}

	/**
	 * Set a custom format for tick labels, margin labels, and tooltips.
	 * String specifiers (e.g., "+%", ".2f") get dynamic precision from D3's scale.
	 * Functions are used as-is with fixed behavior.
	 */
	setCustomFormat(format: string | ((value: number) => string) | null): void {
		this.#customFormat = format ?? null;
	}

	/**
	 * Get a formatter function for tick values.
	 * String specifiers are passed to D3's scale.tickFormat(count, specifier)
	 * which adapts precision to the current zoom level / tick step.
	 */
	tickFormat(count: number = 5): (value: number) => string {
		this._version; // Register Svelte dependency for reactivity
		this.#sharedScale.domain([this.#renderMin, this.#renderMax]);
		if (typeof this.#customFormat === 'function') return this.#customFormat;
		return this.#sharedScale.tickFormat(count, this.#customFormat ?? undefined) as (
			value: number
		) => string;
	}

	/**
	 * Format a single value according to the scale's formatter.
	 * Useful for tooltips, labels, etc.
	 */
	formatValue(value: number): string {
		return this.tickFormat()(value);
	}

	/**
	 * Update a D3 scale's domain with current render values.
	 * Registers Svelte dependency via _version.
	 */
	updateScaleDomain(scale: ScaleLinear<number, number>): ScaleLinear<number, number> {
		this._version; // Register dependency
		scale.domain([this.#renderMin, this.#renderMax]);
		return scale;
	}

	/**
	 * Reactive getter for domain (triggers Svelte updates).
	 */
	get domainForReactivity(): [number, number] {
		this._version;
		return [this.#renderMin, this.#renderMax];
	}

	// ===========================================================================
	// COORDINATE TRANSFORMS
	// ===========================================================================

	/**
	 * Convert data value to screen position.
	 */
	scaleDataToScreen(dataVal: number, rangeSize: number, isYAxis: boolean = false): number {
		const min = this.#renderMin;
		const max = this.#renderMax;
		const domainSpan = max - min;

		if (domainSpan === 0) return 0;

		const t = (dataVal - min) / domainSpan;

		if (isYAxis) {
			return rangeSize - t * rangeSize;
		} else {
			return t * rangeSize;
		}
	}

	/**
	 * Convert screen position to data value.
	 */
	invertScreenToData(screenVal: number, rangeSize: number, isYAxis: boolean = false): number {
		const min = this.#renderMin;
		const max = this.#renderMax;

		if (rangeSize === 0) return min;

		const t = screenVal / rangeSize;

		if (isYAxis) {
			return max - t * (max - min);
		} else {
			return min + t * (max - min);
		}
	}

	// ===========================================================================
	// EXTENT MANAGEMENT
	// ===========================================================================

	/**
	 * Register a mark's data extent with this scale.
	 */
	addMark(range: number[], identifier: string, options: { instant?: boolean } = {}): this {
		let processedRange: [number, number];

		if (range.length === 2) {
			processedRange = [Math.min(range[0], range[1]), Math.max(range[0], range[1])];
		} else if (range.length > 2) {
			processedRange = d3Extent(range) as [number, number];
		} else if (range.length === 1) {
			processedRange = [range[0], range[0]];
		} else {
			return this;
		}

		this.#extents.set(identifier, processedRange);

		if (this.#enableUpdates) {
			this.updateExtentFromExtents(true, options.instant);
		}

		return this;
	}

	/**
	 * Remove a mark's extent from this scale.
	 */
	removeMark(identifier: string): this {
		if (this.#extents.has(identifier)) {
			this.#extents.delete(identifier);

			if (this.#enableUpdates) {
				this.updateExtentFromExtents();
			}
		}
		return this;
	}

	/**
	 * Recompute extent from all registered marks.
	 */
	updateExtentFromExtents(nice: boolean = true, instant: boolean = false): void {
		if (!this.#enableUpdates || this.#extents.size === 0) return;

		const extents = Array.from(this.#extents.values());
		const minStart = Math.min(...extents.map((r) => r[0]));
		const maxEnd = Math.max(...extents.map((r) => r[1]));

		if (nice) {
			const niceDomain = scaleLinear().domain([minStart, maxEnd]).nice(5).domain();
			this.#extent[0] = niceDomain[0];
			this.#extent[1] = niceDomain[1];
		} else {
			this.#extent[0] = minStart;
			this.#extent[1] = maxEnd;
		}

		this.resetDomainLimits();
		this.resetZoom(instant);
	}

	/**
	 * Get the effective extent (respects frozen state).
	 */
	get effectiveExtent(): [number, number] {
		return this.#enableUpdates
			? [this.#extent[0], this.#extent[1]]
			: this.#frozenExtent || [this.#extent[0], this.#extent[1]];
	}

	/**
	 * Reset domain limits based on current extent and zoom limits.
	 */
	resetDomainLimits(): void {
		const [min, max] = this.effectiveExtent;
		const w = max - min;
		this.domainLimits.min = min - this.zoomLimits.max * w;
		this.domainLimits.max = max + this.zoomLimits.max * w;
		this.domainLimits.minWidth = w / this.zoomLimits.min;
	}

	/**
	 * Set the zoom depth limit (how many times user can zoom into the data extent).
	 */
	setZoomLimit(zoomDivisor: number): void {
		this.zoomLimits.min = zoomDivisor;
		if (this.#extents.size > 0) {
			this.resetDomainLimits();
		}
	}

	/**
	 * Set the pan boundary limit (how far past data edges user can pan).
	 */
	setPanLimit(panMultiplier: number): void {
		this.zoomLimits.max = panMultiplier;
		if (this.#extents.size > 0) {
			this.resetDomainLimits();
		}
	}

	/**
	 * Check if scale has a valid domain from marks.
	 * Returns true if at least one mark has contributed extent data.
	 */
	get hasDomain(): boolean {
		return this.#extents.size > 0;
	}

	/**
	 * Mark scale as ready (after initial data load).
	 */
	setReady(): void {
		this.ready = true;
	}

	// ===========================================================================
	// PRIVATE METHODS
	// ===========================================================================

	#setTarget(min: number, max: number): void {
		this.#springPair.setTarget(min, max);
		this._targetVersion++; // Trigger reactivity for target watchers
		this.#ensureAnimating();
	}

	#setInstant(min: number, max: number): void {
		this.#springPair.set(min, max);
		this.#renderMin = min;
		this.#renderMax = max;
		this.#updateGpuState();
		this._version++;
		this._targetVersion++; // Trigger reactivity for target watchers
	}

	#setStiffness(stiffness: number): void {
		this.#springPair.configure(stiffness);
	}

	#updateGpuState(): void {
		const min = this.#renderMin;
		const max = this.#renderMax;
		const range = max - min;

		this.gpuState.domainMin = min;
		this.gpuState.domainMax = max;
		this.gpuState.domainScale = range === 0 ? 0 : 1 / range;
	}

	#ensureAnimating(): void {
		if (!this.#isAnimating && this.#gpuCoordinator) {
			this.#isAnimating = true;
			this.#gpuCoordinator.addAnimatingScale(this);
		}
	}

	#applyZoomToTarget(center: number, scaleFactor: number): void {
		const min = this.#springPair.targetA;
		const max = this.#springPair.targetB;
		const curWidth = max - min;
		const newWidth = curWidth / scaleFactor;

		// Clamp to minimum width
		const safeWidth = Math.max(newWidth, this.domainLimits.minWidth);

		// Maintain zoom center position
		const ratio = (center - min) / curWidth;
		let newMin = center - ratio * safeWidth;
		let newMax = newMin + safeWidth;

		// Clamp to domain limits
		const clamped = this.#clampDomain(newMin, newMax);
		this.#setTarget(clamped.min, clamped.max);
	}

	#clampDomain(min: number, max: number): { min: number; max: number } {
		const limits = this.domainLimits;
		const width = max - min;
		const limitWidth = limits.max - limits.min;

		if (width > limitWidth) {
			this.#clampResult.min = limits.min;
			this.#clampResult.max = limits.max;
			return this.#clampResult;
		}

		if (min < limits.min) {
			min = limits.min;
			max = min + width;
		}
		if (max > limits.max) {
			max = limits.max;
			min = max - width;
			if (min < limits.min) {
				min = limits.min;
			}
		}

		this.#clampResult.min = min;
		this.#clampResult.max = max;
		return this.#clampResult;
	}

	// ===========================================================================
	// PROTECTED METHODS (for subclass access)
	// ===========================================================================

	/**
	 * Set the extent values directly. Used by TimeScaleState for time-aware nice rounding.
	 */
	_setExtent(min: number, max: number): void {
		this.#extent[0] = min;
		this.#extent[1] = max;
	}

	// ===========================================================================
	// CLEANUP
	// ===========================================================================

	destroy(): void {
		this.#isAnimating = false;
		if (this.#gpuCoordinator?.removeAnimatingScale) {
			this.#gpuCoordinator.removeAnimatingScale(this);
		}
	}
}
