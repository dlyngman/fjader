import type { ExprNode } from '@uwdata/mosaic-sql';
import { column, sql } from '@uwdata/mosaic-sql';

export const EPS_RELATIVE = 1e-10;
export const EPS_ABSOLUTE = 1e-12;
export const DRAG_THRESHOLD = 3;
export const WHEEL_SENSITIVITY = 0.001;

export function closeTo(a: number | null | undefined, b: number | null | undefined): boolean {
	if (a === b) return true;
	if (a == null || b == null) return false;

	const diff = Math.abs(a - b);

	const scale = Math.max(Math.abs(a), Math.abs(b));
	if (scale > 0) {
		return diff < EPS_RELATIVE * scale;
	}

	return diff < EPS_ABSOLUTE;
}

export function createPanModeHandlers(setActive: (active: boolean) => void): {
	handleKeyDown: (event: KeyboardEvent) => void;
	handleKeyUp: (event: KeyboardEvent) => void;
} {
	const handleKeyDown = (event: KeyboardEvent) => {
		if (event.code === 'Space') {
			setActive(true);
		}
	};

	const handleKeyUp = (event: KeyboardEvent) => {
		if (event.code === 'Space') {
			setActive(false);
		}
	};

	return { handleKeyDown, handleKeyUp };
}

export function scaleBrushExtent1D(
	min: number,
	max: number,
	scaleFactor: number
): [number, number] {
	const center = (min + max) / 2;
	const size = max - min;
	const newSize = size * scaleFactor;
	return [center - newSize / 2, center + newSize / 2];
}

export function scaleBrushExtent2D(
	xMin: number,
	xMax: number,
	yMin: number,
	yMax: number,
	scaleFactor: number
): { x: [number, number]; y: [number, number] } {
	const [newXMin, newXMax] = scaleBrushExtent1D(xMin, xMax, scaleFactor);
	const [newYMin, newYMax] = scaleBrushExtent1D(yMin, yMax, scaleFactor);
	return {
		x: [newXMin, newXMax],
		y: [newYMin, newYMax]
	};
}

export function buildColumnRef(
	field: string | ExprNode | null,
	scaleState: { t0?: Date | null } | null
): ExprNode | null {
	if (!field) return null;
	const isTimeScale = scaleState?.t0 != null;
	if (isTimeScale) {
		const t0Epoch = Math.floor(scaleState!.t0!.getTime() / 1000);
		const expr = typeof field === 'string' ? column(field) : field;
		return sql`CAST((epoch(${expr}) - ${t0Epoch}) AS REAL)`;
	}
	return typeof field === 'string' ? column(field) : field;
}

export function isDragging(
	startX: number,
	currentX: number,
	startY: number = 0,
	currentY: number = 0
): boolean {
	const dx = Math.abs(currentX - startX);
	const dy = Math.abs(currentY - startY);
	return dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD;
}
