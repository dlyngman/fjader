// src/lib/scales/ScaleRegistry.svelte.ts
import { setContext, getContext, untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { LinearScaleState } from './LinearScaleState.svelte';
import { TimeScaleState } from './TimeScaleState.svelte';
import { LogScaleState } from './LogScaleState.svelte';
import { SymlogScaleState } from './SymlogScaleState.svelte';
import { BandScaleState } from './BandScaleState.svelte';
import { ColorScaleState } from './ColorScaleState.svelte';
import { SizeScaleState } from './SizeScaleState.svelte';
import { scaleOrdinal } from 'd3-scale';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import type { ColorScaleType } from '$lib/types';
import { isTransformType } from './color-utils';

export type AnyScaleState =
	| LinearScaleState
	| TimeScaleState
	| LogScaleState
	| SymlogScaleState
	| BandScaleState
	| ColorScaleState
	| SizeScaleState;

type ScaleMapBucket = SvelteMap<string, AnyScaleState>;

interface GPUSlots {
	configSlot?: number;
	rampSlot?: number;
	paletteSlot?: number;
	sizeConfigSlot?: number;
}

// Helper to stringify sorted
const stableStringify = (obj: unknown): string => {
	if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
	if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
	return `{${Object.keys(obj as Record<string, unknown>)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`)
		.join(',')}}`;
};

export class ScaleRegistry {
	// Public field for reactive tracking
	scaleUsage = $state(new Map<AnyScaleState, Set<string>>());
	#gpuCoordinator: GPUCoordinator | null = null;

	// ============================================================
	// COLOR SCALE SLOT MANAGEMENT (GPU resource allocation)
	// ============================================================
	#freeColorSlots: number[] = [];
	#freeRampSlots: number[] = [];
	#freePaletteSlots: number[] = [];

	#nextColorSlot = 0;
	#nextRampSlot = 0;
	#nextPaletteSlot = 0;

	#maxColorSlots = 64;
	#maxRampSlots = 64;
	#maxPaletteSlots = 64;

	// Size scale slot management
	#freeSizeSlots: number[] = [];
	#nextSizeSlot = 0;
	#maxSizeSlots = 64;

	registryId: string;
	scales: Record<string, ScaleMapBucket>;

	constructor() {
		this.registryId = Math.random().toString(36).slice(2, 8);

		// Initialize the storage buckets (SvelteMap for reactive legend lookups)
		this.scales = {
			linear: new SvelteMap(),
			log: new SvelteMap(),
			symlog: new SvelteMap(),
			pow: new SvelteMap(),
			identity: new SvelteMap(),
			time: new SvelteMap(),
			band: new SvelteMap(),
			point: new SvelteMap(),
			ordinal: new SvelteMap(),
			color: new SvelteMap(),
			size: new SvelteMap()
		};
	}

	setGPUCoordinator(coordinator: GPUCoordinator): void {
		this.#gpuCoordinator = coordinator;
	}

	#notifyTopologyChange(): void {
		if (this.#gpuCoordinator) {
			this.#gpuCoordinator.scheduleTopologyUpdate();
		}
	}

	// ============================================================
	// SLOT ALLOCATION METHODS
	// ============================================================

	allocateColorSlot(): number {
		if (this.#freeColorSlots.length > 0) {
			return this.#freeColorSlots.pop()!;
		}

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

	allocateRampSlot(): number {
		if (this.#freeRampSlots.length > 0) {
			return this.#freeRampSlots.pop()!;
		}

		if (this.#nextRampSlot >= this.#maxRampSlots) {
			console.warn(`[ScaleRegistry] Ramp slot limit reached (${this.#maxRampSlots}).`);
			throw new Error(`Ramp slot limit exceeded (${this.#maxRampSlots}).`);
		}

		return this.#nextRampSlot++;
	}

	allocatePaletteSlot(): number {
		if (this.#freePaletteSlots.length > 0) {
			return this.#freePaletteSlots.pop()!;
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

	releaseColorSlot(slot: number): void {
		if (typeof slot === 'number' && slot >= 0 && slot < this.#nextColorSlot) {
			this.#freeColorSlots.push(slot);
		}
	}

	releaseRampSlot(slot: number): void {
		if (typeof slot === 'number' && slot >= 0 && slot < this.#nextRampSlot) {
			this.#freeRampSlots.push(slot);
		}
	}

	releasePaletteSlot(slot: number): void {
		if (typeof slot === 'number' && slot >= 0 && slot < this.#nextPaletteSlot) {
			this.#freePaletteSlots.push(slot);
		}
	}

	allocateSizeSlot(): number {
		if (this.#freeSizeSlots.length > 0) {
			return this.#freeSizeSlots.pop()!;
		}

		if (this.#nextSizeSlot >= this.#maxSizeSlots) {
			throw new Error(`Size scale limit exceeded (${this.#maxSizeSlots}).`);
		}

		return this.#nextSizeSlot++;
	}

	releaseSizeSlot(slot: number): void {
		if (typeof slot === 'number' && slot >= 0 && slot < this.#nextSizeSlot) {
			this.#freeSizeSlots.push(slot);
		}
	}

	// ============================================================
	// DEBUG STATS
	// ============================================================

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
	// SCALE MANAGEMENT
	// ============================================================

	getOrCreateScale(
		name: string,
		type: string = 'linear',
		config: Record<string, unknown> = {},
		chartId: string | null = null
	): AnyScaleState {
		let scaleCreated = false;

		// Wrap map operations in untrack() to prevent SvelteMap reads from creating
		// reactive dependencies when called from $effect blocks (MarkColor, MarkSize, etc.)
		const scale = untrack(() => {
			let key: string;

			if (type === 'color') {
				// Color scales: key by field + render type only (scheme and transform
				// are mutable state). Transform types (log/symlog/sqrt/pow) are all
				// continuous — they share one cache entry per field and update the
				// normalization via setTransform().
				const scaleType = (config.type as string) || 'sequential';
				const keyType = isTransformType(scaleType) ? 'sequential' : scaleType;
				key = `${name}-color-${keyType}`;
			} else {
				// Other scales: key by full config (padding, align, etc. matter)
				const configKey = Object.keys(config).length > 0 ? `-${stableStringify(config)}` : '';
				key = `${name}-${type}${configKey}`;
			}

			// Dynamic Map creation
			if (!this.scales[type]) {
				this.scales[type] = new SvelteMap();
			}

			if (!this.scales[type].has(key)) {
				scaleCreated = true;
				// Factory Logic
				if (['linear', 'pow', 'identity'].includes(type)) {
					this.scales[type].set(
						key,
						new LinearScaleState(name, undefined, type, undefined, config, this.#gpuCoordinator)
					);
				} else if (type === 'log') {
					this.scales[type].set(
						key,
						new LogScaleState(name, undefined, 'log', undefined, config, this.#gpuCoordinator)
					);
				} else if (type === 'symlog') {
					this.scales[type].set(
						key,
						new SymlogScaleState(
							name,
							undefined,
							'symlog',
							undefined,
							{ ...config, constant: config.constant as number | undefined },
							this.#gpuCoordinator
						)
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
							paddingInner:
								(config.paddingInner as number | undefined) ?? (type === 'point' ? 1 : 0.1),
							paddingOuter: (config.paddingOuter as number | undefined) ?? 0.1,
							padding: (config.padding as number | undefined) ?? 0.1,
							align: (config.align as number | undefined) ?? 0.5,
							sourceField: config.sourceField as string | undefined,
							registry: this,
							// Step 5 C3: how a reorder reaches the animation loop.
							gpuCoordinator: this.#gpuCoordinator
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
								type: scaleType as ColorScaleType,
								scheme: (config.scheme as string | undefined) || defaultScheme,
								domain: (config.domain as number[] | undefined) || [],
								reverse: (config.reverse as boolean | undefined) ?? false,
								midpoint: config.midpoint as number | undefined,
								constant: config.constant as number | undefined,
								exponent: config.exponent as number | undefined
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
								domain: (config.domain as number[] | undefined) || [],
								range: (config.range as [number, number] | undefined) || [2, 12]
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
							.domain(['Adelie', 'Gentoo', 'Chinstrap']) as unknown as AnyScaleState
					);
				} else {
					// Fallback
					this.scales[type].set(
						key,
						new LinearScaleState(name, undefined, 'linear', undefined, config, this.#gpuCoordinator)
					);
				}
			}

			return this.scales[type].get(key);
		});

		if (chartId && scale) {
			untrack(() => {
				if (!this.scaleUsage.has(scale)) {
					this.scaleUsage.set(scale, new Set());
				}

				const chartIds = this.scaleUsage.get(scale)!;
				if (!chartIds.has(chartId)) {
					chartIds.add(chartId);
					// Update render-loop metadata directly (no full topology rebuild)
					const inst = scale as unknown as { _affectedChartsArray?: string[] };
					if (inst._affectedChartsArray) {
						inst._affectedChartsArray = Array.from(chartIds);
					}
				}
			});
		}

		// Only rebuild topology when a new scale enters the SSBO layout
		if (scaleCreated) {
			this.#notifyTopologyChange();
		}

		return scale;
	}

	/**
	 * Count `chartId` as a user of `scale`, for a holder that did not obtain it
	 * through getOrCreateScale (§27.2).
	 *
	 * The refcount is what keeps a scale alive, and until now it was only ever
	 * incremented by the call that CREATED the scale. A component handed an
	 * existing instance by reference was therefore invisible to it — and a
	 * faceted container guarantees exactly that shape: it obtains the facet
	 * scale under its own chart id, hands the object to its cells, then stops
	 * being a chart itself. Its usage drops to zero while every cell is still
	 * using the object, and deregisterChart destroys it, drops it from
	 * scaleUsage and removes it from storage. §25.3 cost three stacked bugs to
	 * that, and the coordinator half — an evicted scale being invisible to
	 * #scaleIdToInstance and #scaleArray — was never fixed, only contained by
	 * holding the instance directly.
	 *
	 * Idempotent, and the exact inverse of deregisterChart, so a holder can pair
	 * them across its own lifecycle.
	 */
	registerChart(scale: AnyScaleState, chartId: string): void {
		if (!scale || !chartId) return;

		untrack(() => {
			if (!this.scaleUsage.has(scale)) {
				this.scaleUsage.set(scale, new Set());
			}
			const chartIds = this.scaleUsage.get(scale)!;
			if (chartIds.has(chartId)) return;

			chartIds.add(chartId);
			const inst = scale as unknown as { _affectedChartsArray?: string[] };
			if (inst._affectedChartsArray) {
				inst._affectedChartsArray = Array.from(chartIds);
			}
		});
	}

	deregisterChart(scale: AnyScaleState, chartId: string): void {
		if (!scale || !chartId) return;

		untrack(() => {
			if (this.scaleUsage.has(scale)) {
				const usage = this.scaleUsage.get(scale)!;
				if (usage.delete(chartId)) {
					if (usage.size === 0) {
						// Scale destroyed — topology changes (SSBO layout shifts)
						if (scale.destroy) scale.destroy();
						this.scaleUsage.delete(scale);
						this._removeScaleFromStorage(scale);
						this.#notifyTopologyChange();
					} else {
						// Scale survives — just update render-loop metadata
						const inst = scale as unknown as { _affectedChartsArray?: string[] };
						if (inst._affectedChartsArray) {
							inst._affectedChartsArray = Array.from(usage);
						}
					}
				}
			}
		});
	}

	removeChartUsage(chartId: string): void {
		if (!chartId) return;

		untrack(() => {
			let scaleDestroyed = false;

			for (const [scale, usageSet] of this.scaleUsage) {
				if (usageSet.has(chartId)) {
					usageSet.delete(chartId);

					if (usageSet.size === 0) {
						if (scale.destroy) scale.destroy();
						this.scaleUsage.delete(scale);
						this._removeScaleFromStorage(scale);
						scaleDestroyed = true;
					} else {
						// Update render-loop metadata directly
						const inst = scale as unknown as { _affectedChartsArray?: string[] };
						if (inst._affectedChartsArray) {
							inst._affectedChartsArray = Array.from(usageSet);
						}
					}
				}
			}

			if (scaleDestroyed) {
				this.#notifyTopologyChange();
			}
		});
	}

	_removeScaleFromStorage(scaleInstance: AnyScaleState): void {
		// Release GPU slots if this is a color or size scale
		if ('gpuSlots' in scaleInstance && typeof scaleInstance.gpuSlots === 'object') {
			const slots = scaleInstance.gpuSlots as GPUSlots;

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

	invalidateChartsUsingScale(scale: AnyScaleState): void {
		if (!this.#gpuCoordinator) return;

		untrack(() => {
			const chartIds = this.scaleUsage.get(scale);
			if (!chartIds || chartIds.size === 0) return;

			for (const chartId of chartIds) {
				this.#gpuCoordinator!.invalidateChart(chartId);
			}
		});
	}

	/**
	 * Look up a scale by name/type/config without creating it.
	 * Returns null if no matching scale exists. The read on the
	 * SvelteMap is reactive, so callers inside $effect will re-run
	 * when the scale is later created.
	 */
	findScale(
		name: string,
		type: string,
		config: Record<string, unknown> = {}
	): AnyScaleState | null {
		const bucket = this.scales[type];
		if (!bucket) return null;
		const configKey = Object.keys(config).length > 0 ? `-${stableStringify(config)}` : '';
		const key = `${name}-${type}${configKey}`;
		return bucket.get(key) ?? null;
	}

	getScaleByField(field: string, type: string): AnyScaleState | null {
		const scaleMap = this.scales[type];
		if (!scaleMap) return null;
		for (const [_key, scale] of scaleMap) {
			const name = 'field' in scale ? scale.field : 'name' in scale ? scale.name : null;
			if (name === field) return scale as AnyScaleState;
		}
		return null;
	}
}

export function setScaleRegistry(): ScaleRegistry {
	const state = new ScaleRegistry();
	return setContext('scale-registry', state);
}

export function getScaleState(
	name: string,
	type: string = 'linear',
	config: Record<string, unknown> = {},
	chartId: string | null = null
): AnyScaleState | null {
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	if (!scaleRegistry) {
		console.error('No Registry');
		return null;
	}
	return scaleRegistry.getOrCreateScale(name, type, config, chartId);
}
