// =============================================================================
// ChartConfig — Per-chart reactive configuration store
//
// Two-layer model using writable $derived:
// - Props are the base layer (Svelte template reactivity)
// - Palette/programmatic writes are overrides (stick until prop changes)
//
// Each entry property is backed by a writable $derived from the mark's prop
// getter. Writing to an entry property overrides the derived value. When the
// prop changes upstream, the override is automatically cleared.
//
// The entry outlives MarkLifecycle — registerMark returns the existing entry
// on re-registration, preventing infinite loops.
// =============================================================================

import { createOverridable, type Overridable } from './overridable.svelte';
import type { Selection } from '@uwdata/mosaic-core';
import type {
	FieldRef,
	LODConfig,
	SortConfig,
	ColorScheme,
	CurveType,
	Transform
} from '$lib/types';

// ---- MarkEntry ----

export interface MarkEntry {
	readonly id: string;
	readonly markType: string;
	table: string;
	x?: FieldRef | null;
	x1?: FieldRef | number | null;
	x2?: FieldRef | null;
	y?: FieldRef | null;
	y1?: FieldRef | number | null;
	y2?: FieldRef | null;
	fill?: FieldRef | null;
	stroke?: FieldRef | string | null;
	z?: FieldRef | null;
	r?: number | string | ((point: { x: number; y: number }) => number) | null;
	radiusRange?: [number, number];
	opacity?: number;
	fillOpacity?: number;
	scheme?: ColorScheme;
	transforms?: Transform[];
	selection?: string | Selection;
	limit?: number;
	filterNulls?: boolean;
	preferredXScaleType?: string | null;
	preferredYScaleType?: string | null;
	sort?: SortConfig | null;
	tooltip?: boolean | { sortTable?: boolean };
	tooltipProximity?: 'x' | 'y' | 'xy';
	tip?: (FieldRef | '*')[] | false;
	lod?: LODConfig | boolean;
	curve?: CurveType;
	strokeWidth?: number;
	dotRadius?: number;
	autoDots?: boolean;
	padding?: number;
	paddingInner?: number;
	paddingOuter?: number;
	align?: number;
	inset?: number;
	dx?: number;
	dy?: number;
	viewportLocalDomain?: boolean;
	[key: string]: unknown;
}

/** Prop getters keyed by property name. */
export type PropGetters = Record<string, () => unknown>;

// ---- ChartConfig ----

export class ChartConfig {
	/** Overridable channels per mark, for reset support. */
	#channels = new Map<string, Map<string, Overridable<unknown>>>();

	/** Reactive entries — downstream reads trigger on property access. */
	#entries: Map<string, MarkEntry> = $state(new Map());

	/**
	 * Register a mark with prop getters for each configurable property.
	 * Returns the reactive entry that the mark reads from.
	 *
	 * Each entry property is a writable $derived backed by the getter.
	 * Writing to entry.fill overrides the derived; when the prop changes
	 * upstream the override is automatically cleared.
	 *
	 * If an entry already exists for this ID (MarkLifecycle recreation),
	 * the existing entry is returned unchanged.
	 */
	registerMark(
		id: string,
		markType: string,
		propGetters: PropGetters
	): MarkEntry {
		const existing = this.#entries.get(id);
		if (existing) return existing;

		const channels = new Map<string, Overridable<unknown>>();
		const entry = { id, markType } as MarkEntry;

		for (const [key, getter] of Object.entries(propGetters)) {
			const ch = createOverridable(getter);
			channels.set(key, ch);
			Object.defineProperty(entry, key, {
				get() { return ch.current; },
				set(v: unknown) { ch.current = v; },
				enumerable: true,
				configurable: true
			});
		}

		this.#channels.set(id, channels);
		this.#entries.set(id, entry);

		return entry;
	}

	unregisterMark(id: string): void {
		this.#entries.delete(id);
		this.#channels.delete(id);
	}

	// ---- Mutation (palette / programmatic) ----

	setMarkProp(id: string, key: string, value: unknown): void {
		if (!this.#channels.get(id)?.has(key)) return;
		const entry = this.#entries.get(id);
		if (entry) (entry as Record<string, unknown>)[key] = value;
	}

	revertMarkProp(id: string, key: string): void {
		const ch = this.#channels.get(id)?.get(key);
		if (ch) ch.reset();
	}

	revertMark(id: string): void {
		const channels = this.#channels.get(id);
		if (!channels) return;
		for (const ch of channels.values()) {
			ch.reset();
		}
	}

	// ---- Read access ----

	/** All mark entries — reactive, updates when marks added/removed. */
	get entries(): Map<string, MarkEntry> {
		return this.#entries;
	}
}
