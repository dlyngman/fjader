import { untrack } from 'svelte';
import { resolveChannel } from './channel-resolution';
import { isNode } from '@uwdata/mosaic-sql';
import { isColorConstant } from '$lib/scales/color-utils';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
import type { ChartContext } from '$lib/types';
import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
import type { MarkSetupState } from './mark-types';

/**
 * MarkSeries - Handles series grouping for connected topology marks (Lines, Areas)
 *
 * Registers an ordinal color scale for the series field via the scale registry.
 * When series and color reference the same field, the registry deduplicates
 * and they share the same scale (same domain, same indices, same legend).
 */
export class MarkSeries {
	#seriesProp: () => string | object | null;
	#channelName: string;
	#setupState: () => MarkSetupState;
	#scaleRegistry: ScaleRegistry;
	#chartContext: ChartContext;
	#colorScale: () => ColorScaleState | null;

	scaleState: ColorScaleState | null = $state(null);

	constructor(
		getSeries: () => string | object | null,
		channelName: string,
		getSetup: () => MarkSetupState,
		scaleRegistry: ScaleRegistry,
		chartContext: ChartContext,
		getColorScale: () => ColorScaleState | null = () => null
	) {
		this.#seriesProp = getSeries;
		this.#channelName = channelName;
		this.#setupState = getSetup;
		this.#scaleRegistry = scaleRegistry;
		this.#chartContext = chartContext;
		this.#colorScale = getColorScale;

		// Lifecycle: Create/Destroy Scale
		// Series grouping is always ordinal
		$effect(() => {
			const field = this.#field;
			// Again when the chart's scales are replaced: the registry dropped
			// this one with the old ChartScales (its GPU slots may already be
			// someone else's), and holding it would write to a destroyed scale.
			void this.#chartContext.scaleGeneration;
			if (field && this.#scaleRegistry) {
				untrack(() => {
					// Use raw field name - registry deduplicates automatically
					// when series and color share the same field
					const scaleName = isNode(field) ? field.toString() : field;

					this.scaleState = this.#scaleRegistry.getOrCreateScale(
						scaleName as string,
						'color',
						{ type: 'ordinal' },
						this.#chartContext.chartId
					) as ColorScaleState;
				});
			} else {
				this.scaleState = null;
			}
		});

		// Lifecycle: Connect to Setup (Domain Discovery)
		$effect(() => {
			const setup = this.#setupState();
			if (setup && this.scaleState && this.#field) {
				setup.setSeriesScale(this.scaleState);
			}
		});
	}

	// The series field (null if not set or if value is a constant CSS color)
	// For z channel, skip isColorConstant check — z is always a field reference
	#field: string | object | null = $derived.by(() => {
		const s = this.#seriesProp();
		if (s == null) return null;
		if (isNode(s)) return s;
		if (typeof s === 'string') {
			if (this.#channelName !== 'z' && isColorConstant(s)) return null;
			return s;
		}
		return null;
	});

	// Field for MarkLifecycle select
	selectField: string | object | null = $derived(this.#field);

	// Resolved Data for GPU - Float32Array of series indices
	data: Float32Array | null = $derived.by(() => {
		const field = this.#field;
		const setup = this.#setupState();

		// No series field - return zeros (single series)
		if (!field) {
			if (!setup?.data?.length) return null;
			return new Float32Array(setup.data.length);
		}

		// Wait for scale and data
		if (!this.scaleState?.ready) return null;
		if (!setup?.data) return null;

		const raw = resolveChannel({
			value: field,
			channel: this.#channelName,
			dataAccessor: setup.data,
			instanceCount: setup.data.length
		});

		if (!raw) {
			return new Float32Array(setup.data.length);
		}

		return this.scaleState.processDataForGPU(raw);
	});

	/**
	 * Whether the renderer reads selection activity through the series scale:
	 * 1 for a `z` of its own, a field that carries ids, so a selection on it
	 * dims the other series. 0 without `z` (the series is the colour, read
	 * already), for a `z` on the colour field (the registry hands both
	 * channels one scale, and reading it twice is a load for nothing), and
	 * before the scale has an identity, while its values are not ids yet.
	 * Routing (MarkLifecycleV2's reads) lists the same field in the same
	 * cases, so the mark dims rather than filters exactly when this is 1.
	 */
	activityMode: number = $derived.by(() => {
		const scale = this.scaleState;
		if (this.#channelName !== 'z' || !scale?.hasIdentity) return 0;
		return scale === this.#colorScale() ? 0 : 1;
	});

	/** The series scale's colour config index, read when `activityMode` is 1. */
	activityScaleIndex: number = $derived(this.scaleState?.gpuIndex ?? 0);

	// Ready when: no field (single series) or scale is ready
	ready: boolean = $derived(!this.#field || (this.scaleState?.ready ?? false));
}
