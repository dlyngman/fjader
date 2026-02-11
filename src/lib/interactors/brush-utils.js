/**
 * Shared utilities for brush interactors (Interval1D, Interval2D)
 */

import { column, sql } from '@uwdata/mosaic-sql';

/**
 * Relative epsilon for floating point comparison (0.01% tolerance)
 * Works for both tiny values (1e-10) and large values (timestamps)
 */
export const EPS_RELATIVE = 1e-10;

/**
 * Absolute epsilon fallback for values near zero
 */
export const EPS_ABSOLUTE = 1e-12;

/**
 * Drag detection threshold in pixels
 */
export const DRAG_THRESHOLD = 3;

/**
 * Wheel scroll sensitivity multiplier for brush scaling
 */
export const WHEEL_SENSITIVITY = 0.001;

/**
 * Check if two numbers are close enough to be considered equal.
 * Uses relative epsilon for scale-independent comparison,
 * with absolute fallback for values near zero.
 *
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 */
export function closeTo(a, b) {
	if (a === b) return true;
	if (a == null || b == null) return false;

	const diff = Math.abs(a - b);

	// Use relative epsilon scaled to magnitude
	const scale = Math.max(Math.abs(a), Math.abs(b));
	if (scale > 0) {
		return diff < EPS_RELATIVE * scale;
	}

	// Fallback to absolute epsilon for values near zero
	return diff < EPS_ABSOLUTE;
}

/**
 * Create keyboard handlers for Space key pan mode
 * @param {Function} setActive - Callback to set pan mode active state
 * @returns {{ handleKeyDown: Function, handleKeyUp: Function }}
 */
export function createPanModeHandlers(setActive) {
	const handleKeyDown = (event) => {
		if (event.code === 'Space') {
			setActive(true);
		}
	};

	const handleKeyUp = (event) => {
		if (event.code === 'Space') {
			setActive(false);
		}
	};

	return { handleKeyDown, handleKeyUp };
}

/**
 * Scale a 1D brush extent around its center
 * @param {number} min - Current minimum
 * @param {number} max - Current maximum
 * @param {number} scaleFactor - Scale factor (>1 = grow, <1 = shrink)
 * @returns {[number, number]} - New [min, max] extents
 */
export function scaleBrushExtent1D(min, max, scaleFactor) {
	const center = (min + max) / 2;
	const size = max - min;
	const newSize = size * scaleFactor;
	return [center - newSize / 2, center + newSize / 2];
}

/**
 * Scale a 2D brush extent around its center
 * @param {number} xMin - Current X minimum
 * @param {number} xMax - Current X maximum
 * @param {number} yMin - Current Y minimum
 * @param {number} yMax - Current Y maximum
 * @param {number} scaleFactor - Scale factor (>1 = grow, <1 = shrink)
 * @returns {{ x: [number, number], y: [number, number] }} - New extents
 */
export function scaleBrushExtent2D(xMin, xMax, yMin, yMax, scaleFactor) {
	const [newXMin, newXMax] = scaleBrushExtent1D(xMin, xMax, scaleFactor);
	const [newYMin, newYMax] = scaleBrushExtent1D(yMin, yMax, scaleFactor);
	return {
		x: [newXMin, newXMax],
		y: [newYMin, newYMax]
	};
}

/**
 * Build a Mosaic column reference for interval clauses.
 * For time scales, applies the same epoch offset formula as BaseMarkSetup (#applyTimeOffsets):
 *   CAST((epoch(expr) - t0_epoch) AS REAL)
 *
 * @param {string|object} field - Column name or SQL expression
 * @param {object|null} scaleState - Scale state (checked for t0 time offset)
 * @returns {object|null} - Mosaic column reference or SQL expression
 */
export function buildColumnRef(field, scaleState) {
	if (!field) return null;
	const isTimeScale = scaleState?.t0 != null;
	if (isTimeScale) {
		const t0Epoch = Math.floor(scaleState.t0.getTime() / 1000);
		const expr = typeof field === 'string' ? column(field) : field;
		return sql`CAST((epoch(${expr}) - ${t0Epoch}) AS REAL)`;
	}
	return typeof field === 'string' ? column(field) : field;
}

/**
 * Detect if pointer movement exceeds drag threshold
 * @param {number} startX - Starting X coordinate
 * @param {number} currentX - Current X coordinate
 * @param {number} startY - Starting Y coordinate (optional, for 2D)
 * @param {number} currentY - Current Y coordinate (optional, for 2D)
 * @returns {boolean}
 */
export function isDragging(startX, currentX, startY = 0, currentY = 0) {
	const dx = Math.abs(currentX - startX);
	const dy = Math.abs(currentY - startY);
	return dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD;
}
