// =============================================================================
// AnimationLoop.js - Fixed timestep animation loop with render extrapolation
// =============================================================================

import { DT } from './Spring.js';

const MAX_DELTA = 0.1; // 100ms cap - handles tab switch, debugger pause, etc.

export class AnimationLoop {
	#accumulator = 0;
	#lastTime = 0;
	#rafId = null;
	#isRunning = false;

	#onPhysicsStep;
	#onRender;
	#onIdleCheck;

	#frameCount = 0;
	#physicsStepsThisFrame = 0;
	#lastDelta = 0;

	#boundFrame;

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

		this.#boundFrame = this.#frame.bind(this);
	}

	// ===========================================================================
	// PUBLIC API
	// ===========================================================================

	start() {
		if (this.#rafId !== null) return;

		this.#isRunning = true;
		this.#lastTime = performance.now();
		this.#accumulator = 0;
		this.#rafId = requestAnimationFrame(this.#boundFrame);
	}

	requestStart() {
		if (this.#rafId === null) {
			this.start();
		}
	}

	stop() {
		this.#isRunning = false;
		if (this.#rafId !== null) {
			cancelAnimationFrame(this.#rafId);
			this.#rafId = null;
		}
	}

	destroy() {
		this.stop();
	}

	// ===========================================================================
	// GETTERS
	// ===========================================================================

	get frameCount() {
		return this.#frameCount;
	}

	get physicsStepsLastFrame() {
		return this.#physicsStepsThisFrame;
	}

	get lastDelta() {
		return this.#lastDelta;
	}

	get accumulator() {
		return this.#accumulator;
	}

	get isRunning() {
		return this.#isRunning && this.#rafId !== null;
	}

	// ===========================================================================
	// FRAME LOOP
	// ===========================================================================

	#frame(time) {
		const now = time;
		// const now = performance.now();
		let delta = (now - this.#lastTime) / 1000;
		this.#lastTime = now;

		// Clamp delta - handles tab switch, debugger pause, slow frames
		if (delta > MAX_DELTA) {
			delta = MAX_DELTA;
		}

		this.#lastDelta = delta;
		this.#accumulator += delta;

		// Fixed timestep physics
		this.#physicsStepsThisFrame = 0;
		while (this.#accumulator >= DT) {
			this.#onPhysicsStep();
			this.#accumulator -= DT;
			this.#physicsStepsThisFrame++;
		}

		// Render with extrapolation
		this.#onRender(this.#accumulator);

		this.#frameCount++;

		// Check if we should continue
		const shouldContinue = this.#onIdleCheck ? !this.#onIdleCheck() : true;

		if (this.#isRunning && shouldContinue) {
			this.#rafId = requestAnimationFrame(this.#boundFrame);
		} else {
			this.#rafId = null;
		}
	}
}
