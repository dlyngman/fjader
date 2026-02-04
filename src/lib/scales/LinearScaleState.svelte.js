// =============================================================================
// LinearScaleState.svelte.js - Refactored with SpringPair physics
// =============================================================================

import { scaleLinear } from 'd3-scale';
import { extent as d3Extent } from 'd3-array';
import { SpringPair, SPRING_PRESETS } from '$lib/animation';

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
	name = $state('');
	ready = $state(false);
	currentDataPoint = $state(null);

	// Reactivity trigger - bump when render state changes
	_version = $state(0);
	_targetVersion = $state(0); // Increments only when target changes, not every frame

	// --- Identity ---
	id;

	// --- Spring Physics ---
	#springPair;
	#springOutput = new Float64Array(2);

	//
	#domainCurrentBuffer = new Float64Array(2);
	#clampResult = { min: 0, max: 0 };

	// --- Cached Render Values (updated via updateRenderState) ---
	#renderMin = 0;
	#renderMax = 1;

	// --- Initial/Base Extent ---
	#initExtent = new Float64Array(2);
	#extent = new Float64Array(2);

	// --- D3 Scale (reused to avoid allocation) ---
	#sharedScale = scaleLinear();

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
	disableZoom = false; // When true, user zoom/pan is ignored (for auto-scaling axes)

	// --- Mark Extent Tracking ---
	#extents = new Map();
	#enableUpdates = $state(true);
	#frozenExtent = null;

	// --- Animation State ---
	#isAnimating = false;
	#gpuCoordinator = null;

	// --- Pan Context ---
	#panContext = null;

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
	_affectedChartsArray = [];

	/**
	 * @param {string} name - Scale name (used for sharing)
	 * @param {[number, number]} extent - Initial domain extent
	 * @param {string} type - Scale type (currently only 'linear' supported here)
	 * @param {[number, number]} zoomLimits - [maxPanMultiplier, minZoomDivisor]
	 * @param {object} options - Additional options
	 * @param {object} gpuCoordinator - GPUCoordinator instance
	 */
	constructor(
		name,
		extent = [0, 100],
		type = 'linear',
		zoomLimits = [10, 100],
		options = {},
		gpuCoordinator = null
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

	#createDomainAccessor() {
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
			get target() {
				self._targetVersion; // Register Svelte dependency (only changes on user input)
				return [self.#springPair.targetA, self.#springPair.targetB];
			},

			/** Set domain with optional instant mode */
			set(newValue, options = {}) {
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
	_applyInput() {
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
	step() {
		this.#springPair.step();
	}

	/**
	 * Update render state with extrapolation.
	 * Called once per frame by AnimationLoop.
	 *
	 * @param {number} extrapolationDt - Time to extrapolate in seconds
	 */
	updateRenderState(extrapolationDt) {
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
	isAtRest() {
		return this.#springPair.isAtRest();
	}

	/**
	 * Called by GPUCoordinator when this scale stops animating.
	 */
	_markAtRest() {
		this.#isAnimating = false;
	}

	// ===========================================================================
	// INPUT METHODS
	// ===========================================================================

	/**
	 * Start a pan interaction.
	 * @param {object} context - Pan context with initialDomain, screenToDataRatio, etc.
	 */
	setPanContext(context) {
		if (this.disableZoom) return; // Ignore pan for auto-scaling axes

		// console.log(`=== setPanContext for ${this.name} (${this.id}) ===`);
		// console.log('axis:', context.axis);
		// console.log('#isAnimating before:', this.#isAnimating);
		// console.log('#gpuCoordinator exists:', !!this.#gpuCoordinator);
		this.#panContext = {
			initialMin: this.#springPair.currentA,
			initialMax: this.#springPair.currentB,
			domainWidth: this.#springPair.currentB - this.#springPair.currentA,
			screenToDataRatio: context.screenToDataRatio,
			axis: context.axis,
			startScreenPos: context.initialScreenPos
		};

		// Grab springs - snaps target to current, zeros velocity
		// this.#springPair.grab();
		this.#setStiffness(SCALE_SPRING_PRESETS.pan);
		this.#ensureAnimating();

		// console.log('#isAnimating after:', this.#isAnimating);
	}

	/**
	 * Update pan position.
	 * @param {number} screenX - Current screen X position
	 * @param {number} screenY - Current screen Y position
	 */
	updatePanPosition(screenX, screenY) {
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
	endPan() {
		this.#panContext = null;
		this.#setStiffness(SCALE_SPRING_PRESETS.default);
	}

	/**
	 * Accumulate zoom input (for coalesced wheel events).
	 * @param {number} dataCenter - Zoom center in data coordinates
	 * @param {number} scaleFactor - Zoom scale factor (>1 = zoom in)
	 */
	accumulateZoom(dataCenter, scaleFactor) {
		if (this.disableZoom) return; // Ignore zoom for auto-scaling axes

		this.#zoomAccumulator.logScale += Math.log(scaleFactor);
		this.#zoomAccumulator.center = dataCenter;
		this.#zoomAccumulator.hasUpdates = true;
		this.#setStiffness(SCALE_SPRING_PRESETS.zoom);
		this.#ensureAnimating();
	}

	/**
	 * Reset zoom to show full extent.
	 * @param {boolean} instant - Apply instantly without animation
	 */
	resetZoom(instant = false) {
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
	getBaseScale(axis, size) {
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
	 *
	 * @param {number} count - Approximate number of ticks desired
	 * @returns {Array<number>} Array of tick values
	 */
	getTicks(count = 5) {
		this._version; // Register Svelte dependency for reactivity
		this.#sharedScale.domain([this.#renderMin, this.#renderMax]);
		return this.#sharedScale.ticks(count);
	}

	/**
	 * Get a formatter function for tick values.
	 * Uses D3's smart number formatting (SI prefixes, precision handling).
	 *
	 * @param {number} count - Number of ticks (helps determine precision)
	 * @returns {Function} Formatter function (value) => string
	 */
	tickFormat(count = 5) {
		this._version; // Register Svelte dependency for reactivity
		this.#sharedScale.domain([this.#renderMin, this.#renderMax]);
		return this.#sharedScale.tickFormat(count);
	}

	/**
	 * Format a single value according to the scale's formatter.
	 * Useful for tooltips, labels, etc.
	 *
	 * @param {number} value - Value to format
	 * @returns {string} Formatted string
	 */
	formatValue(value) {
		return this.tickFormat()(value);
	}

	/**
	 * Update a D3 scale's domain with current render values.
	 * Registers Svelte dependency via _version.
	 */
	updateScaleDomain(scale) {
		this._version; // Register dependency
		scale.domain([this.#renderMin, this.#renderMax]);
		return scale;
	}

	/**
	 * Reactive getter for domain (triggers Svelte updates).
	 */
	get domainForReactivity() {
		this._version;
		return [this.#renderMin, this.#renderMax];
	}

	// ===========================================================================
	// COORDINATE TRANSFORMS
	// ===========================================================================

	/**
	 * Convert data value to screen position.
	 */
	scaleDataToScreen(dataVal, rangeSize, isYAxis = false) {
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
	invertScreenToData(screenVal, rangeSize, isYAxis = false) {
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
	 * @param {Array<number>} range - Data extent
	 * @param {string} identifier - Mark identifier
	 * @param {object} options - Options
	 * @param {boolean} options.instant - Apply domain instantly without spring animation
	 */
	addMark(range, identifier, options = {}) {
		let processedRange;

		if (range.length === 2) {
			processedRange = [Math.min(range[0], range[1]), Math.max(range[0], range[1])];
		} else if (range.length > 2) {
			processedRange = d3Extent(range);
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
	removeMark(identifier) {
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
	 * @param {boolean} nice - Apply nice rounding to domain
	 * @param {boolean} instant - Apply domain instantly without spring animation
	 */
	updateExtentFromExtents(nice = true, instant = false) {
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
	get effectiveExtent() {
		return this.#enableUpdates
			? [this.#extent[0], this.#extent[1]]
			: this.#frozenExtent || [this.#extent[0], this.#extent[1]];
	}

	/**
	 * Reset domain limits based on current extent and zoom limits.
	 */
	resetDomainLimits() {
		const [min, max] = this.effectiveExtent;
		const w = max - min;
		this.domainLimits.min = min - this.zoomLimits.max * w;
		this.domainLimits.max = max + this.zoomLimits.max * w;
		this.domainLimits.minWidth = w / this.zoomLimits.min;
	}

	/**
	 * Check if scale has a valid domain from marks.
	 * Returns true if at least one mark has contributed extent data.
	 */
	get hasDomain() {
		return this.#extents.size > 0;
	}

	/**
	 * Mark scale as ready (after initial data load).
	 */
	setReady() {
		this.ready = true;
	}

	// ===========================================================================
	// PRIVATE METHODS
	// ===========================================================================

	#setTarget(min, max) {
		this.#springPair.setTarget(min, max);
		this._targetVersion++; // Trigger reactivity for target watchers
		this.#ensureAnimating();
	}

	#setInstant(min, max) {
		this.#springPair.set(min, max);
		this.#renderMin = min;
		this.#renderMax = max;
		this.#updateGpuState();
		this._version++;
		this._targetVersion++; // Trigger reactivity for target watchers
	}

	#setStiffness(stiffness) {
		this.#springPair.configure(stiffness);
	}

	#updateGpuState() {
		const min = this.#renderMin;
		const max = this.#renderMax;
		const range = max - min;

		this.gpuState.domainMin = min;
		this.gpuState.domainMax = max;
		this.gpuState.domainScale = range === 0 ? 0 : 1 / range;
	}

	#ensureAnimating() {
		if (!this.#isAnimating && this.#gpuCoordinator) {
			this.#isAnimating = true;
			this.#gpuCoordinator.addAnimatingScale(this);
		}
	}

	#applyZoomToTarget(center, scaleFactor) {
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

	#clampDomain(min, max) {
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
	 * @param {number} min
	 * @param {number} max
	 */
	_setExtent(min, max) {
		this.#extent[0] = min;
		this.#extent[1] = max;
	}

	// ===========================================================================
	// CLEANUP
	// ===========================================================================

	destroy() {
		this.#isAnimating = false;
		if (this.#gpuCoordinator?.removeAnimatingScale) {
			this.#gpuCoordinator.removeAnimatingScale(this);
		}
	}
}
