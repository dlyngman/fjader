/**
 * Where a chart's plot area sits on its canvas, in device pixels.
 *
 * The canvas covers the whole chart cell, margins included, so text can be
 * drawn in the margins (axis labels, titles, labels outside a bar). Marks
 * draw inside the plot area only. Their pass sets a VIEWPORT on the plot, so
 * clip space spans the plot exactly as it did when the canvas was the plot,
 * and every shader's pixels-to-clip conversion (`frameUniforms.resolution`)
 * stays as it was. A SCISSOR on the same rectangle clips what the viewport
 * does not: geometry past the plot edge, such as a dot's quad at the border.
 *
 * The viewport is in floats and unrounded: `width` is the plot's width times
 * the device pixel ratio, the same number the frame uniforms carry as
 * `resolution` and `rangeMax`, so pixel p of a shader lands on device pixel
 * x + p. The scissor is integers, rounded to the nearest pixel edge and
 * clamped to the texture.
 */

/** The plot area within the chart cell, in CSS pixels. */
export interface PlotRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A plot's viewport (floats) and scissor (integers), in device pixels. */
export interface PlotViewport {
	x: number;
	y: number;
	width: number;
	height: number;
	scissorX: number;
	scissorY: number;
	scissorWidth: number;
	scissorHeight: number;
	/** False when the plot has no pixels on the texture: draw nothing. */
	drawable: boolean;
}

export function emptyPlotViewport(): PlotViewport {
	return {
		x: 0,
		y: 0,
		width: 0,
		height: 0,
		scissorX: 0,
		scissorY: 0,
		scissorWidth: 0,
		scissorHeight: 0,
		drawable: false
	};
}

/**
 * Fill `out` with `rect`'s viewport and scissor at `dpr`, on a texture of
 * `textureWidth` × `textureHeight`. Writes into `out` rather than returning a
 * new object: it runs on every resize and its result is read every frame.
 */
export function computePlotViewport(
	rect: PlotRect,
	dpr: number,
	textureWidth: number,
	textureHeight: number,
	out: PlotViewport
): PlotViewport {
	const x = Math.max(0, rect.x * dpr);
	const y = Math.max(0, rect.y * dpr);
	// Never past the texture's edge: WebGPU rejects a viewport that is. The
	// texture is the cell rounded up, so this only trims rounding.
	const width = Math.max(0, Math.min(rect.width * dpr, textureWidth - x));
	const height = Math.max(0, Math.min(rect.height * dpr, textureHeight - y));
	out.x = x;
	out.y = y;
	out.width = width;
	out.height = height;

	const sx0 = Math.min(textureWidth, Math.round(x));
	const sy0 = Math.min(textureHeight, Math.round(y));
	const sx1 = Math.min(textureWidth, Math.round(x + width));
	const sy1 = Math.min(textureHeight, Math.round(y + height));
	out.scissorX = sx0;
	out.scissorY = sy0;
	out.scissorWidth = Math.max(0, sx1 - sx0);
	out.scissorHeight = Math.max(0, sy1 - sy0);
	out.drawable = width >= 1 && height >= 1 && out.scissorWidth > 0 && out.scissorHeight > 0;
	return out;
}
