// =============================================================================
// Spring.js - Optimized spring physics with fixed timestep and render extrapolation
// =============================================================================

// -----------------------------------------------------------------------------
// PHYSICS CONSTANTS
// -----------------------------------------------------------------------------
// Fixed timestep for deterministic physics simulation.
// 360Hz provides smooth results while being computationally efficient.
// Higher rates (480Hz, 960Hz) offer marginal improvement at higher CPU cost.
export const PHYSICS_HZ = 360;
export const DT = 1 / PHYSICS_HZ;           // Fixed timestep in seconds (~2.78ms)
export const DT_MS = DT * 1000;             // Fixed timestep in milliseconds

// -----------------------------------------------------------------------------
// SPRING PRESETS
// -----------------------------------------------------------------------------
// Stiffness values tuned for different interaction types.
// Higher stiffness = faster response, lower = more gradual
export const SPRING_PRESETS = {
	default: { stiffness: 400, precision: 1e-6 },
	pan: { stiffness: 600, precision: 1e-6 },
	zoom: { stiffness: 400, precision: 1e-6 },
	reset: { stiffness: 150, precision: 1e-4 },
	snap: { stiffness: 800, precision: 1e-6 }
};

// -----------------------------------------------------------------------------
// SPRING CLASS
// -----------------------------------------------------------------------------
/**
 * A critically-damped spring optimized for UI animations.
 *
 * Key features:
 * - Fixed timestep physics for deterministic behavior
 * - Precomputed exponential decay for hot-path performance
 * - Pure render extrapolation (no state mutation)
 * - Zero-allocation in animation loop
 *
 * Usage:
 * ```js
 * const spring = new Spring(0, SPRING_PRESETS.default.stiffness);
 *
 * // In physics loop (fixed timestep):
 * spring.step();
 *
 * // In render loop (variable timestep):
 * const renderValue = spring.getRenderable(remainingDt);
 * ```
 */
export class Spring {
	// Current physics state
	current = 0;
	target = 0;
	velocity = 0;

	// Precomputed constants (set via configure())
	#omega = 0;      // Natural frequency: sqrt(stiffness)
	#expDt = 0;      // Precomputed: exp(-omega * DT)
	#precision = 1e-6;

	/**
	 * @param {number} initial - Initial value
	 * @param {number} stiffness - Spring stiffness (default: 400)
	 * @param {number} precision - Rest detection threshold (default: 1e-6)
	 */
	constructor(initial = 0, stiffness = 400, precision = 1e-6) {
		this.current = initial;
		this.target = initial;
		this.#precision = precision;
		this.configure(stiffness);
	}

	/**
	 * Reconfigure spring stiffness. Call this when changing interaction modes.
	 * Precomputes derived values for hot-path performance.
	 *
	 * @param {number} stiffness - New stiffness value
	 */
	configure(stiffness) {
		this.#omega = Math.sqrt(stiffness);
		this.#expDt = Math.exp(-this.#omega * DT);
	}

	/**
	 * Advance physics by one fixed timestep.
	 * Uses analytical solution for critically-damped spring.
	 *
	 * This is the "authoritative" state update - call at fixed rate (e.g., 360Hz).
	 * Uses precomputed constants for maximum performance.
	 */
	step() {
		const omega = this.#omega;
		const expDt = this.#expDt;
		const d = this.current - this.target;
		const v = this.velocity;

		// Analytical solution for critically-damped spring:
		// x(t) = target + e^(-ωt) * (d + (v + ωd)t)
		// v(t) = e^(-ωt) * (v + ωd) - ω * x(t)
		const displacement = expDt * (d + (v + omega * d) * DT);
		this.current = this.target + displacement;
		this.velocity = displacement * -omega + expDt * (v + omega * d);
	}

	/**
	 * Get interpolated render value without mutating state.
	 * Call this once per frame with the remaining accumulator time.
	 *
	 * This provides smooth visuals even when physics rate differs from display rate.
	 *
	 * @param {number} dt - Time to extrapolate (in seconds), typically the accumulator remainder
	 * @returns {number} Extrapolated position for rendering
	 */
	getRenderable(dt) {
		const d = this.current - this.target;
		const v = this.velocity;

		// Early exit if at rest
		if (d === 0 && v === 0) return this.current;

		// Early exit if no extrapolation needed
		if (dt === 0) return this.current;

		// Same analytical solution, but for arbitrary dt (not precomputed)
		const omega = this.#omega;
		const exp = Math.exp(-omega * dt);
		return this.target + exp * (d + (v + omega * d) * dt);
	}

	/**
	 * "Grab" the spring - used when starting a drag interaction.
	 * Snaps target to current position and zeros velocity.
	 * This prevents the spring from fighting the user's input.
	 */
	grab() {
		this.target = this.current;
		this.velocity = 0;
	}

	/**
	 * Set target value. The spring will animate toward this value.
	 *
	 * @param {number} value - New target value
	 */
	setTarget(value) {
		this.target = value;
	}

	/**
	 * Instantly set both current and target to value, with zero velocity.
	 * Use for initialization or hard resets (no animation).
	 *
	 * @param {number} value - Value to set
	 */
	set(value) {
		this.current = value;
		this.target = value;
		this.velocity = 0;
	}

	/**
	 * Check if spring is at rest (close enough to target with negligible velocity).
	 * Used to determine when to stop animating.
	 *
	 * @param {number} [precision] - Optional override for precision threshold
	 * @returns {boolean} True if spring is at rest
	 */
	isAtRest(precision) {
		const p = precision ?? this.#precision;
		return Math.abs(this.current - this.target) < p && Math.abs(this.velocity) < p;
	}

	/**
	 * Get current omega (natural frequency). Useful for debugging.
	 * @returns {number}
	 */
	get omega() {
		return this.#omega;
	}
}

// -----------------------------------------------------------------------------
// SPRING PAIR CLASS
// -----------------------------------------------------------------------------
/**
 * A pair of springs for 2D values (e.g., domain min/max, x/y position).
 * Provides convenience methods for common operations.
 */
export class SpringPair {
	#springA;
	#springB;

	/**
	 * @param {number} initialA - Initial value for first spring
	 * @param {number} initialB - Initial value for second spring
	 * @param {number} stiffness - Spring stiffness
	 * @param {number} precision - Rest detection threshold
	 */
	constructor(initialA = 0, initialB = 0, stiffness = 400, precision = 1e-6) {
		this.#springA = new Spring(initialA, stiffness, precision);
		this.#springB = new Spring(initialB, stiffness, precision);
	}

	/**
	 * Configure both springs with new stiffness.
	 * @param {number} stiffness
	 */
	configure(stiffness) {
		this.#springA.configure(stiffness);
		this.#springB.configure(stiffness);
	}

	/**
	 * Step both springs by one fixed timestep.
	 */
	step() {
		this.#springA.step();
		this.#springB.step();
	}

	/**
	 * Get extrapolated render values for both springs.
	 * @param {number} dt - Extrapolation time in seconds
	 * @returns {{a: number, b: number}}
	 */
	getRenderable(dt) {
		return {
			a: this.#springA.getRenderable(dt),
			b: this.#springB.getRenderable(dt)
		};
	}

	/**
	 * Get extrapolated render values into a provided array (zero-allocation).
	 * @param {number} dt - Extrapolation time in seconds
	 * @param {Float64Array|number[]} out - Output array [a, b]
	 */
	getRenderableInto(dt, out) {
		out[0] = this.#springA.getRenderable(dt);
		out[1] = this.#springB.getRenderable(dt);
	}

	/**
	 * Grab both springs (for starting drag).
	 */
	grab() {
		this.#springA.grab();
		this.#springB.grab();
	}

	/**
	 * Set targets for both springs.
	 * @param {number} a - Target for first spring
	 * @param {number} b - Target for second spring
	 */
	setTarget(a, b) {
		this.#springA.target = a;
		this.#springB.target = b;
	}

	/**
	 * Instantly set both springs (no animation).
	 * @param {number} a
	 * @param {number} b
	 */
	set(a, b) {
		this.#springA.set(a);
		this.#springB.set(b);
	}

	/**
	 * Check if both springs are at rest.
	 * @param {number} [precision]
	 * @returns {boolean}
	 */
	isAtRest(precision) {
		return this.#springA.isAtRest(precision) && this.#springB.isAtRest(precision);
	}

	// Direct access to individual springs
	get a() {
		return this.#springA;
	}
	get b() {
		return this.#springB;
	}

	// Convenience getters for current state
	get currentA() {
		return this.#springA.current;
	}
	get currentB() {
		return this.#springB.current;
	}
	get targetA() {
		return this.#springA.target;
	}
	get targetB() {
		return this.#springB.target;
	}
}