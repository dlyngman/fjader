import { onDestroy, untrack } from 'svelte';
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
	 * The mark this layer belongs to: it draws at that mark's place in
	 * declaration order. Without one it takes the next place.
	 */
	markId?: string;
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
	/**
	 * False for a mark whose shader never reads the chart's x and y scales, so
	 * it still draws in a chart missing one. ParallelLines, which scales each
	 * axis itself in a chart that registers no y scale.
	 */
	readsChartScales?: boolean;
	/** Where the layer draws: the plot (default) or the whole cell (axes). */
	space?: 'plot' | 'cell';
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
	/** The layer's place among its chart's: its mark's, in declaration order. */
	#order: number;
	#mounted = false;
	/**
	 * Its component was destroyed. `mount` awaits the canvas, which can take all
	 * of WebGPU start-up: a component gone by then destroyed `renderer` while it
	 * was still null, so a renderer built after that would never be destroyed
	 * and would keep drawing as a stray layer.
	 */
	#destroyed = false;

	/**
	 * Construct during component initialisation — at the top of `<script>`, not
	 * inside `onMount` — because this owns an `$effect` and Svelte only allows
	 * one to be created there. That is also what lets the scale-type rule live
	 * HERE rather than being repeated in every component.
	 */
	constructor(options: RendererHostOptions) {
		this.#options = options;
		this.#order = options.chartContext.config.orderFor(options.markId);
		onDestroy(() => {
			this.#destroyed = true;
		});

		// The pipeline is compiled for the chart's scale types, and a chart does
		// not always know them when its marks mount: a mark that infers its axis
		// from the table schema registers no requirement until that arrives. So
		// the dependency is tracked rather than read once.
		//
		// Reading `scaleTypes` is what subscribes; `syncScaleTypes` compares and
		// returns immediately when nothing moved, which is every frame but the
		// one where it did. Untracked inside, so a rebuild cannot re-enter here.
		//
		// `scalesReady` too, and after the sync: once the scales are ready, what
		// was compiled has drawn with a domain, and a later type change warns. A
		// change in the same flush as readiness is judged by the state before it.
		$effect(() => {
			const types = this.#options.chartContext.scaleTypes;
			void types?.x;
			void types?.y;
			const ready = this.#options.chartContext.scalesReady;
			const renderer = this.renderer;
			if (renderer)
				untrack(() => {
					void renderer.syncScaleTypes();
					if (ready) renderer.noteScalesReady();
				});
		});
	}

	/**
	 * Wait for the canvas (its `ready`), then build the renderer. Call once, from `onMount`.
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
		if (!ctx) {
			// Placed outside any chart canvas: nothing would draw, and nothing would say why.
			console.warn(
				`fjader: ${this.#options.label ?? this.#options.markType} has no WebGPU canvas to draw in: ` +
					'it is outside any chart. Place it as a child of <ChartContainer>.'
			);
			return;
		}
		// However long the canvas takes to configure (thirty at once, a slow
		// adapter, a background tab), a mark waits for it rather than giving up
		// on a timer of its own. It rejects when the canvas never will be usable,
		// which includes the canvas's own 5 s wait for the GPU coordinator
		// running out (WebGPUCanvas shows its error then).
		try {
			await ctx.ready;
		} catch {
			return;
		}
		if (this.#destroyed) return;

		const {
			markType,
			gpuCoordinator,
			chartContext,
			zIndex,
			xScaleType,
			yScaleType,
			readsChartScales,
			space
		} = this.#options;
		try {
			const renderer = new BaseGPURenderer(markType, ctx, gpuCoordinator, chartContext, {
				zIndex,
				order: this.#order,
				xScaleType,
				yScaleType,
				readsChartScales,
				space,
				// A recompile for changed scale types: recorded as a failed mount is.
				onError: (error) => {
					console.error(`${this.#options.label ?? markType} renderer recompile failed:`, error);
					this.error = (error as Error).message;
				}
			});
			// Published before `initialize` is awaited, as the copies did by
			// assigning first: a component's draw callback closes over this, and
			// the coordinator can reach it as soon as `ready` registers a layer.
			this.renderer = renderer;
			await renderer.initialize(m.init);
			// Destroyed while initialising: the component has already destroyed
			// (or retained) the renderer it saw published above; registering a
			// layer for it now would draw a destroyed renderer.
			if (this.#destroyed) return;
			await m.ready?.(renderer);
		} catch (error) {
			const what = this.#options.label ?? markType;
			console.error(`${what} renderer init failed:`, error);
			this.error = (error as Error).message;
		}
	}
}
