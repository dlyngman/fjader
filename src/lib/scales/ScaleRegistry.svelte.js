import { setContext, getContext, untrack } from 'svelte';
import { LinearScaleState } from './LinearScaleState.svelte.js';
import { BandScaleState } from './BandScaleState.svelte.js';
import { scaleOrdinal } from 'd3-scale';

// Helper to stringify sorted
const stableStringify = (obj) => {
	if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
	if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
	// Sort keys to ensure consistent ID regardless of prop order
	return `{${Object.keys(obj)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
		.join(',')}}`;
};

class ScaleRegistry {
	// 1. PUBLIC field (no #) to fix the "undefined" error
	scaleUsage = $state(new Map());
	#gpuCoordinator = null;

	constructor() {
		this.registryId = Math.random().toString(36).slice(2, 8);

		// Initialize the storage buckets
		this.scales = {
			linear: new Map(),
			band: new Map(),
			ordinal: new Map()
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

	getOrCreateScale(name, type = 'linear', config = {}, chartId = null) {
		// const configKey = Object.keys(config).length > 0 ? `-${JSON.stringify(config)}` : '';
		const configKey = Object.keys(config).length > 0 ? `-${stableStringify(config)}` : '';
		const key = `${name}-${type}${configKey}`;

		// 2. Dynamic Map creation (fixes the crash on 'log', 'point', etc.)
		if (!this.scales[type]) {
			this.scales[type] = new Map();
		}

		if (!this.scales[type].has(key)) {
			// Factory Logic
			if (['linear', 'log', 'time', 'pow', 'identity'].includes(type)) {
				this.scales[type].set(
					key,
					new LinearScaleState(name, undefined, type, undefined, config, this.#gpuCoordinator)
				);
			} else if (['band', 'point'].includes(type)) {
				this.scales[type].set(key, new BandScaleState(name, [], config));
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
			// 3. STOP THE LOOP: Untrack the bookkeeping!
			untrack(() => {
				if (!this.scaleUsage.has(scale)) {
					this.scaleUsage.set(scale, new Set());
				}

				const chartIds = this.scaleUsage.get(scale);
				// Only write if necessary (optimization)
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

		// 4. STOP THE LOOP: Untrack cleanup too
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

		// 🛡️ UNTRACK is vital here to prevent the 'Read -> Track -> Write -> Trigger' cycle
		untrack(() => {
			let changed = false;

			// Iterate (Read)
			for (const [scale, usageSet] of this.scaleUsage) {
				if (usageSet.has(chartId)) {
					// Mutate (Write)
					usageSet.delete(chartId);
					changed = true;

					if (usageSet.size === 0) {
						if (scale.destroy) scale.destroy();
						this.scaleUsage.delete(scale); // Mutate (Write)
						this._removeScaleFromStorage(scale);
					}
				}
			}

			if (changed) {
				this.#notifyTopologyChange();
			}
		});
	}

	// ... removeChartUsage, _removeScaleFromStorage (copy from previous if needed, or keeping it clean)
	_removeScaleFromStorage(scaleInstance) {
		for (const map of Object.values(this.scales)) {
			for (const [key, scale] of map) {
				if (scale === scaleInstance) {
					map.delete(key);
					return;
				}
			}
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
