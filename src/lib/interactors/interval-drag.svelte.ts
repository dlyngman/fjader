import { BrushState1D, BrushState2D } from './brush-state.svelte';
import { closeTo, isDragging, scaleBrushExtent1D, scaleBrushExtent2D } from './brush-utils';
import type { BrushHandle } from './brush-utils';
import type { ChartContext, D3Scale } from '$lib/types';

/** A cell's scale for one axis (continuous: it inverts pixels to data). */
export type DragScale = D3Scale;

/** What a drag writes: the selection a brush holds, and its removal. */
export interface DragSink<R extends (...args: number[]) => boolean> {
	/**
	 * The range changed (deduplicated, min before max): write the clause. True
	 * if it wrote; false (no column yet, destroyed) leaves the range unwritten,
	 * so the next emit of the same range tries again.
	 */
	range: R;
	/** The range is gone: take the clause down. */
	clear(): void;
}

/**
 * The data value of the edge that stays while the other is dragged: the one
 * opposite the moving edge on screen. `lowMoves`: the moving edge is the one
 * at the lower pixel (left, top). By screen, not by data order, so an
 * inverted scale (y) resizes the edge under the handle.
 */
function fixedEdge(lowMoves: boolean, d0: number, d1: number, scale: DragScale): number {
	const d0Low = scale(d0) <= scale(d1);
	return lowMoves === d0Low ? d1 : d0;
}

export type Range1D = (min: number, max: number) => boolean;
export type Range2D = (x0: number, x1: number, y0: number, y1: number) => boolean;

/**
 * A one-axis brush's drag, held once per chart and driven by its cells.
 *
 * The range is in data space, so every cell draws it with its own scale. A drag
 * belongs to the cell that pressed (`owner`, its chart context): a press in
 * another cell is declined until it ends (`held`), and moves or releases from
 * another cell are not its own. Pointer capture stays with the cell, which owns the
 * element. Allocation-free per move.
 */
export class IntervalDrag1D {
	readonly brush = new BrushState1D();
	#sink: DragSink<Range1D>;
	#owner: object | null = null;
	#anchor = 0;
	#hasDragged = false;
	/** The edge a resize keeps (data), from its first move; NaN: none yet. */
	#fixed = NaN;
	#lastMin: number | null = null;
	#lastMax: number | null = null;

	constructor(sink: DragSink<Range1D>) {
		this.#sink = sink;
	}

	/** Whether `owner` (a cell) holds the drag. */
	owns(owner: object): boolean {
		return this.#owner === owner;
	}

	/** Whether any cell holds a drag. */
	get held(): boolean {
		return this.#owner !== null;
	}

	/**
	 * A press at `coord` (inner pixels on the brush's axis), on `handle` of the
	 * rectangle or on the plot (null). False when declined: another cell's drag
	 * is under way.
	 */
	press(owner: object, coord: number, handle: BrushHandle | null): boolean {
		if (this.#owner !== null || this.brush.phase !== 'idle') return false;
		this.#owner = owner;
		this.#anchor = coord;
		this.#hasDragged = false;
		if (handle === 'move') {
			this.brush.phase = 'moving';
		} else if (handle) {
			this.brush.phase = 'resizing';
			this.brush.resizeEdge = handle === 'left' || handle === 'top' ? 'start' : 'end';
		}
		return true;
	}

	/** A move of the owner's pointer to `coord`, through its cell's scale. */
	move(owner: object, coord: number, scale: DragScale): boolean {
		if (owner !== this.#owner) return false;
		const brush = this.brush;
		if (!this.#hasDragged && isDragging(this.#anchor, coord)) {
			this.#hasDragged = true;
			if (brush.phase === 'idle') {
				if (brush.active) this.clear();
				brush.phase = 'creating';
			}
		}
		if (brush.phase === 'creating') {
			brush.setFromScreen(this.#anchor, coord, scale);
		} else if (brush.phase === 'moving') {
			brush.shiftByScreen(coord - this.#anchor, scale);
			this.#anchor = coord;
		} else if (brush.phase === 'resizing') {
			// Kept for the whole drag: dragged past it, min and max just swap.
			if (Number.isNaN(this.#fixed))
				this.#fixed = fixedEdge(
					brush.resizeEdge === 'start',
					brush.dataMin as number,
					brush.dataMax as number,
					scale
				);
			const fixed = this.#fixed;
			const at = scale.invert!(coord);
			brush.setExtent(Math.min(fixed, at), Math.max(fixed, at));
		}
		this.emit();
		return true;
	}

	/** The owner's release. A press that never moved is a click: it clears the brush. */
	release(owner: object): boolean {
		if (owner !== this.#owner) return false;
		this.#owner = null;
		const { brush } = this;
		if (!this.#hasDragged && brush.active && (brush.phase === 'idle' || brush.phase === 'moving')) {
			this.clear();
			return true;
		}
		this.#endDrag();
		return true;
	}

	/**
	 * The owner's press ends without a release: re-routed (pan mode), capture
	 * lost or failed, or its cell went away. The drag stays as it stands, and
	 * writes nothing more: every move already wrote it.
	 */
	abandon(owner: object): void {
		if (owner !== this.#owner) return;
		this.#owner = null;
		this.#idle();
	}

	/** Shift+wheel on the rectangle: scale it about its centre. */
	zoom(scaleFactor: number): void {
		const { brush } = this;
		// Not during a drag: a resize keeps the edge it started from, which a
		// zoom would move under it.
		if (!brush.active || this.#owner !== null) return;
		const a = brush.dataMin as number;
		const b = brush.dataMax as number;
		const [min, max] = scaleBrushExtent1D(Math.min(a, b), Math.max(a, b), scaleFactor);
		brush.setExtent(min, max);
		this.emit();
	}

	/** A range set from outside (a linked chart's pan): drawn, remembered, not written back. */
	setExternal(min: number, max: number): void {
		this.brush.setExtent(min, max);
		this.#lastMin = min;
		this.#lastMax = max;
	}

	/** Clear the brush when the domain no longer holds it. */
	validate(domain: ArrayLike<number>): void {
		// Always as 'linear': fjader's time scales use float offsets, not Dates.
		if (this.brush.active && !this.brush.validate(domain[0], domain[1], 'linear')) this.clear();
	}

	/** Write the range if it changed. */
	emit(): void {
		const { brush } = this;
		if (!brush.active) return;
		const a = brush.dataMin as number;
		const b = brush.dataMax as number;
		const min = Math.min(a, b);
		const max = Math.max(a, b);
		if (closeTo(min, this.#lastMin) && closeTo(max, this.#lastMax)) return;
		if (!this.#sink.range(min, max)) return;
		this.#lastMin = min;
		this.#lastMax = max;
	}

	clear(): void {
		this.brush.clear();
		this.#lastMin = null;
		this.#lastMax = null;
		this.#sink.clear();
	}

	#endDrag(): void {
		if (this.brush.phase !== 'idle') this.emit();
		this.#idle();
	}

	#idle(): void {
		this.brush.phase = 'idle';
		this.brush.resizeEdge = null;
		this.#hasDragged = false;
		this.#fixed = NaN;
	}
}

/** A two-axis brush's drag: as IntervalDrag1D, on a point and a scale per axis. */
export class IntervalDrag2D {
	readonly brush = new BrushState2D();
	#sink: DragSink<Range2D>;
	#owner: object | null = null;
	#anchorX = 0;
	#anchorY = 0;
	#hasDragged = false;
	/** The edges a resize keeps (data), from its first move; NaN: none yet. */
	#fixedX = NaN;
	#fixedY = NaN;
	/** The last written range (x0, x1, y0, y1); NaN: none. */
	readonly #last = [NaN, NaN, NaN, NaN];

	constructor(sink: DragSink<Range2D>) {
		this.#sink = sink;
	}

	owns(owner: object): boolean {
		return this.#owner === owner;
	}

	get held(): boolean {
		return this.#owner !== null;
	}

	press(owner: object, x: number, y: number, handle: BrushHandle | null): boolean {
		const { brush } = this;
		if (this.#owner !== null || brush.phase !== 'idle') return false;
		this.#owner = owner;
		this.#anchorX = x;
		this.#anchorY = y;
		this.#hasDragged = false;
		if (handle === 'move') {
			brush.phase = 'moving';
		} else if (handle) {
			brush.phase = 'resizing';
			if (handle === 'nw' || handle === 'ne' || handle === 'sw' || handle === 'se') {
				brush.resizeCorner = handle;
				brush.x.resizeEdge = null;
				brush.y.resizeEdge = null;
			} else {
				brush.resizeCorner = null;
				brush.x.resizeEdge = handle === 'left' || handle === 'right' ? handle : null;
				brush.y.resizeEdge = handle === 'top' || handle === 'bottom' ? handle : null;
			}
		}
		return true;
	}

	move(owner: object, x: number, y: number, xScale: DragScale, yScale: DragScale): boolean {
		if (owner !== this.#owner) return false;
		const { brush } = this;
		if (!this.#hasDragged && isDragging(this.#anchorX, x, this.#anchorY, y)) {
			this.#hasDragged = true;
			if (brush.phase === 'idle') {
				if (brush.active) this.clear();
				brush.phase = 'creating';
			}
		}
		if (brush.phase === 'creating') {
			brush.x.setFromScreen(this.#anchorX, x, xScale);
			brush.y.setFromScreen(this.#anchorY, y, yScale);
		} else if (brush.phase === 'moving') {
			brush.x.shiftByScreen(x - this.#anchorX, xScale);
			brush.y.shiftByScreen(y - this.#anchorY, yScale);
			this.#anchorX = x;
			this.#anchorY = y;
		} else if (brush.phase === 'resizing') {
			// The edges kept are found by screen side on the first move and kept for
			// the whole drag: dragged past one, min and max just swap.
			const corner = brush.resizeCorner;
			const edge = brush.x.resizeEdge || brush.y.resizeEdge;
			if (corner || edge === 'left' || edge === 'right') {
				const { x: bx } = brush;
				if (Number.isNaN(this.#fixedX))
					this.#fixedX = fixedEdge(
						corner ? corner.includes('w') : edge === 'left',
						bx.dataMin as number,
						bx.dataMax as number,
						xScale
					);
				const at = xScale.invert!(x);
				bx.setExtent(Math.min(this.#fixedX, at), Math.max(this.#fixedX, at));
			}
			if (corner || edge === 'top' || edge === 'bottom') {
				const { y: by } = brush;
				if (Number.isNaN(this.#fixedY))
					this.#fixedY = fixedEdge(
						corner ? corner.includes('n') : edge === 'top',
						by.dataMin as number,
						by.dataMax as number,
						yScale
					);
				const at = yScale.invert!(y);
				by.setExtent(Math.min(this.#fixedY, at), Math.max(this.#fixedY, at));
			}
		}
		this.emit();
		return true;
	}

	release(owner: object): boolean {
		if (owner !== this.#owner) return false;
		this.#owner = null;
		const { brush } = this;
		if (!this.#hasDragged && brush.active && (brush.phase === 'idle' || brush.phase === 'moving')) {
			this.clear();
			return true;
		}
		this.#endDrag();
		return true;
	}

	abandon(owner: object): void {
		if (owner !== this.#owner) return;
		this.#owner = null;
		this.#idle();
	}

	zoom(scaleFactor: number): void {
		const { brush } = this;
		// Not during a drag: a resize keeps the edge it started from, which a
		// zoom would move under it.
		if (!brush.active || this.#owner !== null) return;
		const { x, y } = brush;
		const {
			x: [x0, x1],
			y: [y0, y1]
		} = scaleBrushExtent2D(
			Math.min(x.dataMin as number, x.dataMax as number),
			Math.max(x.dataMin as number, x.dataMax as number),
			Math.min(y.dataMin as number, y.dataMax as number),
			Math.max(y.dataMin as number, y.dataMax as number),
			scaleFactor
		);
		x.setExtent(x0, x1);
		y.setExtent(y0, y1);
		this.emit();
	}

	validate(xDomain: ArrayLike<number> | null, yDomain: ArrayLike<number> | null): void {
		const { brush } = this;
		if (!brush.active) return;
		// Both checked: validate() clears its own axis when out of range.
		const xBad = xDomain != null && !brush.x.validate(xDomain[0], xDomain[1], 'linear');
		const yBad = yDomain != null && !brush.y.validate(yDomain[0], yDomain[1], 'linear');
		if (xBad || yBad) this.clear();
	}

	emit(): void {
		const { brush } = this;
		if (!brush.active) return;
		const { x, y } = brush;
		const x0 = Math.min(x.dataMin as number, x.dataMax as number);
		const x1 = Math.max(x.dataMin as number, x.dataMax as number);
		const y0 = Math.min(y.dataMin as number, y.dataMax as number);
		const y1 = Math.max(y.dataMin as number, y.dataMax as number);
		const last = this.#last;
		if (
			closeTo(x0, last[0]) &&
			closeTo(x1, last[1]) &&
			closeTo(y0, last[2]) &&
			closeTo(y1, last[3])
		)
			return;
		if (!this.#sink.range(x0, x1, y0, y1)) return;
		last[0] = x0;
		last[1] = x1;
		last[2] = y0;
		last[3] = y1;
	}

	clear(): void {
		this.brush.clear();
		this.#last.fill(NaN);
		this.#sink.clear();
	}

	#endDrag(): void {
		if (this.brush.phase !== 'idle') this.emit();
		this.#idle();
	}

	#idle(): void {
		const { brush } = this;
		brush.phase = 'idle';
		brush.resizeCorner = null;
		brush.x.resizeEdge = null;
		brush.y.resizeEdge = null;
		this.#hasDragged = false;
		this.#fixedX = NaN;
		this.#fixedY = NaN;
	}
}

/**
 * The pixels a brush spans, for preagg (bins per pixel): the inner size of the
 * cell that last activated the brush or pressed in it. A facet cell is smaller
 * than the chart, and cells measure themselves, so only a cell can say.
 * Unfaceted, it is the one cell. When that cell goes away, its last size is
 * kept: the clause outlives it, and a 0-pixel view would fail every table.
 */
export class CellPixels {
	#cell: ChartContext | null = null;
	#width = 0;
	#height = 0;

	/** From now on, measure in `cell`. */
	use(cell: ChartContext): void {
		this.#cell = cell;
	}

	/** `cell` is going away: keep its size if it is the one measured in. */
	release(cell: ChartContext): void {
		if (this.#cell !== cell) return;
		this.#width = cell.innerWidth;
		this.#height = cell.innerHeight;
		this.#cell = null;
	}

	/** 0 before any cell activated the brush. */
	get width(): number {
		return this.#cell ? this.#cell.innerWidth : this.#width;
	}

	get height(): number {
		return this.#cell ? this.#cell.innerHeight : this.#height;
	}
}

/**
 * What a brush declaration holds once for its chart and hands to each of its
 * cells: the drag, and the pixels the selection is measured in.
 */
export interface IntervalShared<D> {
	readonly drag: D;
	readonly pixels: CellPixels;
	/** The registration's activator. */
	readonly activate: () => void;
}
