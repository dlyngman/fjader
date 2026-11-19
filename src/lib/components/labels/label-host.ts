/**
 * What a mark offers the labels attached to it (`<Labels>` as its child).
 *
 * Two halves, from the two components that know them:
 *
 * - The MARK (BarMarkY, …): its rows, as its lifecycle holds them, the axis
 *   its measure runs along with the measure itself, and a way to add a column
 *   to its query, for label text the mark does not otherwise select.
 * - Its RENDERER (Rects, …): the GPU side. Its record (gpu/placement.ts), which
 *   says where each drawn row is and how opaque, a slot channel per label layer
 *   written through the renderer so rebin holds and cuts carry it like the
 *   mark's colour, and the mark's colour settings for `inherit` and `contrast`.
 *
 * A label never queries and never places anything itself: it reads both
 * halves. So it is where its mark is on every frame, through morphs,
 * reorders, rebins and the entrance, by construction.
 */

import type { FieldRef } from '$lib/types';
import type { BaseGPURenderer } from '$lib/components/rendering/BaseGPURenderer.svelte';

export const LABEL_MARK_HOST = 'label-mark-host';

/** Where on its bar a label sits, along the measure axis (BoxLabels). */
export type LabelAnchor = 'end' | 'inside-end' | 'center' | 'inside-start' | 'start';
/** How a label is coloured (BoxLabels). */
export type LabelFillMode = 'color' | 'inherit' | 'contrast';
export const LABEL_RENDERER_HOST = 'label-renderer-host';

/** The rows a label formats: the mark's processed data. */
export interface LabelRows {
	readonly length: number;
	getColumn(name: string): ArrayLike<unknown> | null;
}

export interface LabelMarkHost {
	/** The mark's rows and their version (a new version: new strings). */
	rows(): LabelRows | null;
	dataVersion(): number;
	/** The axis the measure runs along: a label's anchors are along it. */
	readonly measureAxis: 'x' | 'y';
	/**
	 * Each row's measure as drawn: its base and end on the measure axis (a
	 * stacked segment's own bounds). A label's default text is `end - base`.
	 */
	measure(): { base: ArrayLike<number> | null; end: ArrayLike<number> | null };
	/**
	 * Each row's Other share, as the record carries it (`split`: 0 on a row that
	 * is not an Other bar, 1 + share on one, the part a selection holds), and
	 * which Other rows are flat (`flat`: no part selected, their split a held
	 * position rather than a share: the whole bar). Null when the mark has no
	 * split. A label on an Other bar shows and sits on the selected part.
	 */
	share(): { split: ArrayLike<number>; flat: ArrayLike<number> } | null;
	/**
	 * Add `field` to the mark's query under `alias`, for text the mark does not
	 * select. Returns the removal. Changes the query, so the mark re-runs it.
	 */
	addSelect(alias: string, field: FieldRef): () => void;
	/**
	 * What a `text` naming one of the mark's channels means, or null for a name
	 * that is not one (a column): its measure (`y` on vertical bars, `x` on
	 * horizontal ones, and their bounds, whatever the stack renamed them to),
	 * or the field a channel draws (a category's NAME, where its column holds
	 * ids). Asked of the mark because only it knows its orientation.
	 */
	channel(name: string): LabelChannel | null;
	/**
	 * Each row's key: its category's id on the band axis, or null. A label row
	 * whose key changed between results is another bar, and must not show the
	 * old bar's string while its own is painted (TextSlots).
	 */
	rowKeys(): ArrayLike<number> | null;
}

/** A mark channel as label text: the measure, or a field of the mark's own. */
export type LabelChannel = { kind: 'measure' } | { kind: 'field'; field: FieldRef };

/** How the host colours its rows: what `inherit` and `contrast` read. */
export interface LabelHostColor {
	/** 0: constant, 1: by scale. */
	mode: number;
	scaleIndex: number;
	constant: [number, number, number, number];
}

export interface LabelRendererHost {
	renderer(): BaseGPURenderer | null;
	/** The record's binding: `renderer().bufferFor(recordBinding)`. */
	readonly recordBinding: number;
	/** WGSL of the record struct, `Record`, as the host writes it. */
	readonly recordWGSL: string;
	/** Which kind of record: the label pipeline is built per kind. */
	readonly recordKind: string;
	/** A binding for one label layer's slots, written through the host renderer. */
	allocateSlotChannel(): number;
	releaseSlotChannel(binding: number): void;
	color(): LabelHostColor;
}
