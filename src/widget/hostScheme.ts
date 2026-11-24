/**
 * A widget follows the notebook it sits in, light or dark, not the operating
 * system: JupyterLab and marimo have their own theme setting, which can differ
 * from the system's.
 *
 * The scheme is read from what the widget actually sits on: the first ancestor
 * with a background colour, across shadow roots (marimo renders widgets in one).
 * It is set as `color-scheme` on the widget's root, marked `data-fjader-root`,
 * where theme.css defines the `--fjader-*` colours with `light-dark()`: they
 * follow it, inside a shadow root too, where `:root` rules never apply.
 */

export type Scheme = 'light' | 'dark';

/**
 * Light or dark, for an sRGB colour (0–255): dark below a relative luminance of
 * 0.2, about the luminance of mid grey (#7f7f7f is 0.21).
 */
export function schemeOfColor(r: number, g: number, b: number): Scheme {
	const linear = (c: number) => {
		const s = c / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
	return luminance < 0.2 ? 'dark' : 'light';
}

/** An element's parent, or the host of the shadow root it is the top of. */
function parentOf(node: Element): Element | null {
	if (node.parentElement) return node.parentElement;
	const root = node.getRootNode();
	return root instanceof ShadowRoot ? root.host : null;
}

/**
 * The colour the widget sits on, as seen: its ancestors' backgrounds (not its
 * own), from the nearest down to the first opaque one, blended over each other.
 * A translucent tint (a hover or selection highlight) shades what is under it
 * rather than deciding alone. With no opaque ancestor, the layers are blended
 * over `base` (the page's colour where it has none); null when no ancestor has
 * a background at all. `colorOf` reads a node's background as [r, g, b, a]
 * (0–255); `parent` steps up, across shadow roots.
 */
export function backgroundBehind<N>(
	el: N,
	colorOf: (node: N) => [number, number, number, number],
	parent: (node: N) => N | null,
	base: [number, number, number]
): [number, number, number] | null {
	const layers: [number, number, number, number][] = [];
	for (let node = parent(el); node; node = parent(node)) {
		const color = colorOf(node);
		if (color[3] === 0) continue;
		layers.push(color);
		if (color[3] >= 255) break;
	}
	if (layers.length === 0) return null;
	let [r, g, b] = layers[layers.length - 1][3] >= 255 ? layers.pop()! : base;
	for (let i = layers.length - 1; i >= 0; i--) {
		const [lr, lg, lb, la] = layers[i];
		const a = la / 255;
		r = lr * a + r * (1 - a);
		g = lg * a + g * (1 - a);
		b = lb * a + b * (1 - a);
	}
	return [r, g, b];
}

let pixel: OffscreenCanvasRenderingContext2D | null = null;

/** Any CSS colour as sRGB (0–255), as the browser paints it: oklch(), color() included. */
function rgbOf(css: string): [number, number, number, number] {
	pixel ??= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
	if (!pixel) return [0, 0, 0, 0];
	pixel.clearRect(0, 0, 1, 1);
	pixel.fillStyle = '#0000';
	pixel.fillStyle = css;
	pixel.fillRect(0, 0, 1, 1);
	const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
	return [r, g, b, a];
}

const systemDark = () => matchMedia('(prefers-color-scheme: dark)');

/** The scheme behind `el`: its background's, or the system's where it has none. */
export function hostScheme(el: Element): Scheme {
	const dark = systemDark().matches;
	const behind = backgroundBehind<Element>(
		el,
		(node) => rgbOf(getComputedStyle(node).backgroundColor),
		parentOf,
		// A page without a background of its own shows the browser's: white, or
		// near black in dark mode.
		dark ? [18, 18, 18] : [255, 255, 255]
	);
	if (behind) return schemeOfColor(...behind);
	return dark ? 'dark' : 'light';
}

/**
 * Mark `el` as a widget root and keep its `color-scheme` the host's, as the host's
 * theme changes: a class or attribute on the page's root or body (where notebooks
 * mark their theme: JupyterLab's `data-jp-theme-light`, marimo's classes), or the
 * system's setting. Returns the cleanup.
 */
export function followHostScheme(el: HTMLElement): () => void {
	el.dataset.fjaderRoot = '';
	const apply = () => {
		const scheme = hostScheme(el);
		if (el.style.colorScheme !== scheme) el.style.colorScheme = scheme;
	};
	apply();

	// A theme switch can change many attributes at once: check once after them.
	let pending = false;
	const schedule = () => {
		if (pending) return;
		pending = true;
		setTimeout(() => {
			pending = false;
			apply();
		}, 0);
	};
	const observer = new MutationObserver(schedule);
	for (const node of [document.documentElement, document.body]) {
		if (node) observer.observe(node, { attributes: true });
	}
	const media = systemDark();
	media.addEventListener('change', schedule);
	// Once more when the element is first laid out: one not yet in the page when
	// the widget renders has no background behind it to read, however late its
	// host attaches it.
	const placed = new ResizeObserver((entries) => {
		if (entries.some((e) => e.contentRect.width > 0 || e.contentRect.height > 0)) {
			placed.disconnect();
			schedule();
		}
	});
	placed.observe(el);
	return () => {
		observer.disconnect();
		placed.disconnect();
		media.removeEventListener('change', schedule);
	};
}
