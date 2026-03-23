// src/lib/scales/ParallelAxisReorder.svelte.ts
// Manages drag-to-reorder interaction and spring-animated axis positions
// for parallel coordinates charts. Lazily instantiated by ChartScales
// only when parallel columns are registered.

import { Spring } from '$lib/animation';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';

interface ParallelAxisReorderConfig {
	gpuCoordinator: GPUCoordinator;
	chartId: string;
	getAxisOrder: () => number[];
	setAxisOrder: (order: number[]) => void;
}

const REORDER_STIFFNESS = 120;
const RELEASE_STIFFNESS = 600;
const REST_PRECISION = 0.0005;

export class ParallelAxisReorder {
	#config: ParallelAxisReorderConfig;

	// --- DRAG STATE ---
	#reorderFrom: number | null = null;
	#reorderStartX = 0;
	#reorderAxisOrigX = 0;
	#reorderOriginalOrder: number[] = [];
	#reorderLastSlot: number | null = null;
	reorderCurrentX = $state<number | null>(null);
	reorderDataIdx = $state<number | null>(null);

	// --- SPRING ANIMATION ---
	#axisSprings: Spring[] = [];
	#axisAnimating = false;
	animatedAxisXPositions = $state<number[]>([]);

	constructor(config: ParallelAxisReorderConfig) {
		this.#config = config;
		config.gpuCoordinator.addPhysicsCallback(this.#physicsCallback);
		config.gpuCoordinator.addFrameCallback(this.#frameCallback);
	}

	// --- CALLBACKS (360Hz physics + frame sync) ---

	#physicsCallback = (): void => {
		if (!this.#axisAnimating) return;
		for (let d = 0; d < this.#axisSprings.length; d++) {
			if (d === this.reorderDataIdx) continue;
			this.#axisSprings[d].step();
		}
	};

	#frameCallback = (): void => {
		if (!this.#axisAnimating && this.reorderDataIdx == null) return;
		const order = this.#config.getAxisOrder();
		const n = order.length;
		let allAtRest = true;
		const positions = new Array<number>(n);
		for (let v = 0; v < n; v++) {
			const d = order[v];
			positions[v] = this.#axisSprings[d].current;
			if (d !== this.reorderDataIdx && !this.#axisSprings[d].isAtRest(REST_PRECISION)) {
				allAtRest = false;
			}
		}
		this.animatedAxisXPositions = positions;
		if (allAtRest && this.#axisAnimating) {
			for (const s of this.#axisSprings) {
				s.current = s.target;
				s.velocity = 0;
				s.configure(REORDER_STIFFNESS);
			}
			for (let v = 0; v < n; v++) positions[v] = this.#axisSprings[order[v]].current;
			this.animatedAxisXPositions = positions;
			this.#axisAnimating = false;
		} else if (!allAtRest) {
			this.#config.gpuCoordinator.invalidateChart(this.#config.chartId);
		}
	};

	// --- HELPERS ---

	#ensureInit(): void {
		const order = this.#config.getAxisOrder();
		const n = order.length;
		if (this.#axisSprings.length !== n) {
			this.#axisSprings = new Array(n);
			for (let v = 0; v < n; v++) {
				const d = order[v];
				const pos = n > 1 ? v / (n - 1) : 0.5;
				this.#axisSprings[d] = new Spring(pos, REORDER_STIFFNESS, REST_PRECISION);
			}
			const positions = new Array<number>(n);
			for (let v = 0; v < n; v++) positions[v] = this.#axisSprings[order[v]].current;
			this.animatedAxisXPositions = positions;
		}
	}

	#updateTargets(): void {
		const order = this.#config.getAxisOrder();
		const n = order.length;
		for (let v = 0; v < n; v++) {
			const d = order[v];
			this.#axisSprings[d].target = n > 1 ? v / (n - 1) : 0.5;
		}
		this.#axisAnimating = true;
		this.#config.gpuCoordinator.invalidateChart(this.#config.chartId);
	}

	// --- PUBLIC API ---

	startReorder = (innerX: number, innerWidth: number): boolean => {
		const order = this.#config.getAxisOrder();
		const n = order.length;
		if (n === 0) return false;
		const gap = n > 1 ? innerWidth / (n - 1) : innerWidth;
		let bestVisual = 0;
		let bestDist = Infinity;
		for (let v = 0; v < n; v++) {
			const axisX = n > 1 ? (v / (n - 1)) * innerWidth : innerWidth / 2;
			const dist = Math.abs(innerX - axisX);
			if (dist < bestDist) {
				bestDist = dist;
				bestVisual = v;
			}
		}
		if (bestDist > gap * 0.5) return false;
		this.#reorderFrom = bestVisual;
		this.#reorderStartX = innerX;
		this.#reorderAxisOrigX = n > 1 ? (bestVisual / (n - 1)) * innerWidth : innerWidth / 2;
		this.reorderCurrentX = this.#reorderAxisOrigX;
		this.reorderDataIdx = order[bestVisual];
		this.#reorderOriginalOrder = [...order];
		this.#reorderLastSlot = bestVisual;
		this.#ensureInit();
		this.#config.gpuCoordinator.invalidateChart(this.#config.chartId);
		return true;
	};

	updateReorder = (innerX: number, innerWidth: number): void => {
		if (this.#reorderFrom == null) return;
		this.reorderCurrentX = this.#reorderAxisOrigX + (innerX - this.#reorderStartX);

		// Dragged axis follows cursor
		if (this.reorderDataIdx != null) {
			this.#axisSprings[this.reorderDataIdx].set(
				Math.max(0, Math.min(1, this.reorderCurrentX / innerWidth))
			);
		}

		// Compute preview slot and update axis order if changed
		const n = this.#reorderOriginalOrder.length;
		let closestSlot = 0;
		let closestDist = Infinity;
		for (let v = 0; v < n; v++) {
			const slotX = n > 1 ? (v / (n - 1)) * innerWidth : innerWidth / 2;
			const dist = Math.abs(this.reorderCurrentX! - slotX);
			if (dist < closestDist) {
				closestDist = dist;
				closestSlot = v;
			}
		}
		if (closestSlot !== this.#reorderLastSlot) {
			this.#reorderLastSlot = closestSlot;
			const order = [...this.#reorderOriginalOrder];
			const [moved] = order.splice(this.#reorderFrom, 1);
			order.splice(closestSlot, 0, moved);
			this.#config.setAxisOrder(order);
			this.#updateTargets();
		}
		this.#config.gpuCoordinator.invalidateChart(this.#config.chartId);
	};

	endReorder = (): void => {
		const releasedIdx = this.reorderDataIdx;
		this.reorderDataIdx = null;
		this.reorderCurrentX = null;
		this.#updateTargets();
		if (releasedIdx != null && this.#axisSprings[releasedIdx]) {
			const spring = this.#axisSprings[releasedIdx];
			spring.configure(RELEASE_STIFFNESS);
			const displacement = spring.target - spring.current;
			spring.velocity = displacement * spring.omega;
			for (let i = 0; i < 6; i++) spring.step();
		}
		// Force-sync positions so Svelte picks them up before next render
		const order = this.#config.getAxisOrder();
		const n = order.length;
		const positions = new Array<number>(n);
		for (let v = 0; v < n; v++) positions[v] = this.#axisSprings[order[v]].current;
		this.animatedAxisXPositions = positions;

		this.#reorderFrom = null;
		this.#reorderOriginalOrder = [];
		this.#reorderLastSlot = null;
	};

	cancelReorder = (): void => {
		if (this.#reorderOriginalOrder.length > 0) {
			this.#config.setAxisOrder(this.#reorderOriginalOrder);
		}
		this.#reorderFrom = null;
		this.reorderCurrentX = null;
		this.reorderDataIdx = null;
		this.#reorderOriginalOrder = [];
		this.#reorderLastSlot = null;
	};

	/** Reset springs when axis count changes (columns added/removed). */
	resetSprings(): void {
		this.#axisSprings = [];
	}

	destroy(): void {
		this.#config.gpuCoordinator.removePhysicsCallback(this.#physicsCallback);
		this.#config.gpuCoordinator.removeFrameCallback(this.#frameCallback);
	}
}
