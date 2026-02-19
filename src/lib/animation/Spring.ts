// =============================================================================
// Spring.ts - Optimized spring physics with fixed timestep and render extrapolation
// =============================================================================

// -----------------------------------------------------------------------------
// PHYSICS CONSTANTS
// -----------------------------------------------------------------------------
// Fixed timestep for deterministic physics simulation.
// 360Hz provides smooth results while being computationally efficient.
// Higher rates (480Hz, 960Hz) offer marginal improvement at higher CPU cost.
export const PHYSICS_HZ = 360;
export const DT = 1 / PHYSICS_HZ; // Fixed timestep in seconds (~2.78ms)
export const DT_MS = DT * 1000; // Fixed timestep in milliseconds

// -----------------------------------------------------------------------------
// SPRING PRESETS
// -----------------------------------------------------------------------------
// Stiffness values tuned for different interaction types.
// Higher stiffness = faster response, lower = more gradual
export interface SpringPreset {
	stiffness: number;
	precision: number;
}

export const SPRING_PRESETS: Record<string, SpringPreset> = {
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
 */
export class Spring {
	current: number;
	target: number;
	velocity: number = 0;

	#omega: number = 0;
	#expDt: number = 0;
	#precision: number;

	constructor(initial: number = 0, stiffness: number = 400, precision: number = 1e-6) {
		this.current = initial;
		this.target = initial;
		this.#precision = precision;
		this.configure(stiffness);
	}

	configure(stiffness: number): void {
		this.#omega = Math.sqrt(stiffness);
		this.#expDt = Math.exp(-this.#omega * DT);
	}

	step(): void {
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

	getRenderable(dt: number): number {
		const d = this.current - this.target;
		const v = this.velocity;

		if (d === 0 && v === 0) return this.current;
		if (dt === 0) return this.current;

		const omega = this.#omega;
		const exp = Math.exp(-omega * dt);
		return this.target + exp * (d + (v + omega * d) * dt);
	}

	grab(): void {
		this.target = this.current;
		this.velocity = 0;
	}

	setTarget(value: number): void {
		this.target = value;
	}

	set(value: number): void {
		this.current = value;
		this.target = value;
		this.velocity = 0;
	}

	isAtRest(precision?: number): boolean {
		const p = precision ?? this.#precision;
		return Math.abs(this.current - this.target) < p && Math.abs(this.velocity) < p;
	}

	get omega(): number {
		return this.#omega;
	}
}

// -----------------------------------------------------------------------------
// SPRING PAIR CLASS
// -----------------------------------------------------------------------------
/**
 * A pair of springs for 2D values (e.g., domain min/max, x/y position).
 */
export class SpringPair {
	#springA: Spring;
	#springB: Spring;

	constructor(
		initialA: number = 0,
		initialB: number = 0,
		stiffness: number = 400,
		precision: number = 1e-6
	) {
		this.#springA = new Spring(initialA, stiffness, precision);
		this.#springB = new Spring(initialB, stiffness, precision);
	}

	configure(stiffness: number): void {
		this.#springA.configure(stiffness);
		this.#springB.configure(stiffness);
	}

	step(): void {
		this.#springA.step();
		this.#springB.step();
	}

	getRenderable(dt: number): { a: number; b: number } {
		return {
			a: this.#springA.getRenderable(dt),
			b: this.#springB.getRenderable(dt)
		};
	}

	getRenderableInto(dt: number, out: Float64Array | number[]): void {
		out[0] = this.#springA.getRenderable(dt);
		out[1] = this.#springB.getRenderable(dt);
	}

	grab(): void {
		this.#springA.grab();
		this.#springB.grab();
	}

	setTarget(a: number, b: number): void {
		this.#springA.target = a;
		this.#springB.target = b;
	}

	set(a: number, b: number): void {
		this.#springA.set(a);
		this.#springB.set(b);
	}

	isAtRest(precision?: number): boolean {
		return this.#springA.isAtRest(precision) && this.#springB.isAtRest(precision);
	}

	get a(): Spring {
		return this.#springA;
	}
	get b(): Spring {
		return this.#springB;
	}

	get currentA(): number {
		return this.#springA.current;
	}
	get currentB(): number {
		return this.#springB.current;
	}
	get targetA(): number {
		return this.#springA.target;
	}
	get targetB(): number {
		return this.#springB.target;
	}
}
