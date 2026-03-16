// =============================================================================
// LinearScaleState.svelte.ts - Refactored with SpringPair physics
// =============================================================================

import { scaleLinear } from 'd3-scale';
import type { ScaleLinear, ScaleContinuousNumeric } from 'd3-scale';
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
	zoomIn: 200, // Initial zoom-in effect
	externalDomain: 600 // Brush-driven domain tracking (snappy, like pan)
};

// =============================================================================
// TYPES
// =============================================================================

export interface LinearScaleOptions {
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

export interface GpuScaleState {
	domainMin: number;
	domainMax: number;
	domainScale: number;
	p4: number; // scale-type-specific: symlog constant C, 0 for linear/log/time
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
	// --- Discriminant for union narrowing ---
	get scaleType(): 'linear' | 'time' | 'log' | 'symlog' {
		return 'linear';
	}

	/** Whether this scale supports interactive pan and zoom. */
	get supportsPanZoom(): boolean {
		return true;
	}

	// --- Scale type (for GPU registration) ---
	type: string = 'linear';

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
		p4: 0
	};

	// --- Constraints ---
	domainLimits = { min: -Infinity, max: Infinity, minWidth: 1e-10 };
	zoomLimits = { max: 10, min: 100 }; // max = pan multiplier, min = zoom divisor
	disableZoom: boolean = false; // When true, user zoom/pan is ignored (for auto-scaling axes)

	// --- Selection Extent (set by IntervalX brush, consumed by useXSelection) ---
	// Pre-allocated buffer to avoid per-update GC pressure during continuous brush drag.
	// #selectionActive gates whether the extent is valid (replaces null vs non-null).
	#selectionBuffer = new Float64Array(2);
	#selectionActive: boolean = $state(false);
	#selectionVersion: number = $state(0); // bumped on value change to trigger effects
	#selectionSource: 'brush' | 'external' | null = $state(null);

	// --- External Domain (suppresses data-driven resetZoom while active) ---
	#externalDomainActive = false;

	// --- User Input Tracking (for fitDomain suppression) ---
	// True when the last domain change was from direct user zoom/pan.
	// Set false by data-driven (addMark/resetZoom) or external (setExternalDomain) changes.
	#userDriven = $state(false);

	// --- fitDomain flag ---
	// When true, skip the disjoint-domain instant snap in resetZoom. fitDomain intentionally
	// produces large domain jumps (e.g., brush moves to a region with very different Y values)
	// that should still animate smoothly.
	#fitDomainActive = false;

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
		this.type = type;
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

		// Sync render state — inline linear math to avoid virtual transformForGpu()
		// call before subclass private fields are initialized (JS inheritance constraint)
		this.#renderMin = extent[0];
		this.#renderMax = extent[1];
		const initRange = extent[1] - extent[0];
		this.gpuState.domainMin = extent[0];
		this.gpuState.domainMax = extent[1];
		this.gpuState.domainScale = initRange === 0 ? 0 : 1 / initRange;
		this.gpuState.p4 = 0;

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
				return [
					self.fromSpringSpace(self.#springPair.targetA),
					self.fromSpringSpace(self.#springPair.targetB)
				];
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
	// SELECTION EXTENT (for overview+detail linked domains)
	// ===========================================================================

	/**
	 * Current selection extent (set by brush interactor).
	 * Returns the pre-allocated buffer (read-only by convention) or null.
	 * Callers must not mutate the returned array.
	 */
	get selectionExtent(): Float64Array | null {
		this.#selectionVersion; // register reactive dependency
		return this.#selectionActive ? this.#selectionBuffer : null;
	}

	/** Whether the last domain change was from direct user zoom/pan (vs data-driven or external). */
	get userDriven(): boolean {
		return this.#userDriven;
	}

	/** Mark this scale as a fitDomain target — skips disjoint-domain instant snap in resetZoom. */
	set fitDomainActive(value: boolean) {
		this.#fitDomainActive = value;
	}

	/** Whether the last selection change came from 'brush' or 'external' (detail pan/zoom). */
	get selectionSource(): 'brush' | 'external' | null {
		return this.#selectionSource;
	}

	/** Set the selection extent (called by IntervalX or detail chart pan/zoom). */
	setSelectionExtent(min: number, max: number, source: 'brush' | 'external' = 'brush'): void {
		// Skip if values unchanged — avoids spurious reactivity and downstream effect re-runs
		if (
			this.#selectionActive &&
			this.#selectionBuffer[0] === min &&
			this.#selectionBuffer[1] === max &&
			this.#selectionSource === source
		) {
			return;
		}
		this.#selectionBuffer[0] = min;
		this.#selectionBuffer[1] = max;
		this.#selectionActive = true;
		this.#selectionSource = source;
		this.#selectionVersion++;
	}

	/** Clear the selection extent (called when brush is cleared). */
	clearSelectionExtent(): void {
		if (!this.#selectionActive) return; // already clear
		this.#selectionActive = false;
		this.#selectionSource = null;
		this.#selectionVersion++;
	}

	// ===========================================================================
	// EXTERNAL DOMAIN (for useXSelection consumer scales)
	// ===========================================================================

	/** Set domain from external source (suppresses data-driven resetZoom). */
	setExternalDomain(min: number, max: number): void {
		this.#externalDomainActive = true;
		this.#userDriven = false;
		this.#setStiffness(SCALE_SPRING_PRESETS.externalDomain);
		this.domain.set([min, max]);
	}

	/** Clear external domain and animate back to data extent. */
	clearExternalDomain(): void {
		if (!this.#externalDomainActive) return; // Already inactive, no-op
		this.#externalDomainActive = false;
		this.resetZoom();
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
		this.#springPair.getRenderableInto(extrapolationDt, this.#springOutput);
		this.#renderMin = this.fromSpringSpace(this.#springOutput[0]);
		this.#renderMax = this.fromSpringSpace(this.#springOutput[1]);
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
		this.#userDriven = true;

		const panMin = this.fromSpringSpace(this.#springPair.currentA);
		const panMax = this.fromSpringSpace(this.#springPair.currentB);
		this.#panContext = {
			initialMin: panMin,
			initialMax: panMax,
			domainWidth: panMax - panMin,
			screenToDataRatio: context.screenToDataRatio,
			axis: context.axis,
			startScreenPos: context.initialScreenPos
		};

		this.#setStiffness(SCALE_SPRING_PRESETS.pan);
		this.#ensureAnimating();
	}

	/**
	 * Update pan position.
	 * Uses normalizeValue/denormalizeValue so pan is uniform in visual space
	 * for all scale types (linear, log, symlog).
	 */
	updatePanPosition(screenX: number, screenY: number): void {
		if (!this.#panContext) return;

		const ctx = this.#panContext;
		const screenDelta =
			ctx.axis === 'x' ? screenX - ctx.startScreenPos : screenY - ctx.startScreenPos;
		const sign = ctx.axis === 'x' ? -1 : 1;

		// Derive screen size from stored pan context
		const screenSize = ctx.domainWidth / ctx.screenToDataRatio;

		// Convert screen motion to visual-space fraction
		const normalizedDelta = (sign * screenDelta) / screenSize;

		// Shift in visual space and convert back to data space
		const newMin = this.denormalizeValue(normalizedDelta, ctx.initialMin, ctx.initialMax);
		const newMax = this.denormalizeValue(1 + normalizedDelta, ctx.initialMin, ctx.initialMax);

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
	 * @param visualCenter - Cursor position as a visual fraction [0,1] (0=left/bottom, 1=right/top)
	 */
	accumulateZoom(visualCenter: number, scaleFactor: number): void {
		if (this.disableZoom) return; // Ignore zoom for auto-scaling axes
		this.#userDriven = true;

		this.#zoomAccumulator.logScale += Math.log(scaleFactor);
		this.#zoomAccumulator.center = visualCenter;
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

		// Snap when the new extent is completely disjoint from the current domain.
		// This handles column reassignment (e.g., bill_length → body_mass) where
		// animating between unrelated domains looks like random motion.
		// Skip this when fitDomainActive — fitDomain intentionally produces large
		// domain jumps (brush moves to a region with very different values) that
		// should still animate smoothly.
		if (!instant && this.ready && !this.#fitDomainActive) {
			if (min > this.#renderMax || max < this.#renderMin) {
				instant = true;
			}
		}

		if (instant || (!this.ready && !this.zoomInEffect.enabled)) {
			// Instant update - skip animation entirely.
			// Also snaps when zoom-in is disabled on a not-yet-ready scale
			// (e.g., column reassignment — no point animating from default domain).
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
			this.#springPair.set(this.toSpringSpace(expandedMin), this.toSpringSpace(expandedMax));
			this.#setTarget(min, max); // #setTarget transforms internally

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
	getBaseScale(axis: string, size: number): ScaleContinuousNumeric<number, number> {
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
	updateScaleDomain(scale: { domain(d: [number, number]): unknown }): unknown {
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
		const t = this.normalizeValue(dataVal, this.#renderMin, this.#renderMax);
		return isYAxis ? rangeSize - t * rangeSize : t * rangeSize;
	}

	/**
	 * Convert screen position to data value.
	 */
	invertScreenToData(screenVal: number, rangeSize: number, isYAxis: boolean = false): number {
		if (rangeSize === 0) return this.#renderMin;
		const t = screenVal / rangeSize;
		const frac = isYAxis ? 1 - t : t;
		return this.denormalizeValue(frac, this.#renderMin, this.#renderMax);
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

		let newMin: number;
		let newMax: number;
		if (nice) {
			const niceDomain = scaleLinear().domain([minStart, maxEnd]).nice(5).domain();
			newMin = niceDomain[0];
			newMax = niceDomain[1];
		} else {
			newMin = minStart;
			newMax = maxEnd;
		}

		// Skip if extent hasn't changed (e.g. a shared scale losing a mark
		// whose extent was identical to the remaining marks)
		if (newMin === this.#extent[0] && newMax === this.#extent[1]) return;

		this.#extent[0] = newMin;
		this.#extent[1] = newMax;
		this.#userDriven = false;

		this.resetDomainLimits();
		if (!this.#externalDomainActive) {
			this.resetZoom(instant);
		}
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
		this.#springPair.setTarget(this.toSpringSpace(min), this.toSpringSpace(max));
		this._targetVersion++; // Trigger reactivity for target watchers
		this.#ensureAnimating();
	}

	#setInstant(min: number, max: number): void {
		this.#springPair.set(this.toSpringSpace(min), this.toSpringSpace(max));
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
		this.transformForGpu(this.#renderMin, this.#renderMax, this.gpuState);
	}

	#ensureAnimating(): void {
		if (!this.#isAnimating && this.#gpuCoordinator) {
			this.#isAnimating = true;
			this.#gpuCoordinator.addAnimatingScale(this);
		}
	}

	#applyZoomToTarget(tCenter: number, scaleFactor: number): void {
		const min = this.fromSpringSpace(this.#springPair.targetA);
		const max = this.fromSpringSpace(this.#springPair.targetB);

		// tCenter is already a visual [0,1] fraction from screen position —
		// no normalizeValue needed, so the cursor stays perfectly anchored
		// regardless of render-vs-target spring lag.
		const newVisualWidth = 1.0 / scaleFactor;

		// Zoom around tCenter: preserve its relative visual position
		const newTMin = tCenter - tCenter * newVisualWidth;
		const newTMax = newTMin + newVisualWidth;

		// Convert back to data space
		let newMin = this.denormalizeValue(newTMin, min, max);
		let newMax = this.denormalizeValue(newTMax, min, max);

		// Enforce minimum zoom level in visual space (works for all scale types)
		const ext = this.#enableUpdates ? this.#extent : (this.#frozenExtent ?? this.#extent);
		const extMin = ext[0];
		const extMax = ext[1];
		const minVisualWidth = 1.0 / this.zoomLimits.min;
		const visNewMin = this.normalizeValue(newMin, extMin, extMax);
		const visNewMax = this.normalizeValue(newMax, extMin, extMax);

		if (visNewMax - visNewMin < minVisualWidth) {
			const visMid = (visNewMin + visNewMax) / 2;
			newMin = this.denormalizeValue(visMid - minVisualWidth / 2, extMin, extMax);
			newMax = this.denormalizeValue(visMid + minVisualWidth / 2, extMin, extMax);
		}

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

	/**
	 * Reinitialize spring and GPU state after subclass private fields are ready.
	 * Subclasses must call this at the end of their constructor.
	 */
	protected _reinitScale(): void {
		// Re-set spring into transformed space using current render values
		this.#springPair.set(this.toSpringSpace(this.#renderMin), this.toSpringSpace(this.#renderMax));
		this.#springPair.setTarget(
			this.toSpringSpace(this.#renderMin),
			this.toSpringSpace(this.#renderMax)
		);
		this.#updateGpuState();
	}

	// ===========================================================================
	// TEMPLATE METHOD HOOKS (override in LogScaleState, SymlogScaleState)
	// ===========================================================================

	/**
	 * Write GPU SSBO parameters into the output object (zero-alloc).
	 * Override to pre-compute transformed domain values (e.g., log(domainMin)).
	 */
	protected transformForGpu(min: number, max: number, out: GpuScaleState): void {
		const range = max - min;
		out.domainMin = min;
		out.domainMax = max;
		out.domainScale = range === 0 ? 0 : 1 / range;
		out.p4 = 0;
	}

	/**
	 * Normalize a data value to visual [0,1] space within the given domain.
	 * Override for nonlinear mappings (log, symlog).
	 */
	protected normalizeValue(value: number, min: number, max: number): number {
		const range = max - min;
		return range === 0 ? 0 : (value - min) / range;
	}

	/**
	 * Convert a visual [0,1] fraction back to a data value within the given domain.
	 * Override for nonlinear mappings (log, symlog).
	 */
	protected denormalizeValue(t: number, min: number, max: number): number {
		return min + t * (max - min);
	}

	/**
	 * Transform a data value into the space the spring animates in.
	 * Linear: identity. Log: Math.log. Symlog: sign(x)*log1p(|x/C|).
	 * This ensures spring physics produce visually uniform motion.
	 */
	protected toSpringSpace(value: number): number {
		return value;
	}

	/**
	 * Inverse of toSpringSpace — convert spring value back to data space.
	 */
	protected fromSpringSpace(value: number): number {
		return value;
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
