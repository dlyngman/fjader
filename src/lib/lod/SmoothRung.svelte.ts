// =============================================================================
// SmoothRung — analytical overlay rung for rolling average smoothing
//
// User-activated (analytical). Shift+scroll adjusts window size.
// Creates a RollingAvgNode that the overlay mark receives as a channel value.
// Field references are getters so the node picks up channel reassignments.
// =============================================================================

import { RollingAvgNode } from '$lib/sql/rolling-avg';
import type { SmoothMode } from '$lib/sql/rolling-avg';
import type { LODRung } from './rung-types';

export interface FieldGetters {
	y: () => unknown;
	x: () => unknown;
	partition: () => unknown | null;
}

export class SmoothRung implements LODRung {
	readonly name = 'smooth';
	readonly kind = 'analytical' as const;
	destroyed: boolean = false;

	// --- Dependencies ---
	#getWindow: () => number;
	#getMode: () => SmoothMode;
	#fields: FieldGetters;
	#setParam: (key: string, value: number | string) => void;
	#scrollAccum: number = 0;

	// --- Reactive ---
	node: RollingAvgNode | null = $state(null);
	active = $derived(this.#getWindow() > 0);

	get props(): Record<string, unknown> {
		return { window: this.#getWindow(), mode: this.#getMode() };
	}

	constructor(
		getWindow: () => number,
		getMode: () => SmoothMode,
		fields: FieldGetters,
		setParam: (key: string, value: number | string) => void
	) {
		this.#getWindow = getWindow;
		this.#getMode = getMode;
		this.#fields = fields;
		this.#setParam = setParam;

		// Create node once when overlay activates, reuse across changes.
		// Fields are read via getters so channel reassignment is picked up.
		$effect(() => {
			if (!this.active) {
				this.node = null;
				return;
			}
			if (!this.node) {
				const seriesField = this.#fields.partition();
				this.node = new RollingAvgNode(
					String(this.#fields.y()),
					String(this.#fields.x()),
					seriesField ? String(seriesField) : null,
					this.#getWindow(),
					this.#getMode()
				);
			}
		});

		// Sync parameters to node — triggers query invalidation
		$effect(() => {
			if (!this.node) return;
			const w = this.#getWindow();
			if (w > 0) {
				this.node.setWindowSize(w);
				this.node.setMode(this.#getMode());
			}
		});
	}

	// =========================================================================
	// Shift+scroll — adjust window size
	// =========================================================================

	adjustResolution(deltaY: number): void {
		this.#scrollAccum += deltaY;
		const threshold = 60; // px of scroll per window step
		if (Math.abs(this.#scrollAccum) >= threshold) {
			const steps = Math.trunc(this.#scrollAccum / threshold);
			this.#scrollAccum -= steps * threshold;
			const current = this.#getWindow();
			this.#setParam('window', Math.max(0, Math.min(100, current + steps)));
		}
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	destroy(): void {
		this.destroyed = true;
	}
}
