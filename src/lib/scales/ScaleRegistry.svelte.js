// src/lib/scales/ScaleRegistry.svelte.js
import { setContext, getContext, untrack } from 'svelte';
import { LinearScaleState } from './LinearScaleState.svelte.js';
import { TimeScaleState } from './TimeScaleState.svelte.js';
import { BandScaleState } from './BandScaleState.svelte.js';
import { ColorScaleState } from './ColorScaleState.svelte.js';
import { SizeScaleState } from './SizeScaleState.svelte.js';
import { scaleOrdinal } from 'd3-scale';

// Helper to stringify sorted
const stableStringify = (obj) => {
	if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
	if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
	return `{${Object.keys(obj)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
		.join(',')}}`;
};

class ScaleRegistry {
	// Public field for reactive tracking
	scaleUsage = $state(new Map());
	#gpuCoordinator = null;

	// ============================================================
	// COLOR SCALE SLOT MANAGEMENT (GPU resource allocation)
	// ============================================================
	// Free lists for recycled slots
	#freeColorSlots = [];
	#freeRampSlots = [];
	#freePaletteSlots = [];

	// High water marks (next fresh slot index)
	#nextColorSlot = 0;
	#nextRampSlot = 0;
	#nextPaletteSlot = 0;

	// Fixed capacity (matches SSBO sizing in GPUCoordinator)
	#maxColorSlots = 64;
	#maxRampSlots = 64;
	#maxPaletteSlots = 64;

	// Size scale slot management
	#freeSizeSlots = [];
	#nextSizeSlot = 0;
	#maxSizeSlots = 64;

	constructor() {
		this.registryId = Math.random().toString(36).slice(2, 8);

		// Initialize the storage buckets
		this.scales = {
			linear: new Map(),
			band: new Map(),
			ordinal: new Map(),
			color: new Map(),
			size: new Map()
		};
	}

	setGPUCoordinator(coordinator) {
		this.#gpuCoordinator = coordinator;
	}

	#notifyTopologyChange() {
		if (this.#gpuCoordinator) {
			this.#gpuCoordinator.scheduleTopologyUpdate();
		}
	}

	// ============================================================
	// SLOT ALLOCATION METHODS
	// ============================================================

	/**
	 * Allocate a color config slot index.
	 * Prefers recycled slots, falls back to fresh allocation.
	 * @returns {number} Slot index (0-63)
	 * @throws {Error} If slot limit exceeded
	 */
	allocateColorSlot() {
		// Prefer recycled slots
		if (this.#freeColorSlots.length > 0) {
			return this.#freeColorSlots.pop();
		}

		// Check capacity
		if (this.#nextColorSlot >= this.#maxColorSlots) {
			console.warn(
				`[ScaleRegistry] Color scale limit reached (${this.#maxColorSlots}). ` +
					`Active: ${this.#nextColorSlot - this.#freeColorSlots.length}, ` +
					`Recycled: ${this.#freeColorSlots.length}. ` +
					`Ensure unused charts are destroyed, or share scales by field name.`
			);
			throw new Error(
				`Color scale limit exceeded (${this.#maxColorSlots}). ` +
					`Scales are shared by field name. Ensure old charts are destroyed before creating new ones.`
			);
		}

		return this.#nextColorSlot++;
	}

	/**
	 * Allocate a ramp slot index (for continuous color scales).
	 * Each ramp slot holds 256 colors.
	 * @returns {number} Slot index (0-63)
	 */
	allocateRampSlot() {
		if (this.#freeRampSlots.length > 0) {
			return this.#freeRampSlots.pop();
		}

		if (this.#nextRampSlot >= this.#maxRampSlots) {
			console.warn(`[ScaleRegistry] Ramp slot limit reached (${this.#maxRampSlots}).`);
			throw new Error(`Ramp slot limit exceeded (${this.#maxRampSlots}).`);
		}

		return this.#nextRampSlot++;
	}

	/**
	 * Allocate a palette slot index (for ordinal color scales).
	 * Each palette slot holds 32 colors.
	 * @returns {number} Slot index (0-63)
	 */
	allocatePaletteSlot() {
		if (this.#freePaletteSlots.length > 0) {
			return this.#freePaletteSlots.pop();
		}

		if (this.#nextPaletteSlot >= this.#maxPaletteSlots) {
			console.warn(`[ScaleRegistry] Palette slot limit reached (${this.#maxPaletteSlots}).`);
			throw new Error(`Palette slot limit exceeded (${this.#maxPaletteSlots}).`);
		}

		return this.#nextPaletteSlot++;
	}

	// ============================================================
	// SLOT RELEASE METHODS
	// ============================================================

	/**
	 * Release a color config slot back to the free list.
	 * @param {number} slot - Slot index to release
	 */
	releaseColorSlot(slot) {
		if (typeof slot === 'number' && slot >= 0 && slot < this.#nextColorSlot) {
			this.#freeColorSlots.push(slot);
		}
	}

	/**
	 * Release a ramp slot back to the free list.
	 * @param {number} slot - Slot index to release
	 */
	releaseRampSlot(slot) {
		if (typeof slot === 'number' && slot >= 0 && slot < this.#nextRampSlot) {
			this.#freeRampSlots.push(slot);
		}
	}

	/**
	 * Release a palette slot back to the free list.
	 * @param {number} slot - Slot index to release
	 */
	releasePaletteSlot(slot) {
		if (typeof slot === 'number' && slot >= 0 && slot < this.#nextPaletteSlot) {
			this.#freePaletteSlots.push(slot);
		}
	}

	/**
	 * Allocate a size config slot index.
	 * @returns {number} Slot index (0-63)
	 */
	allocateSizeSlot() {
		if (this.#freeSizeSlots.length > 0) {
			return this.#freeSizeSlots.pop();
		}

		if (this.#nextSizeSlot >= this.#maxSizeSlots) {
			throw new Error(`Size scale limit exceeded (${this.#maxSizeSlots}).`);
		}

		return this.#nextSizeSlot++;
	}

	/**
	 * Release a size config slot back to the free list.
	 * @param {number} slot - Slot index to release
	 */
	releaseSizeSlot(slot) {
		if (typeof slot === 'number' && slot >= 0 && slot < this.#nextSizeSlot) {
			this.#freeSizeSlots.push(slot);
		}
	}

	// ============================================================
	// DEBUG STATS
	// ============================================================

	/**
	 * Get color slot allocation statistics for debugging.
	 * @returns {Object} Stats object
	 */
	getColorSlotStats() {
		return {
			color: {
				active: this.#nextColorSlot - this.#freeColorSlots.length,
				recycled: this.#freeColorSlots.length,
				highWaterMark: this.#nextColorSlot,
				capacity: this.#maxColorSlots
			},
			ramp: {
				active: this.#nextRampSlot - this.#freeRampSlots.length,
				recycled: this.#freeRampSlots.length,
				highWaterMark: this.#nextRampSlot,
				capacity: this.#maxRampSlots
			},
			palette: {
				active: this.#nextPaletteSlot - this.#freePaletteSlots.length,
				recycled: this.#freePaletteSlots.length,
				highWaterMark: this.#nextPaletteSlot,
				capacity: this.#maxPaletteSlots
			}
		};
	}

	// ============================================================
	// EXISTING SCALE MANAGEMENT (unchanged logic, updated _removeScaleFromStorage)
	// ============================================================

	getOrCreateScale(name, type = 'linear', config = {}, chartId = null) {
		let key;

		if (type === 'color') {
			// Color scales: key by field + type only (scheme is mutable state)
			const scaleType = config.type || 'sequential';
			key = `${name}-color-${scaleType}`;
		} else {
			// Other scales: key by full config (padding, align, etc. matter)
			const configKey = Object.keys(config).length > 0 ? `-${stableStringify(config)}` : '';
			key = `${name}-${type}${configKey}`;
		}

		// Dynamic Map creation
		if (!this.scales[type]) {
			this.scales[type] = new Map();
		}

		if (!this.scales[type].has(key)) {
			// Factory Logic
			if (['linear', 'log', 'pow', 'identity'].includes(type)) {
				this.scales[type].set(
					key,
					new LinearScaleState(name, undefined, type, undefined, config, this.#gpuCoordinator)
				);
			} else if (type === 'time') {
				this.scales[type].set(
					key,
					new TimeScaleState(name, undefined, 'time', undefined, config, this.#gpuCoordinator)
				);
			} else if (['band', 'point'].includes(type)) {
				this.scales[type].set(
					key,
					new BandScaleState(name, [], {
						paddingInner: config.paddingInner ?? (type === 'point' ? 1 : 0.1),
						paddingOuter: config.paddingOuter ?? 0.1,
						padding: config.padding ?? 0.1,
						align: config.align ?? 0.5
					})
				);
			} else if (type === 'color') {
				// Apply default scheme based on explicit type
				const scaleType = config.type || 'sequential';
				const defaultScheme = scaleType === 'ordinal' ? 'tableau10' : 'viridis';

				console.log(
					`[ScaleRegistry] Creating color scale for ${name}: type=${scaleType}, scheme=${config.scheme || defaultScheme}`
				);

				this.scales[type].set(
					key,
					new ColorScaleState(
						{
							field: name,
							type: scaleType, // Pass explicit type
							scheme: config.scheme || defaultScheme, // Apply default based on type
							domain: config.domain || [],
							reverse: config.reverse ?? false,
							midpoint: config.midpoint
						},
						this,
						this.#gpuCoordinator
					)
				);
			} else if (type === 'size') {
				this.scales[type].set(
					key,
					new SizeScaleState(
						{
							field: name,
							domain: config.domain || [],
							range: config.range || [2, 12]
						},
						this,
						this.#gpuCoordinator
					)
				);
			} else if (['ordinal', 'categorical'].includes(type)) {
				this.scales[type].set(
					key,
					scaleOrdinal()
						.range(['#EFB605', '#FFF84A', '#FF0266'])
						.domain(['Adelie', 'Gentoo', 'Chinstrap'])
				);
			} else {
				// Fallback
				this.scales[type].set(
					key,
					new LinearScaleState(name, undefined, 'linear', undefined, config, this.#gpuCoordinator)
				);
			}
		}

		const scale = this.scales[type].get(key);

		if (chartId && scale) {
			untrack(() => {
				if (!this.scaleUsage.has(scale)) {
					this.scaleUsage.set(scale, new Set());
				}

				const chartIds = this.scaleUsage.get(scale);
				if (!chartIds.has(chartId)) {
					chartIds.add(chartId);
					this.#notifyTopologyChange();
				}
			});
		}

		return scale;
	}

	deregisterChart(scale, chartId) {
		if (!scale || !chartId) return;

		untrack(() => {
			if (this.scaleUsage.has(scale)) {
				const usage = this.scaleUsage.get(scale);
				if (usage.delete(chartId)) {
					if (usage.size === 0) {
						if (scale.destroy) scale.destroy();
						this.scaleUsage.delete(scale);
						this._removeScaleFromStorage(scale);
					}
					this.#notifyTopologyChange();
				}
			}
		});
	}

	removeChartUsage(chartId) {
		if (!chartId) return;

		untrack(() => {
			let changed = false;

			for (const [scale, usageSet] of this.scaleUsage) {
				if (usageSet.has(chartId)) {
					usageSet.delete(chartId);
					changed = true;

					if (usageSet.size === 0) {
						if (scale.destroy) scale.destroy();
						this.scaleUsage.delete(scale);
						this._removeScaleFromStorage(scale);
					}
				}
			}

			if (changed) {
				this.#notifyTopologyChange();
			}
		});
	}

	/**
	 * Remove scale from storage and release any GPU slots it held.
	 * @param {Object} scaleInstance - Scale to remove
	 */
	_removeScaleFromStorage(scaleInstance) {
		// Release GPU slots if this is a color or size scale
		if (scaleInstance && typeof scaleInstance.gpuSlots === 'object') {
			const slots = scaleInstance.gpuSlots;

			if (typeof slots.configSlot === 'number') {
				this.releaseColorSlot(slots.configSlot);
			}
			if (typeof slots.rampSlot === 'number') {
				this.releaseRampSlot(slots.rampSlot);
			}
			if (typeof slots.paletteSlot === 'number') {
				this.releasePaletteSlot(slots.paletteSlot);
			}
			if (typeof slots.sizeConfigSlot === 'number') {
				this.releaseSizeSlot(slots.sizeConfigSlot);
			}
		}

		// Remove from storage maps
		for (const map of Object.values(this.scales)) {
			for (const [key, scale] of map) {
				if (scale === scaleInstance) {
					map.delete(key);
					return;
				}
			}
		}
	}

	/**
	 * Invalidate all charts that use a specific scale field.
	 * Called when a color scale's scheme updates to trigger re-renders.
	 * @param {string} field - The field name of the scale that changed
	 */
	invalidateChartsForScale(field) {
		if (!this.#gpuCoordinator) return;

		// Find all color scales with matching field
		// Keys are like "species-color-{scheme:...}", so we need to search
		const colorScales = this.scales.color;
		if (!colorScales) return;

		let foundScale = null;
		for (const [key, scale] of colorScales) {
			// Check if this scale's field matches
			if (scale.field === field) {
				foundScale = scale;
				break;
			}
		}

		if (!foundScale) return;

		// Get all charts using this scale via scaleUsage (keyed by scale object)
		const chartIds = this.scaleUsage.get(foundScale);
		if (!chartIds || chartIds.size === 0) return;

		// Invalidate each chart
		for (const chartId of chartIds) {
			this.#gpuCoordinator.invalidateChart(chartId);
		}
	}
}

export function setScaleRegistry() {
	const state = new ScaleRegistry();
	return setContext('scale-registry', state);
}

export function getScaleState(name, type = 'linear', config = {}, chartId = null) {
	const scaleRegistry = getContext('scale-registry');
	if (!scaleRegistry) {
		console.error('No Registry');
		return null;
	}
	return scaleRegistry.getOrCreateScale(name, type, config, chartId);
}
