import { scaleLinear } from 'd3-scale';
import { extent as d3Extent } from 'd3-array';

const SPRING_CONFIGS = {
	default: { stiffness: 225, damping: 25, precision: 1e-4 },
	zoom: { stiffness: 225, damping: 25, precision: 1e-8 },
	pan: { stiffness: 400, damping: 45, precision: 1e-8 },
	reset: { stiffness: 50, damping: 15, precision: 1e-4 },
	zoomIn: { stiffness: 75, damping: 15, precision: 1e-4 }
};

export class LinearScaleState {
	name = $state('');
	ready = $state(false);

	currentDataPoint = $state(null);

	// --- 1. THE REACTIVITY FIX ---
	// Svelte 5 doesn't observe TypedArray mutations. We manually bump this version
	// whenever we update the render state so deriveds know to re-run.
	_version = $state(0);

	// --- MEMORY LAYOUT (Zero GC) ---
	#initExtent = new Float64Array(2);
	#extent = new Float64Array(2);

	#target = new Float64Array(2);
	#rawTarget = new Float64Array(2);
	#smoothedTarget = new Float64Array(2);

	#physicsCurrent = new Float64Array(2);
	#physicsPrevious = new Float64Array(2);
	#velocity = new Float64Array(2);

	#renderCurrent = new Float64Array(2);

	// Reused D3 Object
	#sharedScale = scaleLinear();

	// Public GPU State
	gpuState = {
		domainMin: 0,
		domainMax: 1,
		domainScale: 1,
		categoryCount: 0
	};

	domainLimits = { min: 0, max: 100, minWidth: 1 };
	zoomLimits = { max: 10, min: 100 };

	#extents = new Map();
	#enableUpdates = $state(true);
	#frozenExtent = null;
	#isAnimating = false;
	#gpuCoordinator = null;
	#currentSpringConfig = SPRING_CONFIGS.default;

	#activePanContext = null;

	#zoomLogAccumulator = 0;
	#zoomCenterAccumulator = 0;
	#hasZoomUpdates = false;

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

		this.#initExtent.set(extent);
		this.#extent.set(extent);

		this.#target.set(extent);
		this.#rawTarget.set(extent);
		this.#smoothedTarget.set(extent);
		this.#physicsCurrent.set(extent);
		this.#renderCurrent.set(extent);

		this.zoomLimits.max = zoomLimits[0];
		this.zoomLimits.min = zoomLimits[1];
		this.#gpuCoordinator = gpuCoordinator;

		// if (gpuCoordinator) {
		// 	gpuCoordinator.registerScale(this.id, 'linear');
		// }

		// Force initial GPU update
		this._setRenderState();

		const self = this;
		this.domain = {
			get current() {
				// Signal dependency if accessed reactively
				self._version;
				return self.#renderCurrent;
			},
			get target() {
				return self.#target;
			},
			set(newValue, options = {}) {
				if (options.instant) {
					self.#setAllStates(newValue[0], newValue[1]);
				} else {
					self.#target[0] = newValue[0];
					self.#target[1] = newValue[1];
					self.#ensureAnimating();
				}
			}
		};

		this.zoomInEffect = {
			enabled: options.zoomInEffect ?? true,
			factor: options.zoomInFactor ?? 5,
			springConfig: options.zoomInSpringConfig ?? SPRING_CONFIGS.zoomIn
		};
	}

	#setAllStates(min, max) {
		this.#target[0] = min;
		this.#target[1] = max;
		this.#rawTarget[0] = min;
		this.#rawTarget[1] = max;
		this.#smoothedTarget[0] = min;
		this.#smoothedTarget[1] = max;
		this.#physicsCurrent[0] = min;
		this.#physicsCurrent[1] = max;
		this.#physicsPrevious[0] = min;
		this.#physicsPrevious[1] = max;
		this.#renderCurrent[0] = min;
		this.#renderCurrent[1] = max;
		this.#velocity[0] = 0;
		this.#velocity[1] = 0;
		this._setRenderState();
	}

	setReady() {
		this.ready = true;
	}

	getBaseScale(axis, size) {
		if (axis === 'x') this.#sharedScale.range([0, size]);
		else this.#sharedScale.range([size, 0]);
		return this.#sharedScale;
	}

	get domainForReactivity() {
		this._version; // Register dependency
		return this.#renderCurrent;
	}

	updateScaleDomain(scale) {
		// We do NOT read _version here anymore to avoid double-registration
		// if called from the getter below.
		scale.domain(this.#renderCurrent);
		return scale;
	}

	// // --- CRITICAL FIX: REACTIVITY HOOK ---
	// updateScaleDomain(scale, current = true) {
	// 	// 1. Register Dependency: Access _version so Svelte knows to re-run this
	// 	//    whenever _setRenderState increments it.
	// 	this._version;

	// 	// 2. Update the reusable scale in-place
	// 	const source = current ? this.#renderCurrent : this.#target;
	// 	scale.domain(source);

	// 	// 3. Return a NEW wrapper object.
	// 	//    Svelte's strict equality check needs a new object reference to know
	// 	//    the result of the derived calculation has changed.
	// 	return { scale: scale };
	// }

	scaleDataToScreen(dataVal, rangeSize, isYAxis = false) {
		const min = this.#renderCurrent[0];
		const max = this.#renderCurrent[1];
		const domainSpan = max - min;

		// Avoid divide by zero
		if (domainSpan === 0) return 0;

		// Normalized 0..1
		const t = (dataVal - min) / domainSpan;

		if (isYAxis) {
			// Y axis: 0 is max (top), size is min (bottom)
			// y = size - t * size
			return rangeSize - t * rangeSize;
		} else {
			// X axis: 0 is min, size is max
			return t * rangeSize;
		}
	}

	invertScreenToData(screenVal, rangeSize, isYAxis = false) {
		const min = this.#renderCurrent[0];
		const max = this.#renderCurrent[1];

		if (rangeSize === 0) return min;

		const t = screenVal / rangeSize;

		if (isYAxis) {
			// Y axis: screen bottom (height) → data min, screen top (0) → data max
			return max - t * (max - min);
		} else {
			// X axis: screen left (0) → data min, screen right (width) → data max
			return min + t * (max - min);
		}
	}

	setPanContext(panContext) {
		this.#activePanContext = panContext;
		this.#smoothedTarget[0] = this.#physicsCurrent[0];
		this.#smoothedTarget[1] = this.#physicsCurrent[1];
		this.#rawTarget[0] = this.#physicsCurrent[0];
		this.#rawTarget[1] = this.#physicsCurrent[1];

		this.#updateSpringConfig(SPRING_CONFIGS.pan);
		this.#ensureAnimating();
	}

	endPan() {
		this.#activePanContext = null;
		this.#updateSpringConfig(SPRING_CONFIGS.default);
	}

	updatePanPosition(screenX, screenY) {
		if (!this.#activePanContext) return;

		const ctx = this.#activePanContext;
		let dataDelta = 0;

		if (ctx.axis === 'x') {
			const screenDelta = screenX - ctx.initialScreenPos;
			dataDelta = -(screenDelta * ctx.screenToDataRatio);
		} else {
			const screenDelta = screenY - ctx.initialScreenPos;
			dataDelta = screenDelta * ctx.screenToDataRatio;
		}

		let newMin = ctx.initialDomain[0] + dataDelta;
		let newMax = ctx.initialDomain[1] + dataDelta;

		const range = newMax - newMin;
		if (newMin < this.domainLimits.min) {
			newMin = this.domainLimits.min;
			newMax = newMin + range;
		} else if (newMax > this.domainLimits.max) {
			newMax = this.domainLimits.max;
			newMin = newMax - range;
			if (newMin < this.domainLimits.min) newMin = this.domainLimits.min;
		}

		this.#rawTarget[0] = newMin;
		this.#rawTarget[1] = newMax;

		this.#ensureAnimating();
	}

	accumulateZoom(dataCenter, scaleFactor) {
		this.#zoomLogAccumulator += Math.log(scaleFactor);
		this.#zoomCenterAccumulator = dataCenter;
		this.#hasZoomUpdates = true;
		this.#ensureAnimating();
	}

	#ensureAnimating() {
		if (!this.#isAnimating) {
			this.#isAnimating = true;
			console.log('🎬 Ensuring animation for scale', this.name, this.id, {
				hasGPUCoordinator: !!this.#gpuCoordinator
			});
			if (this.#gpuCoordinator) {
				this.#gpuCoordinator.addAnimatingScale(this);
			}
		}
	}

	#updateSpringConfig(config) {
		this.#currentSpringConfig = config;
	}

	_applyInput(deltaTime) {
		let inputApplied = false;

		if (this.#hasZoomUpdates) {
			this.#updateSpringConfig(SPRING_CONFIGS.zoom);

			const scaleFactor = Math.exp(this.#zoomLogAccumulator);
			this.#calculateZoomedDomain(this.#target, this.#zoomCenterAccumulator, scaleFactor);

			this.#rawTarget[0] = this.#target[0];
			this.#rawTarget[1] = this.#target[1];
			this.#smoothedTarget[0] = this.#target[0];
			this.#smoothedTarget[1] = this.#target[1];

			this.#zoomLogAccumulator = 0;
			this.#hasZoomUpdates = false;
			inputApplied = true;
		}

		if (this.#activePanContext) {
			const dt = deltaTime / 1000;
			const tau = 0.015;
			const alpha = 1 - Math.exp(-dt / tau);

			this.#smoothedTarget[0] += (this.#rawTarget[0] - this.#smoothedTarget[0]) * alpha;
			this.#smoothedTarget[1] += (this.#rawTarget[1] - this.#smoothedTarget[1]) * alpha;

			this.#target[0] = this.#smoothedTarget[0];
			this.#target[1] = this.#smoothedTarget[1];

			inputApplied = true;
		}

		if (inputApplied) this.#ensureAnimating();
	}

	_capturePhysicsStateForInterpolation() {
		this.#physicsPrevious[0] = this.#physicsCurrent[0];
		this.#physicsPrevious[1] = this.#physicsCurrent[1];
	}

	_updatePhysics(deltaTime) {
		// Convert ms to seconds
		const dt = deltaTime / 1000.0;

		// Config (Mass is assumed 1.0)
		const k = this.#currentSpringConfig.stiffness;
		const c = this.#currentSpringConfig.damping;
		const m = 1.0;

		// 1. Calculate Damping Ratio and Natural Frequency
		// omega_n = sqrt(k / m)
		const omega = Math.sqrt(k / m);
		// zeta = c / (2 * sqrt(m * k))
		const zeta = c / (2 * Math.sqrt(m * k));

		for (let i = 0; i < 2; i++) {
			const x0 = this.#physicsCurrent[i] - this.#target[i]; // Displacement from target
			const v0 = this.#velocity[i]; // Current velocity

			// 2. Analytical Solution (Critical, Over, or Under Damped)
			let newPos, newVel;

			if (zeta < 1) {
				// Under-damped (Oscillating) -> Most common for UI "rubber band"
				const omega_d = omega * Math.sqrt(1 - zeta * zeta);
				const exp = Math.exp(-zeta * omega * dt);

				const c1 = x0;
				const c2 = (v0 + zeta * omega * x0) / omega_d;

				const cos = Math.cos(omega_d * dt);
				const sin = Math.sin(omega_d * dt);

				const dist = exp * (c1 * cos + c2 * sin);

				newPos = this.#target[i] + dist;
				newVel = dist * (-zeta * omega) + exp * (c2 * omega_d * cos - c1 * omega_d * sin);
			} else if (zeta > 1) {
				// Over-damped (No oscillation, slow approach)
				// ... (Usually not needed for rubber band, but good for completeness)
				// Simplified implementation for UI usually falls back to Critical
				const omega_d = omega * Math.sqrt(zeta * zeta - 1);
				const exp = Math.exp(-zeta * omega * dt);
				// ... (Math is complex, usually Critical Damping is close enough)

				// Fallback to Euler for extreme Overdamped or just treat as Critical
				// For UI, we rarely want heavy overdamping.
				const accel = (this.#target[i] - this.#physicsCurrent[i]) * k - this.#velocity[i] * c;
				this.#velocity[i] += accel * dt;
				this.#physicsCurrent[i] += this.#velocity[i] * dt;
				continue;
			} else {
				// Critically Damped (Fastest settle without overshoot)
				const exp = Math.exp(-omega * dt);
				const dist = exp * (x0 + (v0 + omega * x0) * dt);

				newPos = this.#target[i] + dist;
				newVel = dist * -omega + exp * (v0 + omega * x0);
			}

			this.#physicsCurrent[i] = newPos;
			this.#velocity[i] = newVel;
		}

		if (this.#isAtTarget()) {
			this.#physicsCurrent[0] = this.#target[0];
			this.#physicsCurrent[1] = this.#target[1];
			this.#velocity[0] = 0;
			this.#velocity[1] = 0;
			this.#isAnimating = false;
			this.#gpuCoordinator.removeAnimatingScale(this);
		}
	}

	// _updatePhysics(deltaTime) {
	// 	const dt = deltaTime / 1000.0;
	// 	const stiffness = this.#currentSpringConfig.stiffness;
	// 	const damping = this.#currentSpringConfig.damping;

	// 	if (this.#activePanContext) {
	// 		const width = this.#activePanContext.domainWidth;

	// 		const dist = this.#target[0] - this.#physicsCurrent[0];
	// 		const accel = dist * stiffness - this.#velocity[0] * damping;

	// 		this.#velocity[0] += accel * dt;
	// 		this.#physicsCurrent[0] += this.#velocity[0] * dt;

	// 		this.#physicsCurrent[1] = this.#physicsCurrent[0] + width;
	// 		this.#velocity[1] = this.#velocity[0];
	// 	} else {
	// 		for (let i = 0; i < 2; i++) {
	// 			const dist = this.#target[i] - this.#physicsCurrent[i];
	// 			const accel = dist * stiffness - this.#velocity[i] * damping;

	// 			this.#velocity[i] += accel * dt;
	// 			this.#physicsCurrent[i] += this.#velocity[i] * dt;
	// 		}
	// 	}

	// 	if (this.#isAtTarget()) {
	// 		this.#physicsCurrent[0] = this.#target[0];
	// 		this.#physicsCurrent[1] = this.#target[1];
	// 		this.#velocity[0] = 0;
	// 		this.#velocity[1] = 0;
	// 		this.#isAnimating = false;
	// 		this.#gpuCoordinator.removeAnimatingScale(this);
	// 	}
	// }
	// _updatePhysics(deltaTime) {
	// 	const dt = deltaTime / 1000.0;
	// 	const stiffness = this.#currentSpringConfig.stiffness;
	// 	const damping = this.#currentSpringConfig.damping;

	// 	if (this.#activePanContext) {
	// 		const width = this.#activePanContext.domainWidth;

	// 		const dist = this.#target[0] - this.#physicsCurrent[0];
	// 		const accel = dist * stiffness - this.#velocity[0] * damping;

	// 		this.#velocity[0] += accel * dt;
	// 		this.#physicsCurrent[0] += this.#velocity[0] * dt;

	// 		this.#physicsCurrent[1] = this.#physicsCurrent[0] + width;
	// 		this.#velocity[1] = this.#velocity[0];
	// 	} else {
	// 		for (let i = 0; i < 2; i++) {
	// 			const dist = this.#target[i] - this.#physicsCurrent[i];
	// 			const accel = dist * stiffness - this.#velocity[i] * damping;

	// 			this.#velocity[i] += accel * dt;
	// 			this.#physicsCurrent[i] += this.#velocity[i] * dt;
	// 		}
	// 	}

	// 	if (this.#isAtTarget()) {
	// 		this.#physicsCurrent[0] = this.#target[0];
	// 		this.#physicsCurrent[1] = this.#target[1];
	// 		this.#velocity[0] = 0;
	// 		this.#velocity[1] = 0;
	// 		this.#isAnimating = false;
	// 		this.#gpuCoordinator.removeAnimatingScale(this);
	// 	}
	// }

	#isAtTarget() {
		const p = this.#currentSpringConfig.precision;
		return (
			Math.abs(this.#physicsCurrent[0] - this.#target[0]) < p &&
			Math.abs(this.#physicsCurrent[1] - this.#target[1]) < p &&
			Math.abs(this.#velocity[0]) < p &&
			Math.abs(this.#velocity[1]) < p
		);
	}

	_setRenderState() {
		this.#renderCurrent[0] = this.#physicsCurrent[0];
		this.#renderCurrent[1] = this.#physicsCurrent[1];

		const min = this.#renderCurrent[0];
		const max = this.#renderCurrent[1];
		const range = max - min;

		this.gpuState.domainMin = min;
		this.gpuState.domainMax = max;
		this.gpuState.domainScale = range === 0 ? 0 : 1 / range;

		// --- TRIGGER REACTIVITY ---
		// this._version += 1;
	}

	#calculateZoomedDomain(targetArr, center, scaleFactor) {
		const min = targetArr[0];
		const max = targetArr[1];
		const limits = this.domainLimits;

		const curWidth = max - min;
		const newWidth = curWidth / scaleFactor;
		const safeWidth = Math.max(newWidth, limits.minWidth);

		const ratio = (center - min) / curWidth;

		let newMin = center - ratio * safeWidth;
		let newMax = newMin + safeWidth;

		const limitW = limits.max - limits.min;

		if (safeWidth > limitW) {
			newMin = limits.min;
			newMax = limits.max;
		} else {
			if (newMin < limits.min) {
				newMin = limits.min;
				newMax = newMin + safeWidth;
			}
			if (newMax > limits.max) {
				newMax = limits.max;
				newMin = newMax - safeWidth;
			}
		}

		targetArr[0] = newMin;
		targetArr[1] = newMax;
	}

	resetZoom() {
		const [min, max] = this.effectiveExtent;
		if (!isFinite(min) || !isFinite(max) || min === max) return;

		this.#target[0] = min;
		this.#target[1] = max;

		if (!this.ready && this.zoomInEffect.enabled) {
			this.#updateSpringConfig(this.zoomInEffect.springConfig);
			const center = (min + max) / 2;
			const range = max - min;
			const factor = this.zoomInEffect.factor;
			const expMin = center - (range * factor) / 2;
			const expMax = center + (range * factor) / 2;

			this.#setAllStates(expMin, expMax);
		} else {
			this.#updateSpringConfig(SPRING_CONFIGS.reset);
			this.#ensureAnimating();
		}
	}

	resetDomainLimits() {
		const [min, max] = this.effectiveExtent;
		const w = max - min;
		this.domainLimits.min = min - this.zoomLimits.max * w;
		this.domainLimits.max = max + this.zoomLimits.max * w;
		this.domainLimits.minWidth = w / this.zoomLimits.min;
	}

	addMark(range, identifier) {
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
			this.updateExtentFromExtents();
		}

		console.log(`📊 Scale ${this.name}: addMark from ${identifier}`, {
			range,
			oldExtent: [...this.#extent],
			newExtent: [...this.#extent],
			updatesEnabled: this.#enableUpdates
		});

		return this;
	}

	removeMark(identifier) {
		if (this.#extents.has(identifier)) {
			this.#extents.delete(identifier);

			if (this.#enableUpdates) {
				this.updateExtentFromExtents();
			}
		}
		return this;
	}

	updateExtentFromExtents(nice = true) {
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
		this.resetZoom();
	}

	get effectiveExtent() {
		return this.#enableUpdates ? this.#extent : this.#frozenExtent || this.#extent;
	}

	destroy() {
		this.#isAnimating = false;
		// this.#gpuCoordinator.unregisterScale(this.id);
		if (this.#gpuCoordinator?.removeAnimatingScale) {
			this.#gpuCoordinator.removeAnimatingScale(this);
		}
	}
}
