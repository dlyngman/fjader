import { BaseGPURenderer, type InitConfig } from './BaseGPURenderer.svelte';
import type { GPUCoordinator } from '$lib/gpu';
import type { ChartContext, WebGPUCanvasContext } from '$lib/types';

/**
 * Bringing one mark's GPU renderer up, and keeping it in step with the chart.
 *
 * Every rendering component did this itself, in eight copies that had drifted
 * only in their error strings: poll for the device, construct a
 * `BaseGPURenderer`, await `initialize`, build geometry, register a draw layer.
 * The copies are the reason the pipeline's scale-type dependency could be wrong
 * in one of them and right in the other seven — there was no single place for
 * the rule to live, so there was no single place to fix it.
 *
 * What stays in the component is what actually differs: its geometry buffer,
 * its draw callback, and whatever it seeds its own bindings with. Those arrive
 * as `ready`, which runs once the pipeline exists.
 *
 * WHY THE RENDERER IS EXPOSED RATHER THAN WRAPPED. Components reach into it
 * constantly — `writeAttribute`, `updateInstanceCount`, `instanceCount` in a
 * draw callback — and proxying that surface would be a second API to keep in
 * step with the first. This owns the LIFECYCLE and hands the object over.
 */
export interface RendererHostOptions {
	/** Pipeline cache key component, and the label on its GPU resources. */
	markType: string;
	webGPUContext: WebGPUCanvasContext | null;
	gpuCoordinator: GPUCoordinator;
	chartContext: ChartContext;
	zIndex?: number;
	/**
	 * What to specialise an axis's shader on when the CHART names no type for
	 * it. The chart wins whenever it has one — see `BaseGPURenderer.initialize`
	 * — so this is a fallback, not an override, however it reads at the call
	 * site. ParallelLines passes one for y, which it lays out itself.
	 *
	 * Left unset it is `linear`, which is a guess and is why a mark whose axis
	 * resolves late can compile against the wrong scale.
	 */
	xScaleType?: string;
	yScaleType?: string;
	/** Named in the failure message; defaults to the mark type. */
	label?: string;
}

export interface RendererMount {
	/** Shader, bindings and vertex layout — everything `initialize` needs. */
	init: InitConfig;
	/**
	 * Geometry, layer registration and any seeded bindings. Runs after the
	 * pipeline exists and before the host reports itself ready, so a component's
	 * draw callback is never registered against a renderer that has none.
	 */
	ready?(renderer: BaseGPURenderer): void | Promise<void>;
}

/** How long to wait for the canvas to come up: 100 tries, 50ms apart. */
const DEVICE_POLL_LIMIT = 100;
const DEVICE_POLL_MS = 50;

export class RendererHost {
	/**
	 * The renderer, once it exists. `$state`, so a component's `$derived` and
	 * `$effect` wake when it arrives — which is how every data-writing effect in
	 * a rendering component is gated.
	 */
	renderer: BaseGPURenderer | null = $state(null);
	/** The failure message, if bringing it up threw. */
	error: string | null = $state(null);

	#options: RendererHostOptions;
	#mounted = false;

	/** Construct at the top of a component `<script>`, not inside `onMount`. */
	constructor(options: RendererHostOptions) {
		this.#options = options;
	}

	/**
	 * Wait for the device, then build the renderer. Call once, from `onMount`.
	 *
	 * Resolves when the renderer is usable, or when it is not: a canvas that
	 * never initialises leaves `renderer` null and every gated effect inert,
	 * which is what the eight copies did and is the right outcome for a page
	 * without WebGPU.
	 */
	async mount(m: RendererMount): Promise<void> {
		if (this.#mounted) return;
		this.#mounted = true;

		const ctx = this.#options.webGPUContext;
		if (!ctx) return;
		for (let i = 0; i < DEVICE_POLL_LIMIT && !ctx.isInitialized(); i++) {
			await new Promise((r) => setTimeout(r, DEVICE_POLL_MS));
		}
		if (!ctx.isInitialized()) return;

		const { markType, gpuCoordinator, chartContext, zIndex, xScaleType, yScaleType } =
			this.#options;
		try {
			const renderer = new BaseGPURenderer(markType, ctx, gpuCoordinator, chartContext, {
				zIndex,
				xScaleType,
				yScaleType
			});
			// Published before `initialize` is awaited, as the copies did by
			// assigning first: a component's draw callback closes over this, and
			// the coordinator can reach it as soon as `ready` registers a layer.
			this.renderer = renderer;
			await renderer.initialize(m.init);
			await m.ready?.(renderer);
		} catch (error) {
			const what = this.#options.label ?? markType;
			console.error(`${what} renderer init failed:`, error);
			this.error = (error as Error).message;
		}
	}
}
