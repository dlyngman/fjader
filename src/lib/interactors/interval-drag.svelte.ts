import { BrushState1D, BrushState2D } from './brush-state.svelte';
import { closeTo, isDragging, scaleBrushExtent1D, scaleBrushExtent2D } from './brush-utils';
import type { BrushHandle } from './brush-utils';
import type { ChartContext, D3Scale } from '$lib/types';

/** A cell's scale for one axis (continuous: it inverts pixels to data). */
export type DragScale = D3Scale;

/** What a drag writes: the selection a brush holds, and its removal. */
export interface DragSink<R extends (...args: number[]) => void> {
	/** The range changed (deduplicated, min before max): write the clause. */
	range: R;
	/** The range is gone: take the clause down. */
	clear(): void;
}

export type Range1D = (min: number, max: number) => void;
export type Range2D = (x0: number, x1: number, y0: number, y1: number) => void;

/** Plain `{ domain }` as the brush state validates against. */
const asScale = (domain: ArrayLike<number>) => ({ domain: () => [domain[0], domain[1]] });

/**
 * A one-axis brush's drag, held once per chart and driven by its cells.
 *
 * The range is in data space, so every cell draws it with its own scale. A drag
 * belongs to the cell that pressed (`owner`, its chart context): a press in
 * another cell is declined until it ends, and moves or releases from another
 * cell are not its own. Pointer capture stays with the cell, which owns the
 * element. Allocation-free per move.
 */
export class IntervalDrag1D {
	readonly brush = new BrushState1D();
	#sink: DragSink<Range1D>;
	#owner: object | null = null;
	#anchor = 0;
	#hasDragged = false;
	#lastMin: number | null = null;
	#lastMax: number | null = null;

	constructor(sink: DragSink<Range1D>) {
		this.#sink = sink;
	}

	/** Whether `owner` (a cell) holds the drag. */
	owns(owner: object): boolean {
		return this.#owner === owner;
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
			const fixed = (brush.resizeEdge === 'start' ? brush.dataMax : brush.dataMin) as number;
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

	/** The owner's press was re-routed (pan mode) or its cell went away: keep the drag as it stands. */
	abandon(owner: object): void {
		if (owner !== this.#owner) return;
		this.#owner = null;
		this.#endDrag();
	}

	/** Shift+wheel on the rectangle: scale it about its centre. */
	zoom(scaleFactor: number): void {
		const { brush } = this;
		if (!brush.active) return;
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
		if (this.brush.active && !this.brush.validate(asScale(domain), 'linear')) this.clear();
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
		this.#lastMin = min;
		this.#lastMax = max;
		this.#sink.range(min, max);
	}

	clear(): void {
		this.brush.clear();
		this.#lastMin = null;
		this.#lastMax = null;
		this.#sink.clear();
	}

	#endDrag(): void {
		if (this.brush.phase !== 'idle') {
			this.emit();
			this.brush.phase = 'idle';
			this.brush.resizeEdge = null;
		}
		this.#hasDragged = false;
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
	/** The last written range (x0, x1, y0, y1); NaN: none. */
	readonly #last = [NaN, NaN, NaN, NaN];

	constructor(sink: DragSink<Range2D>) {
		this.#sink = sink;
	}

	owns(owner: object): boolean {
		return this.#owner === owner;
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
			const corner = brush.resizeCorner;
			const edge = brush.x.resizeEdge || brush.y.resizeEdge;
			if (corner || edge === 'left' || edge === 'right') {
				const right = corner ? corner.includes('e') : edge === 'right';
				const fixed = (right ? brush.x.dataMin : brush.x.dataMax) as number;
				const at = xScale.invert!(x);
				brush.x.setExtent(Math.min(fixed, at), Math.max(fixed, at));
			}
			if (corner || edge === 'top' || edge === 'bottom') {
				const bottom = corner ? corner.includes('s') : edge === 'bottom';
				const fixed = (bottom ? brush.y.dataMax : brush.y.dataMin) as number;
				const at = yScale.invert!(y);
				brush.y.setExtent(Math.min(fixed, at), Math.max(fixed, at));
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
		this.#endDrag();
	}

	zoom(scaleFactor: number): void {
		const { brush } = this;
		if (!brush.active) return;
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
		const xBad = xDomain != null && !brush.x.validate(asScale(xDomain), 'linear');
		const yBad = yDomain != null && !brush.y.validate(asScale(yDomain), 'linear');
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
		last[0] = x0;
		last[1] = x1;
		last[2] = y0;
		last[3] = y1;
		this.#sink.range(x0, x1, y0, y1);
	}

	clear(): void {
		this.brush.clear();
		this.#last.fill(NaN);
		this.#sink.clear();
	}

	#endDrag(): void {
		const { brush } = this;
		if (brush.phase !== 'idle') {
			this.emit();
			brush.phase = 'idle';
			brush.resizeCorner = null;
			brush.x.resizeEdge = null;
			brush.y.resizeEdge = null;
		}
		this.#hasDragged = false;
	}
}

/**
 * What a brush declaration holds once for its chart and hands to each of its
 * cells: the drag, and the cell whose pixels the selection is measured in.
 */
export interface IntervalShared<D> {
	readonly drag: D;
	/**
	 * The cell that last activated the brush or pressed in it, or null before
	 * any did. Its inner size is the brush's pixel extent for preagg (bins per
	 * pixel): a facet cell is smaller than the chart, and cells measure
	 * themselves, so only a cell can say. Unfaceted, it is the one cell.
	 */
	activeCell: ChartContext | null;
	/** The registration's activator. */
	readonly activate: () => void;
}
