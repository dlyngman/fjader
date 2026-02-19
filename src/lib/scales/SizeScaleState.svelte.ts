// src/lib/scales/SizeScaleState.svelte.ts

interface SizeScaleConfig {
	field: string;
	domain?: number[];
	range?: [number, number];
}

/**
 * Reactive state for a GPU-backed size scale.
 *
 * Handles continuous sqrt mapping for area-proportional circle sizing.
 * Raw data flows to GPU unchanged; the vertex shader normalizes, applies
 * sqrt, and interpolates to the pixel range.
 */
export class SizeScaleState {
	// Identity
	#field: string;
	#registry: any;
	#gpuCoordinator: any;

	// GPU slot index (allocated from registry)
	#configSlot: number = -1;

	// Scale configuration
	#range: [number, number]; // [minPx, maxPx]

	// Reactive state
	domain: number[] = $state([]);
	ready: boolean = $state(false);

	constructor(config: SizeScaleConfig, registry: any, gpuCoordinator: any) {
		this.#field = config.field;
		this.#range = config.range || [2, 12];
		this.#registry = registry;
		this.#gpuCoordinator = gpuCoordinator;

		// Set initial domain
		this.domain = config.domain || [];

		// Allocate GPU slot
		this.#configSlot = this.#registry.allocateSizeSlot();

		// Initial GPU upload (if domain is ready)
		if (this.domain.length > 0) {
			this.#uploadToGPU();
		}
	}

	// ============================================================
	// GETTERS
	// ============================================================

	get field(): string {
		return this.#field;
	}

	/**
	 * The config slot index (used by marks for sizeScaleIndex).
	 */
	get gpuIndex(): number {
		return this.#configSlot;
	}

	/**
	 * The pixel range [minPx, maxPx] for this size scale.
	 * Used by legends to render reference circles at correct sizes.
	 */
	get range(): [number, number] {
		return this.#range;
	}

	/**
	 * GPU slot information for registry cleanup.
	 */
	get gpuSlots(): { sizeConfigSlot: number } {
		return { sizeConfigSlot: this.#configSlot };
	}

	// ============================================================
	// DATA PROCESSING
	// ============================================================

	/**
	 * Pass-through: raw data goes to GPU unchanged.
	 * The vertex shader does the normalization and sqrt scaling.
	 */
	processDataForGPU(data: ArrayLike<number>): Float32Array {
		if (data instanceof Float32Array) return data;
		return new Float32Array(data);
	}

	// ============================================================
	// GPU UPLOAD
	// ============================================================

	#uploadToGPU(): void {
		if (!this.#gpuCoordinator) return;
		if (this.domain.length === 0) return;

		const config = this.#buildSizeConfig();
		this.#gpuCoordinator.writeSizeConfig(this.#configSlot, config);
		this.ready = true;
	}

	/**
	 * Build the SizeConfig struct as ArrayBuffer.
	 *
	 * MUST MATCH WGSL LAYOUT:
	 * struct SizeConfig {
	 *   domainMin: f32,   // byte 0
	 *   domainMax: f32,   // byte 4
	 *   rangeMin: f32,    // byte 8  (CSS pixels)
	 *   rangeMax: f32,    // byte 12 (CSS pixels)
	 * }; // 16 bytes total
	 */
	#buildSizeConfig(): ArrayBuffer {
		const buffer = new ArrayBuffer(16);
		const view = new DataView(buffer);
		const LE = true;

		view.setFloat32(0, this.domain[0] ?? 0, LE);
		view.setFloat32(4, this.domain[this.domain.length - 1] ?? 0, LE);
		view.setFloat32(8, this.#range[0], LE);
		view.setFloat32(12, this.#range[1], LE);

		return buffer;
	}

	// ============================================================
	// DOMAIN / RANGE UPDATES
	// ============================================================

	/**
	 * Update the domain. Triggers GPU re-upload.
	 */
	setDomain(newDomain: number[]): void {
		if (!newDomain || newDomain.length === 0) return;

		const domainChanged =
			newDomain.length !== this.domain.length || newDomain.some((v, i) => v !== this.domain[i]);

		if (!domainChanged) return;

		this.domain = [...newDomain];
		this.#uploadToGPU();
	}

	/**
	 * Update the pixel range. Triggers GPU re-upload.
	 */
	setRange(newRange: [number, number]): void {
		if (!newRange || newRange.length !== 2) return;
		if (newRange[0] === this.#range[0] && newRange[1] === this.#range[1]) return;

		this.#range = [...newRange];
		if (this.domain.length > 0) {
			this.#uploadToGPU();
		}
	}

	// ============================================================
	// CLEANUP
	// ============================================================

	destroy(): void {
		this.ready = false;
	}
}
