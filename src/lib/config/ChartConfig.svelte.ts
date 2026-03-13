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
import type { LODController } from '$lib/lod';

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

// ---- Snapshot type for undo/redo ----

type ChannelSnapshot = Map<string, Map<string, unknown>>;

interface UndoEntry {
	description?: string;
	snapshot: ChannelSnapshot;
}

// ---- ChartConfig ----

export class ChartConfig {
	/** Overridable channels per mark, for reset support. */
	#channels = new Map<string, Map<string, Overridable<unknown>>>();

	/** Reactive entries — downstream reads trigger on property access. */
	#entries: Map<string, MarkEntry> = $state(new Map());

	/** LOD controllers per mark — single registration point for palette + TooltipManager. */
	#lodControllers = new Map<string, LODController>();

	/** Preview stack — records previous values for cancel. */
	#previewStack: Array<{ id: string; key: string; prev: unknown }> = [];

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
		this.#lodControllers.delete(id);
	}

	// ---- LODController registration ----

	/** Register a mark's LODController. Called by mark components after creation. */
	registerLodController(markId: string, controller: LODController): void {
		this.#lodControllers.set(markId, controller);
	}

	/** Unregister a mark's LODController. Called on controller destroy. */
	unregisterLodController(markId: string): void {
		this.#lodControllers.delete(markId);
	}

	/** Get LODController for a mark — palette reads runtime state, TooltipManager delegates here. */
	getLodController(markId: string): LODController | undefined {
		return this.#lodControllers.get(markId);
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

	/** Preview a property change. Renders immediately; cancelPreview reverts. */
	beginPreview(id: string, key: string, value: unknown): void {
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
			const entry = this.#entries.get(id);
			if (entry) (entry as Record<string, unknown>)[key] = prev;
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
		this.#undoStack.push({ description, snapshot: this.#takeSnapshot() });
		this.#redoStack = [];
	}

	/** Undo to the last checkpoint. */
	undo(): boolean {
		const prev = this.#undoStack.pop();
		if (!prev) return false;
		this.#redoStack.push({ snapshot: this.#takeSnapshot() });
		this.#restoreSnapshot(prev.snapshot);
		return true;
	}

	/** Redo the last undone change. */
	redo(): boolean {
		const next = this.#redoStack.pop();
		if (!next) return false;
		this.#undoStack.push({ snapshot: this.#takeSnapshot() });
		this.#restoreSnapshot(next.snapshot);
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

	// ---- Read access ----

	/** All mark entries — reactive, updates when marks added/removed. */
	get entries(): Map<string, MarkEntry> {
		return this.#entries;
	}
}
