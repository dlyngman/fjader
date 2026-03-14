// src/lib/scales/color-utils.ts
// Pure utility functions for color parsing and D3 scale creation

import { color } from 'd3-color';
import type { RGBColor, HSLColor } from 'd3-color';
import { scaleOrdinal, scaleSequential, scaleDiverging } from 'd3-scale';
import type { ScaleOrdinal, ScaleSequential, ScaleDiverging } from 'd3-scale';
import {
	// Sequential single-hue
	interpolateBlues,
	interpolateGreens,
	interpolateGreys,
	interpolateOranges,
	interpolatePurples,
	interpolateReds,
	// Sequential multi-hue
	interpolateViridis,
	interpolateInferno,
	interpolateMagma,
	interpolatePlasma,
	interpolateCividis,
	interpolateTurbo,
	interpolateWarm,
	interpolateCool,
	interpolateCubehelixDefault,
	interpolateBuGn,
	interpolateBuPu,
	interpolateGnBu,
	interpolateOrRd,
	interpolatePuBuGn,
	interpolatePuBu,
	interpolatePuRd,
	interpolateRdPu,
	interpolateYlGnBu,
	interpolateYlGn,
	interpolateYlOrBr,
	interpolateYlOrRd,
	// Diverging
	interpolateBrBG,
	interpolatePRGn,
	interpolatePiYG,
	interpolatePuOr,
	interpolateRdBu,
	interpolateRdGy,
	interpolateRdYlBu,
	interpolateRdYlGn,
	interpolateSpectral,
	// Cyclical
	interpolateRainbow,
	interpolateSinebow,
	// Ordinal
	schemeCategory10,
	schemeAccent,
	schemeDark2,
	schemePaired,
	schemePastel1,
	schemePastel2,
	schemeSet1,
	schemeSet2,
	schemeSet3,
	schemeTableau10
} from 'd3-scale-chromatic';
import type { ColorScaleType } from '$lib/types';

/** RGBA tuple with values in the 0–1 range. */
export type RGBA = [number, number, number, number];

/** Default fill color for area/rect marks (steel blue). */
export const DEFAULT_FILL_COLOR: RGBA = [0.2, 0.4, 0.8, 1.0];

/** Default stroke color for dot/line marks (forest green). */
export const DEFAULT_STROKE_COLOR: RGBA = [0.13, 0.55, 0.13, 1.0];

type Interpolator = (t: number) => string;

/**
 * Set of valid CSS named colors for constant color detection.
 * Used by MarkLifecycle to distinguish "red" (constant) from "price" (field).
 */
export const CSS_COLOR_NAMES: Set<string> = new Set([
	'aliceblue',
	'antiquewhite',
	'aqua',
	'aquamarine',
	'azure',
	'beige',
	'bisque',
	'black',
	'blanchedalmond',
	'blue',
	'blueviolet',
	'brown',
	'burlywood',
	'cadetblue',
	'chartreuse',
	'chocolate',
	'coral',
	'cornflowerblue',
	'cornsilk',
	'crimson',
	'cyan',
	'darkblue',
	'darkcyan',
	'darkgoldenrod',
	'darkgray',
	'darkgreen',
	'darkgrey',
	'darkkhaki',
	'darkmagenta',
	'darkolivegreen',
	'darkorange',
	'darkorchid',
	'darkred',
	'darksalmon',
	'darkseagreen',
	'darkslateblue',
	'darkslategray',
	'darkslategrey',
	'darkturquoise',
	'darkviolet',
	'deeppink',
	'deepskyblue',
	'dimgray',
	'dimgrey',
	'dodgerblue',
	'firebrick',
	'floralwhite',
	'forestgreen',
	'fuchsia',
	'gainsboro',
	'ghostwhite',
	'gold',
	'goldenrod',
	'gray',
	'green',
	'greenyellow',
	'grey',
	'honeydew',
	'hotpink',
	'indianred',
	'indigo',
	'ivory',
	'khaki',
	'lavender',
	'lavenderblush',
	'lawngreen',
	'lemonchiffon',
	'lightblue',
	'lightcoral',
	'lightcyan',
	'lightgoldenrodyellow',
	'lightgray',
	'lightgreen',
	'lightgrey',
	'lightpink',
	'lightsalmon',
	'lightseagreen',
	'lightskyblue',
	'lightslategray',
	'lightslategrey',
	'lightsteelblue',
	'lightyellow',
	'lime',
	'limegreen',
	'linen',
	'magenta',
	'maroon',
	'mediumaquamarine',
	'mediumblue',
	'mediumorchid',
	'mediumpurple',
	'mediumseagreen',
	'mediumslateblue',
	'mediumspringgreen',
	'mediumturquoise',
	'mediumvioletred',
	'midnightblue',
	'mintcream',
	'mistyrose',
	'moccasin',
	'navajowhite',
	'navy',
	'oldlace',
	'olive',
	'olivedrab',
	'orange',
	'orangered',
	'orchid',
	'palegoldenrod',
	'palegreen',
	'paleturquoise',
	'palevioletred',
	'papayawhip',
	'peachpuff',
	'peru',
	'pink',
	'plum',
	'powderblue',
	'purple',
	'rebeccapurple',
	'red',
	'rosybrown',
	'royalblue',
	'saddlebrown',
	'salmon',
	'sandybrown',
	'seagreen',
	'seashell',
	'sienna',
	'silver',
	'skyblue',
	'slateblue',
	'slategray',
	'slategrey',
	'snow',
	'springgreen',
	'steelblue',
	'tan',
	'teal',
	'thistle',
	'tomato',
	'turquoise',
	'violet',
	'wheat',
	'white',
	'whitesmoke',
	'yellow',
	'yellowgreen',
	'transparent'
]);

// Pre-compiled regex for RGB parsing
const RGB_REGEX =
	/rgba?\(\s*([0-9.]+%?)\s*[,\s]\s*([0-9.]+%?)\s*[,\s]\s*([0-9.]+%?)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)/;

/**
 * Parse any CSS color string to [r, g, b, a] array with values 0-1.
 * Supports: hex (#rgb, #rrggbb, #rrggbbaa), rgb(), rgba(), hsl(), hsla(), named colors.
 */
export function parseColorToRGBA(colorStr: string): RGBA {
	if (!colorStr || typeof colorStr !== 'string') {
		return [0, 0, 0, 1]; // Default to black
	}

	const trimmed = colorStr.trim().toLowerCase();

	// Handle hex colors
	if (trimmed.startsWith('#')) {
		return parseHexColor(trimmed);
	}

	// Handle rgb/rgba
	if (trimmed.startsWith('rgb')) {
		return parseRGBColor(trimmed);
	}

	// Handle hsl/hsla and named colors using D3
	const d3Color = color(trimmed) as RGBColor | HSLColor | null;
	if (d3Color) {
		const rgb = d3Color.rgb();
		return [rgb.r / 255, rgb.g / 255, rgb.b / 255, rgb.opacity];
	}

	// Fallback to black
	console.warn(`Unable to parse color: ${colorStr}`);
	return [0, 0, 0, 1];
}

/**
 * Parse hex color string to RGBA array.
 */
function parseHexColor(hex: string): RGBA {
	// Remove #
	let h = hex.slice(1);

	// Expand shorthand (#rgb → #rrggbb, #rgba → #rrggbbaa)
	if (h.length === 3) {
		h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
	} else if (h.length === 4) {
		h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
	}

	const r = parseInt(h.slice(0, 2), 16) / 255;
	const g = parseInt(h.slice(2, 4), 16) / 255;
	const b = parseInt(h.slice(4, 6), 16) / 255;
	const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;

	return [r, g, b, a];
}

/**
 * Parse rgb() or rgba() color string to RGBA array.
 */
function parseRGBColor(rgb: string): RGBA {
	const match = rgb.match(RGB_REGEX);

	if (!match) {
		return [0, 0, 0, 1];
	}

	const parseComponent = (val: string): number => {
		if (val.endsWith('%')) {
			return parseFloat(val) / 100;
		}
		return parseFloat(val) / 255;
	};

	const parseAlpha = (val: string | undefined): number => {
		if (!val) return 1;
		if (val.endsWith('%')) {
			return parseFloat(val) / 100;
		}
		return parseFloat(val);
	};

	return [
		parseComponent(match[1]),
		parseComponent(match[2]),
		parseComponent(match[3]),
		parseAlpha(match[4])
	];
}

/**
 * D3 color scheme mappings.
 */
const SEQUENTIAL_SCHEMES: Record<string, Interpolator> = {
	// Single-hue
	blues: interpolateBlues,
	greens: interpolateGreens,
	greys: interpolateGreys,
	oranges: interpolateOranges,
	purples: interpolatePurples,
	reds: interpolateReds,

	// Multi-hue
	viridis: interpolateViridis,
	inferno: interpolateInferno,
	magma: interpolateMagma,
	plasma: interpolatePlasma,
	cividis: interpolateCividis,
	turbo: interpolateTurbo,
	warm: interpolateWarm,
	cool: interpolateCool,
	cubehelixdefault: interpolateCubehelixDefault,

	// Multi-hue sequential
	bugn: interpolateBuGn,
	bupu: interpolateBuPu,
	gnbu: interpolateGnBu,
	orrd: interpolateOrRd,
	pubugn: interpolatePuBuGn,
	pubu: interpolatePuBu,
	purd: interpolatePuRd,
	rdpu: interpolateRdPu,
	ylgnbu: interpolateYlGnBu,
	ylgn: interpolateYlGn,
	ylorbr: interpolateYlOrBr,
	ylorrd: interpolateYlOrRd
};

const DIVERGING_SCHEMES: Record<string, Interpolator> = {
	brbg: interpolateBrBG,
	prgn: interpolatePRGn,
	piyg: interpolatePiYG,
	puor: interpolatePuOr,
	rdbu: interpolateRdBu,
	rdgy: interpolateRdGy,
	rdylbu: interpolateRdYlBu,
	rdylgn: interpolateRdYlGn,
	spectral: interpolateSpectral
};

const CYCLICAL_SCHEMES: Record<string, Interpolator> = {
	rainbow: interpolateRainbow,
	sinebow: interpolateSinebow
};

const ORDINAL_SCHEMES: Record<string, readonly string[]> = {
	category10: schemeCategory10,
	accent: schemeAccent,
	dark2: schemeDark2,
	paired: schemePaired,
	pastel1: schemePastel1,
	pastel2: schemePastel2,
	set1: schemeSet1,
	set2: schemeSet2,
	set3: schemeSet3,
	tableau10: schemeTableau10
};

/**
 * Get the interpolator function for a scheme name.
 * Returns null if scheme is ordinal (discrete colors, not interpolatable).
 */
export function getInterpolator(scheme: string): Interpolator | null {
	const key = scheme.toLowerCase();
	return SEQUENTIAL_SCHEMES[key] || DIVERGING_SCHEMES[key] || CYCLICAL_SCHEMES[key] || null;
}

/**
 * Get the color array for an ordinal scheme.
 */
export function getOrdinalColors(scheme: string): readonly string[] | null {
	const key = scheme.toLowerCase();
	return ORDINAL_SCHEMES[key] || null;
}

/**
 * Determine if a scheme is ordinal (discrete) or continuous.
 */
/**
 * All available scheme names, grouped by type.
 */
export function getAllSchemeNames(): {
	ordinal: string[];
	sequential: string[];
	diverging: string[];
	cyclical: string[];
} {
	return {
		ordinal: Object.keys(ORDINAL_SCHEMES),
		sequential: Object.keys(SEQUENTIAL_SCHEMES),
		diverging: Object.keys(DIVERGING_SCHEMES),
		cyclical: Object.keys(CYCLICAL_SCHEMES)
	};
}

export function getSchemeType(scheme: string): ColorScaleType | null {
	const key = scheme.toLowerCase();
	if (ORDINAL_SCHEMES[key]) return 'ordinal';
	if (SEQUENTIAL_SCHEMES[key]) return 'sequential';
	if (DIVERGING_SCHEMES[key]) return 'diverging';
	if (CYCLICAL_SCHEMES[key]) return 'cyclical';
	return null;
}

/** A D3 scale that maps numeric input to color strings and exposes its domain. */
interface GradientScale {
	(value: number): string;
	domain(): number[];
}

/**
 * Bake a configured D3 scale into a GPU-ready Float32Array.
 * This ensures domain asymmetry, midpoints, and clamping are correctly baked in.
 *
 * The scale's domain logic is preserved: for diverging scales with asymmetric
 * domains (e.g., [-10, 0, 100]), the midpoint color will appear at the correct
 * texture coordinate.
 */
export function bakeGradient(d3Scale: GradientScale, steps: number = 256): Float32Array {
	const result = new Float32Array(steps * 4);

	// Get the input domain from the scale itself
	const domain = d3Scale.domain();
	const min = domain[0];
	const max = domain[domain.length - 1];

	for (let i = 0; i < steps; i++) {
		// Map texture coordinate (0..1) back to data domain
		const t = i / (steps - 1);
		const value = min + t * (max - min);

		// Pass data value through d3Scale - this handles diverging logic, midpoints, etc.
		const c = color(d3Scale(value))!.rgb();

		const idx = i * 4;
		result[idx] = c.r / 255;
		result[idx + 1] = c.g / 255;
		result[idx + 2] = c.b / 255;
		result[idx + 3] = c.opacity;
	}

	return result;
}

interface BakePaletteOptions {
	reverse?: boolean;
}

/**
 * Bake an ordinal palette into a Float32Array for GPU upload.
 * Pads to exactly 32 colors (max palette size).
 */
export function bakePalette(
	schemeOrColors: string | readonly string[],
	options: BakePaletteOptions = {}
): Float32Array {
	const maxColors = 32;
	const result = new Float32Array(maxColors * 4);
	const { reverse = false } = options;

	let colors: readonly string[];
	if (typeof schemeOrColors === 'string') {
		const looked = getOrdinalColors(schemeOrColors);
		if (!looked) {
			console.warn(`Unknown ordinal scheme: ${schemeOrColors}, falling back to tableau10`);
			colors = schemeTableau10;
		} else {
			colors = looked;
		}
	} else {
		colors = schemeOrColors;
	}

	if (reverse) {
		colors = [...colors].reverse();
	}

	// Fill palette, cycling if needed for indices beyond color count
	for (let i = 0; i < maxColors; i++) {
		const c = color(colors[i % colors.length])!.rgb();
		const idx = i * 4;
		result[idx] = c.r / 255;
		result[idx + 1] = c.g / 255;
		result[idx + 2] = c.b / 255;
		result[idx + 3] = c.opacity;
	}

	return result;
}

export type D3ColorScale =
	| ScaleOrdinal<string, string>
	| ScaleSequential<string>
	| ScaleDiverging<string>;

interface CreateD3ScaleOptions {
	reverse?: boolean;
	midpoint?: number;
}

/**
 * Create a D3 scale for a color scheme.
 * Used for legends, CPU-side color lookups, AND as input to bakeGradient.
 */
export function createD3Scale(
	scheme: string,
	domain: number[],
	options: CreateD3ScaleOptions = {}
): D3ColorScale {
	const schemeType = getSchemeType(scheme);
	const { reverse = false, midpoint } = options;

	if (schemeType === 'ordinal') {
		let colors = getOrdinalColors(scheme)!;
		if (reverse) colors = [...colors].reverse();
		return scaleOrdinal<string, string>()
			.domain(domain.map(String))
			.range(colors as string[]);
	}

	// Get interpolator, handle reverse
	let interpolator = getInterpolator(scheme);
	if (!interpolator) {
		console.warn(`Unknown scheme: ${scheme}, falling back to viridis`);
		interpolator = interpolateViridis;
	}

	if (reverse) {
		const original = interpolator;
		interpolator = (t: number) => original(1 - t);
	}

	// Diverging scales use scaleDiverging with 3-point domain
	if (schemeType === 'diverging') {
		const [min, max] = [domain[0], domain[domain.length - 1]];
		const mid = midpoint ?? (min + max) / 2;
		return scaleDiverging(interpolator).domain([min, mid, max]);
	}

	// Sequential and cyclical use scaleSequential
	return scaleSequential(interpolator).domain([domain[0], domain[domain.length - 1]]);
}

/**
 * Check if a string looks like a color value (constant) vs a field name.
 */
export function isColorConstant(value: string): boolean {
	if (!value || typeof value !== 'string') return false;

	const trimmed = value.trim().toLowerCase();

	// Hex color
	if (trimmed.startsWith('#')) return true;

	// RGB/RGBA/HSL/HSLA
	if (trimmed.startsWith('rgb') || trimmed.startsWith('hsl')) return true;

	// Named CSS color
	if (CSS_COLOR_NAMES.has(trimmed)) return true;

	return false;
}
