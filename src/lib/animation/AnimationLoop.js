// =============================================================================
// AnimationLoop.js - Fixed timestep animation loop with render extrapolation
// =============================================================================

import { DT } from './Spring.js';

// Maximum delta time to prevent "spiral of death" after tab switch or debugger pause
const MAX_DELTA = 0.1; // 100ms cap

/**
 * AnimationLoop manages a fixed-timestep physics simulation with variable-rate rendering.
 *
 * Key features:
 * - Fixed timestep physics (deterministic, stable)
 * - Accumulator pattern for frame-rate independence
 * - Render extrapolation for smooth visuals
 * - Automatic pause/resume on visibility change
 * - Zero-allocation in hot path
 *
 * Usage:
 * ```js
 * const loop = new AnimationLoop({
 *   onPhysicsStep: () => {
 *     // Called at fixed rate (360Hz) - update physics state
 *     mySpring.step();
 *   },
 *   onRender: (extrapolationDt) => {
 *     // Called once per frame - render with extrapolation
 *     const smoothValue = mySpring.getRenderable(extrapolationDt);
 *     draw(smoothValue);
 *   },
 *   onIdleCheck: () => {
 *     // Return true if animation should stop
 *     return mySpring.isAtRest();
 *   }
 * });
 *
 * loop.start();
 * ```
 */
export class AnimationLoop {
	// Timing state
	#accumulator = 0;
	#lastTime = 0;

	// Loop control
	#rafId = null;
	#isRunning = false;
	#isPaused = false;

	// Callbacks
	#onPhysicsStep;
	#onRender;
	#onIdleCheck;

	// Stats (for debugging/monitoring)
	#frameCount = 0;
	#physicsStepsThisFrame = 0;
	#lastDelta = 0;

	// Bound handlers (created once to avoid allocation)
	#boundFrame;
	#boundVisibilityHandler;

	#frameStats = {
		allocations: 0,
		lastHeapSize: 0,
		heapGrowth: []
	};

	/**
	 * @param {Object} config
	 * @param {Function} config.onPhysicsStep - Called for each fixed timestep (no arguments)
	 * @param {Function} config.onRender - Called once per frame with extrapolation dt in seconds
	 * @param {Function} [config.onIdleCheck] - Optional. Return true to auto-stop the loop
	 */
	constructor({ onPhysicsStep, onRender, onIdleCheck = null }) {
		if (typeof onPhysicsStep !== 'function') {
			throw new Error('AnimationLoop requires onPhysicsStep callback');
		}
		if (typeof onRender !== 'function') {
			throw new Error('AnimationLoop requires onRender callback');
		}

		this.#onPhysicsStep = onPhysicsStep;
		this.#onRender = onRender;
		this.#onIdleCheck = onIdleCheck;

		// Pre-bind methods to avoid allocation during animation
		this.#boundFrame = this.#frame.bind(this);
		this.#boundVisibilityHandler = this.#handleVisibility.bind(this);

		// Setup visibility change listener
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', this.#boundVisibilityHandler);
		}
	}

	// ===========================================================================
	// PUBLIC API
	// ===========================================================================

	/**
	 * Start the animation loop.
	 * If already running, this is a no-op.
	 */
	start() {
		if (this.#rafId !== null) {
			// Already have a pending frame, don't double-schedule
			return;
		}

		this.#isRunning = true;
		this.#isPaused = false;
		this.#lastTime = performance.now();
		this.#accumulator = 0;

		this.#rafId = requestAnimationFrame(this.#boundFrame);
	}

	/**
	 * Request the loop to start if not already running.
	 * Idempotent - safe to call multiple times.
	 */
	requestStart() {
		if (!this.#isRunning) {
			this.start();
		} else if (this.#isPaused) {
			this.resume();
		} else if (this.#rafId === null) {
			// Was running but stopped (idle check returned true)
			// Restart the loop
			this.#lastTime = performance.now();
			this.#accumulator = 0;
			this.#rafId = requestAnimationFrame(this.#boundFrame);
		}
	}

	/**
	 * Pause the animation loop (keeps state, can resume).
	 * Used when tab becomes hidden.
	 */
	pause() {
		this.#isPaused = true;
		if (this.#rafId !== null) {
			cancelAnimationFrame(this.#rafId);
			this.#rafId = null;
		}
	}

	/**
	 * Resume from pause.
	 * Resets timing to prevent large delta after resume.
	 */
	resume() {
		if (!this.#isRunning || !this.#isPaused) return;

		this.#isPaused = false;
		this.#lastTime = performance.now();
		this.#accumulator = 0;

		if (this.#rafId === null) {
			this.#rafId = requestAnimationFrame(this.#boundFrame);
		}
	}

	/**
	 * Fully stop the animation loop.
	 * Call start() to begin again.
	 */
	stop() {
		this.#isRunning = false;
		this.#isPaused = false;
		if (this.#rafId !== null) {
			cancelAnimationFrame(this.#rafId);
			this.#rafId = null;
		}
	}

	/**
	 * Clean up resources. Call when disposing of the loop.
	 */
	destroy() {
		this.stop();
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', this.#boundVisibilityHandler);
		}
	}

	// ===========================================================================
	// GETTERS (for debugging/monitoring)
	// ===========================================================================

	/** Total frames rendered */
	get frameCount() {
		return this.#frameCount;
	}

	/** Physics steps executed in the last frame */
	get physicsStepsLastFrame() {
		return this.#physicsStepsThisFrame;
	}

	/** Delta time of last frame in seconds */
	get lastDelta() {
		return this.#lastDelta;
	}

	/** Current accumulator value in seconds */
	get accumulator() {
		return this.#accumulator;
	}

	/** Whether the loop is currently running */
	get isRunning() {
		return this.#isRunning && !this.#isPaused;
	}

	/** Whether the loop is paused (e.g., tab hidden) */
	get isPaused() {
		return this.#isPaused;
	}

	// ===========================================================================
	// PRIVATE METHODS
	// ===========================================================================

	/**
	 * Handle document visibility changes.
	 * Pauses when hidden, resumes when visible.
	 */
	#handleVisibility() {
		if (document.hidden) {
			if (this.#isRunning && !this.#isPaused) {
				this.pause();
			}
		} else {
			if (this.#isRunning && this.#isPaused) {
				this.resume();
			}
		}
	}

	/**
	 * Main frame callback. This is the hot path.
	 * @param {DOMHighResTimeStamp} time - Current timestamp from requestAnimationFrame
	 */
	#frame(time) {
		// Sample heap size every 60 frames
		// if (this.#frameCount % 60 === 0 && performance.memory) {
		// 	const currentHeap = performance.memory.usedJSHeapSize;
		// 	const growth = currentHeap - this.#frameStats.lastHeapSize;
		// 	this.#frameStats.heapGrowth.push(growth);
		// 	this.#frameStats.lastHeapSize = currentHeap;

		// 	// If heap grows consistently, we have a leak
		// 	if (this.#frameStats.heapGrowth.length > 10) {
		// 		const avgGrowth = this.#frameStats.heapGrowth.slice(-10).reduce((a, b) => a + b, 0) / 10;

		// 		if (avgGrowth > 100000) {
		// 			// 100KB/second
		// 			console.warn(`⚠️ Heap growing at ${(avgGrowth / 1024).toFixed(2)}KB/sec`);
		// 		}

		// 		this.#frameStats.heapGrowth.shift();
		// 	}
		// }
		// performance.mark('frame');

		// Calculate delta time in seconds
		// let delta = (time - this.#lastTime) / 1000;
		// this.#lastTime = time;

		const now = performance.now();
		let delta = (now - this.#lastTime) / 1000;
		this.#lastTime = now;
		// Clamp delta to prevent spiral of death
		// (e.g., after debugger pause or slow frame)
		if (delta > MAX_DELTA) {
			delta = MAX_DELTA;
		}

		this.#lastDelta = delta;
		this.#accumulator += delta;

		// --- Fixed Timestep Physics ---
		// Run physics steps until accumulator is below one timestep
		this.#physicsStepsThisFrame = 0;

		while (this.#accumulator >= DT) {
			this.#onPhysicsStep();
			this.#accumulator -= DT;
			this.#physicsStepsThisFrame++;
		}

		// --- Render with Extrapolation ---
		// Pass remaining accumulator time for smooth interpolation
		this.#onRender(this.#accumulator);

		this.#frameCount++;

		// --- Check if we should continue ---
		let shouldContinue = true;

		if (this.#onIdleCheck) {
			shouldContinue = !this.#onIdleCheck();
		}

		// Schedule next frame or stop
		if (this.#isRunning && !this.#isPaused && shouldContinue) {
			this.#rafId = requestAnimationFrame(this.#boundFrame);
		} else {
			this.#rafId = null;

			// If we stopped due to idle check, keep isRunning true
			// so requestStart() can restart us
			if (!shouldContinue) {
				// Loop stopped itself due to idle - this is normal
				// isRunning stays true, rafId is null
			}
		}
	}
}
