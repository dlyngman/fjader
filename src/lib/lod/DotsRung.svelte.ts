// =============================================================================
// DotsRung — adaptive uniform modifier rung for auto-dots
//
// Spring-animated dot radius that fades in at sparse density.
// Spring is stepped by GPUCoordinator's 360Hz physics loop.
// Frame callback reads spring.current and writes to GPU uniform buffer.
//
// Only created when dots are enabled — the mark gates on lodDotsEnabled.
// =============================================================================

import { Spring } from '$lib/animation/Spring';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import type { DensityHost } from './DensityHost.svelte';
import type { LODRung } from './rung-types';

// JS implementation of GLSL smoothstep (Hermite interpolation)
function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

export class DotsRung implements LODRung {
	readonly name = 'dots';
	readonly kind = 'adaptive' as const;
	destroyed: boolean = false;

	// --- Dependencies ---
	#densityHost: DensityHost;
	#gpuCoordinator: GPUCoordinator;
	#getThreshold: () => number;
	#getBaseR: () => number;
	#setParam: (key: string, value: number) => void;

	// --- Spring + callbacks ---
	#spring: Spring;
	#physicsCallback: (() => void) | null;
	#frameCallback: ((isAnimating: boolean) => void) | null;
	#writeDotRadius: ((r: number) => void) | null = null;
	#invalidateLayer: (() => void) | null = null;

	// --- Reactive ---
	active = $derived(this.#densityHost.ctx.avgSpacing > 8);

	#springTarget = $derived.by(() => {
		const { avgSpacing } = this.#densityHost.ctx;
		return this.#getBaseR() * smoothstep(8, this.#getThreshold(), avgSpacing);
	});

	// --- Diagnostics (non-reactive, polled) ---
	dotRadius: number = 0;

	get props(): Record<string, unknown> {
		return { threshold: this.#getThreshold(), baseR: this.#getBaseR() };
	}

	constructor(
		densityHost: DensityHost,
		gpuCoordinator: GPUCoordinator,
		getThreshold: () => number,
		getBaseR: () => number,
		setParam: (key: string, value: number) => void
	) {
		this.#densityHost = densityHost;
		this.#gpuCoordinator = gpuCoordinator;
		this.#getThreshold = getThreshold;
		this.#getBaseR = getBaseR;
		this.#setParam = setParam;

		// Spring stepped by GPUCoordinator's 360Hz physics loop
		this.#spring = new Spring(0, 400);
		this.#physicsCallback = () => this.#spring.step();
		gpuCoordinator.addPhysicsCallback(this.#physicsCallback);

		// Frame callback for GPU writes (once per RAF)
		this.#frameCallback = (_isAnimating: boolean) => this.#onFrame();
		gpuCoordinator.addFrameCallback(this.#frameCallback);

		// Bridge derived target → spring
		$effect(() => {
			this.#spring.setTarget(this.#springTarget);
		});
	}

	// =========================================================================
	// GPU write target (set by Lines renderer after init)
	// =========================================================================

	setRenderTarget(writeDotRadius: (r: number) => void, invalidateLayer: () => void): void {
		this.#writeDotRadius = writeDotRadius;
		this.#invalidateLayer = invalidateLayer;
	}

	clearRenderTarget(): void {
		this.#writeDotRadius = null;
		this.#invalidateLayer = null;
	}

	// =========================================================================
	// Frame callback — GPU write only
	// =========================================================================

	#onFrame(): void {
		if (this.destroyed || !this.#spring || this.#spring.isAtRest()) return;

		const r = this.#spring.current;
		this.#writeDotRadius?.(r);
		this.#invalidateLayer?.();
		this.dotRadius = r;
	}

	// =========================================================================
	// Shift+scroll — adjust threshold
	// =========================================================================

	adjustResolution(deltaY: number): void {
		const step = deltaY < 0 ? -1 : 1;
		const current = this.#getThreshold();
		this.#setParam('threshold', Math.max(10, Math.min(100, current + step)));
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	destroy(): void {
		this.destroyed = true;

		if (this.#physicsCallback) {
			this.#gpuCoordinator.removePhysicsCallback(this.#physicsCallback);
			this.#physicsCallback = null;
		}

		if (this.#frameCallback) {
			this.#gpuCoordinator.removeFrameCallback(this.#frameCallback);
			this.#frameCallback = null;
		}

		this.#writeDotRadius = null;
		this.#invalidateLayer = null;
	}
}
