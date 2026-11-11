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

import { SvelteMap } from 'svelte/reactivity';
import { createOverridable, type Overridable } from './overridable.svelte';
import type { SelectionResponse } from '$lib/components/rendering/activity-reads';
import type {
	FieldRef,
	LODConfig,
	SortConfig,
	ColorScheme,
	CurveType,
	NullsResponse,
	Transform
} from '$lib/types';
import type { MarkLODSurface } from '$lib/lod/rung-types';

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
	selection?: string;
	selectionResponse?: SelectionResponse;
	contributeDomain?: boolean;
	nulls?: NullsResponse;
	limit?: number;
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
	inset?: number;
	dx?: number;
	dy?: number;
	fitDomain?: 'x' | 'y' | boolean;
	[key: string]: unknown;
}

/** Prop getters keyed by property name. */
export type PropGetters = Record<string, () => unknown>;

// ---- Chart-level props ----

export interface ChartProps {
	marginTop: number;
	marginRight: number;
	marginBottom: number;
	marginLeft: number;
	[key: string]: unknown;
}

// ---- Snapshot type for undo/redo ----

interface ChartPropsSnapshot {
	values: Map<string, unknown>;
}

type ChannelSnapshot = Map<string, Map<string, unknown>>;

interface UndoEntry {
	description?: string;
	snapshot: ChannelSnapshot;
	chartSnapshot?: ChartPropsSnapshot;
}

// ---- ChartConfig ----

export class ChartConfig {
	/** Overridable channels per mark, for reset support. */
	#channels = new Map<string, Map<string, Overridable<unknown>>>();

	/** Reactive entries — SvelteMap so iteration/size reads are tracked. */
	#entries = new SvelteMap<string, MarkEntry>();

	/** Mark LOD surfaces (rung-based) — per-mark LOD registration for palette + routing. */
	#markLODSurfaces = new Map<string, MarkLODSurface>();

	/** Preview stack — records previous values for cancel. */
	#previewStack: Array<{ id: string; key: string; prev: unknown }> = [];

	/** Chart-level overridable props (margins, etc.). */
	#chartChannels = new Map<string, Overridable<unknown>>();
	#chartProps: ChartProps | null = null;

	/** Undo/redo stacks. */
	#undoStack: UndoEntry[] = [];
	#redoStack: UndoEntry[] = [];

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
	registerMark(id: string, markType: string, propGetters: PropGetters): MarkEntry {
		const existing = this.#entries.get(id);
		if (existing) return existing;

		const channels = new Map<string, Overridable<unknown>>();
		const entry = { id, markType } as MarkEntry;

		for (const [key, getter] of Object.entries(propGetters)) {
			const ch = createOverridable(getter);
			channels.set(key, ch);
			Object.defineProperty(entry, key, {
				get() {
					return ch.current;
				},
				set(v: unknown) {
					ch.current = v;
				},
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

	// ---- Chart-level props ----

	/**
	 * Register chart-level props (margins, etc.) with overridable getters.
	 * Returns the reactive ChartProps object that the layout reads from.
	 */
	registerChart(propGetters: Record<string, () => unknown>): ChartProps {
		if (this.#chartProps) return this.#chartProps;

		const props = {} as ChartProps;
		for (const [key, getter] of Object.entries(propGetters)) {
			const ch = createOverridable(getter);
			this.#chartChannels.set(key, ch);
			Object.defineProperty(props, key, {
				get() {
					return ch.current;
				},
				set(v: unknown) {
					ch.current = v;
				},
				enumerable: true,
				configurable: true
			});
		}
		this.#chartProps = props;
		return props;
	}

	get chartProps(): ChartProps | null {
		return this.#chartProps;
	}

	setChartProp(key: string, value: unknown): void {
		if (!this.#chartChannels.has(key)) return;
		if (this.#chartProps) (this.#chartProps as Record<string, unknown>)[key] = value;
	}

	revertChart(): void {
		for (const ch of this.#chartChannels.values()) {
			ch.reset();
		}
	}

	// ---- MarkLODSurface registration ----

	registerMarkLOD(markId: string, surface: MarkLODSurface): void {
		this.#markLODSurfaces.set(markId, surface);
	}

	unregisterMarkLOD(markId: string): void {
		this.#markLODSurfaces.delete(markId);
	}

	getMarkLOD(markId: string): MarkLODSurface | undefined {
		return this.#markLODSurfaces.get(markId);
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

	// ---- Preview ----

	/** Preview a property change. Renders immediately; cancelPreview reverts.
	 *  Use id='__chart__' for chart-level props. */
	beginPreview(id: string, key: string, value: unknown): void {
		if (id === '__chart__') {
			if (!this.#chartChannels.has(key) || !this.#chartProps) return;
			this.#previewStack.push({
				id,
				key,
				prev: (this.#chartProps as Record<string, unknown>)[key]
			});
			(this.#chartProps as Record<string, unknown>)[key] = value;
			return;
		}
		if (!this.#channels.get(id)?.has(key)) return;
		const entry = this.#entries.get(id);
		if (!entry) return;
		this.#previewStack.push({ id, key, prev: (entry as Record<string, unknown>)[key] });
		(entry as Record<string, unknown>)[key] = value;
	}

	/** Accept the previewed changes. */
	commitPreview(): void {
		this.#previewStack = [];
	}

	/** Revert all previewed changes in reverse order. */
	cancelPreview(): void {
		for (let i = this.#previewStack.length - 1; i >= 0; i--) {
			const { id, key, prev } = this.#previewStack[i];
			if (id === '__chart__') {
				if (this.#chartProps) (this.#chartProps as Record<string, unknown>)[key] = prev;
			} else {
				const entry = this.#entries.get(id);
				if (entry) (entry as Record<string, unknown>)[key] = prev;
			}
		}
		this.#previewStack = [];
	}

	/** Whether a preview is currently active. */
	get previewing(): boolean {
		return this.#previewStack.length > 0;
	}

	// ---- Undo / Redo ----

	/** Snapshot current state for undo. Call before making changes. */
	checkpoint(description?: string): void {
		this.#undoStack.push({
			description,
			snapshot: this.#takeSnapshot(),
			chartSnapshot: this.#takeChartSnapshot()
		});
		this.#redoStack = [];
	}

	/** Undo to the last checkpoint. */
	undo(): boolean {
		const prev = this.#undoStack.pop();
		if (!prev) return false;
		this.#redoStack.push({
			snapshot: this.#takeSnapshot(),
			chartSnapshot: this.#takeChartSnapshot()
		});
		this.#restoreSnapshot(prev.snapshot);
		if (prev.chartSnapshot) this.#restoreChartSnapshot(prev.chartSnapshot);
		return true;
	}

	/** Redo the last undone change. */
	redo(): boolean {
		const next = this.#redoStack.pop();
		if (!next) return false;
		this.#undoStack.push({
			snapshot: this.#takeSnapshot(),
			chartSnapshot: this.#takeChartSnapshot()
		});
		this.#restoreSnapshot(next.snapshot);
		if (next.chartSnapshot) this.#restoreChartSnapshot(next.chartSnapshot);
		return true;
	}

	get canUndo(): boolean {
		return this.#undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.#redoStack.length > 0;
	}

	#takeSnapshot(): ChannelSnapshot {
		const snapshot: ChannelSnapshot = new Map();
		for (const [id, channels] of this.#channels) {
			const values = new Map<string, unknown>();
			for (const [key, ch] of channels) {
				values.set(key, ch.current);
			}
			snapshot.set(id, values);
		}
		return snapshot;
	}

	#restoreSnapshot(snapshot: ChannelSnapshot): void {
		for (const [id, values] of snapshot) {
			const entry = this.#entries.get(id);
			if (!entry) continue;
			for (const [key, value] of values) {
				(entry as Record<string, unknown>)[key] = value;
			}
		}
	}

	#takeChartSnapshot(): ChartPropsSnapshot | undefined {
		if (!this.#chartChannels.size) return undefined;
		const values = new Map<string, unknown>();
		for (const [key, ch] of this.#chartChannels) {
			values.set(key, ch.current);
		}
		return { values };
	}

	#restoreChartSnapshot(snapshot: ChartPropsSnapshot): void {
		if (!this.#chartProps) return;
		for (const [key, value] of snapshot.values) {
			(this.#chartProps as Record<string, unknown>)[key] = value;
		}
	}

	// ---- Read access ----

	/** All mark entries — reactive, updates when marks added/removed. */
	get entries(): Map<string, MarkEntry> {
		return this.#entries;
	}
}
