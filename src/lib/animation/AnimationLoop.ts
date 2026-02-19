import { DT } from './Spring';

const MAX_DELTA = 0.1;

interface AnimationLoopConfig {
	onPhysicsStep: () => void;
	onRender: (accumulator: number) => void;
	onIdleCheck?: (() => boolean) | null;
}

export class AnimationLoop {
	#accumulator = 0;
	#lastTime = 0;
	#rafId: number | null = null;
	#isRunning = false;

	#onPhysicsStep: () => void;
	#onRender: (accumulator: number) => void;
	#onIdleCheck: (() => boolean) | null;

	#frameCount = 0;
	#physicsStepsThisFrame = 0;
	#lastDelta = 0;

	#boundFrame: (time: number) => void;

	constructor({ onPhysicsStep, onRender, onIdleCheck = null }: AnimationLoopConfig) {
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

	start(): void {
		if (this.#rafId !== null) return;

		this.#isRunning = true;
		this.#lastTime = performance.now();
		this.#accumulator = 0;
		this.#rafId = requestAnimationFrame(this.#boundFrame);
	}

	requestStart(): void {
		if (this.#rafId === null) {
			this.start();
		}
	}

	stop(): void {
		this.#isRunning = false;
		if (this.#rafId !== null) {
			cancelAnimationFrame(this.#rafId);
			this.#rafId = null;
		}
	}

	destroy(): void {
		this.stop();
	}

	get frameCount(): number {
		return this.#frameCount;
	}

	get physicsStepsLastFrame(): number {
		return this.#physicsStepsThisFrame;
	}

	get lastDelta(): number {
		return this.#lastDelta;
	}

	get accumulator(): number {
		return this.#accumulator;
	}

	get isRunning(): boolean {
		return this.#isRunning && this.#rafId !== null;
	}

	#frame(time: number): void {
		const now = time;
		let delta = (now - this.#lastTime) / 1000;
		this.#lastTime = now;

		if (delta > MAX_DELTA) {
			delta = MAX_DELTA;
		}

		this.#lastDelta = delta;
		this.#accumulator += delta;

		this.#physicsStepsThisFrame = 0;
		while (this.#accumulator >= DT) {
			this.#onPhysicsStep();
			this.#accumulator -= DT;
			this.#physicsStepsThisFrame++;
		}

		this.#onRender(this.#accumulator);

		this.#frameCount++;

		const shouldContinue = this.#onIdleCheck ? !this.#onIdleCheck() : true;

		if (this.#isRunning && shouldContinue) {
			this.#rafId = requestAnimationFrame(this.#boundFrame);
		} else {
			this.#rafId = null;
		}
	}
}
