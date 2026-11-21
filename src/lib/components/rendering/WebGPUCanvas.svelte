<script lang="ts">
	import { onMount, onDestroy, setContext, getContext } from 'svelte';
	import { getGPUContext } from '$lib/gpu';
	import type { Snippet } from 'svelte';
	import type { ChartContext, EntranceMode, WebGPUCanvasContext } from '$lib/types';
	import type { GPUCoordinator, ChartRegistrationResult } from '$lib/gpu/GPUCoordinator.svelte';
	import type { FacetScaleRef } from '$lib/gpu/GPUCoordinator.svelte';
	import {
		TextAtlas,
		ATLAS_CSS_WIDTH,
		CHART_TEXT_ATLAS,
		type AtlasSurface
	} from '$lib/gpu/text/TextAtlas.svelte';
	import { parseColorToRGBA } from '$lib/scales/color-utils';
	import GpuAxis from '../axes/GpuAxis.svelte';
	import GpuParallelAxes from '../axes/GpuParallelAxes.svelte';
	import PlotBorderRenderer from './PlotBorderRenderer.svelte';
	import { DECLARATION_REGISTRY, type DeclarationRegistry } from '../charts/declarations.svelte';

	interface Props {
		/**
		 * The chart's components (ChartContainer's children), on the chart's
		 * canvas: the unfaceted cell's, or a facet grid's pass-through. A facet
		 * cell's own canvas gets none: it draws the marks of the one instance in
		 * the pass-through.
		 */
		components?: Snippet;
		facetIndex?: number;
		facetScale?: FacetScaleRef | null;
	}

	let { components = undefined, facetIndex, facetScale = null }: Props = $props();

	const c = getContext<ChartContext>('chart');
	const isFaceted = !!c.fx && facetIndex == null;
	// The plot area. The canvas covers the whole cell, margins included, so
	// text can be drawn there; marks draw in the plot only, through the
	// viewport the coordinator sets from `plotRect` (gpu/plot-viewport.ts).
	let width = $derived(c.innerWidth);
	let height = $derived(c.innerHeight);
	let margin = $derived(c.margin);
	let cellWidth = $derived(width + margin.left + margin.right);
	let cellHeight = $derived(height + margin.top + margin.bottom);
	const plotRect = () => ({ x: margin.left, y: margin.top, width, height });

	let canvas = $state<HTMLCanvasElement>();
	let atlasContainer = $state<HTMLElement>();
	/**
	 * The chart's text atlas (gpu/text/TextAtlas.svelte.ts): text layers acquire
	 * their strings from it, this component renders them inside the canvas, and
	 * the canvas's `paint` hands them to the GPU. The chart's own, shared by its
	 * canvases: in a facet grid every cell paints the strings the pass-through
	 * canvas's layers acquired. A canvas outside a chart makes its own.
	 */
	const textAtlas = getContext<TextAtlas | undefined>(CHART_TEXT_ATLAS) ?? new TextAtlas();
	/** This canvas's surface of the atlas, once it is attached. */
	let atlasSurface = $state.raw<AtlasSurface | null>(null);
	/**
	 * The canvas element's own size, as laid out (0 under display: none). Not the
	 * chart's layout, which keeps its last size while the cell measures 0, nor its
	 * inner size, which is 0 in a cell narrower than its margins while its canvas
	 * still paints.
	 */
	let canvasClientWidth = $state(0);
	let canvasClientHeight = $state(0);
	/**
	 * What the chart declared (axes, parallel axes, the plot border), drawn
	 * here, on the GPU. Not by a facet grid's pass-through canvas: each cell's
	 * canvas draws them.
	 */
	const declarations = getContext<DeclarationRegistry | undefined>(DECLARATION_REGISTRY);
	setContext('text-atlas', textAtlas);

	function handlePaint() {
		if (canvas && atlasContainer && atlasSurface)
			textAtlas.paint(canvas, atlasContainer, atlasSurface);
	}
	let context: GPUCanvasContext | null = null;
	let gpuCoordinator: GPUCoordinator | null | undefined = isFaceted ? getGPUContext() : undefined;
	let chartControl: ChartRegistrationResult | null = null;
	let contextConfigured = $state(isFaceted);
	let initializationError = $state<string | null>(null);

	/**
	 * When the canvas can be drawn to (WebGPUCanvasContext.ready). A rejection
	 * is reported by the canvas itself (its error box); the renderers awaiting
	 * it just skip setting up, so it is marked handled here.
	 */
	let resolveReady!: () => void;
	let rejectReady!: (reason: unknown) => void;
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	ready.catch(() => {});
	// The pass-through draws through its facet cells' canvases: ready when the device is.
	if (isFaceted) {
		if (!gpuCoordinator) rejectReady(new Error('GPUCoordinator not found'));
		else
			gpuCoordinator.ready.then(
				(ok) => (ok ? resolveReady() : rejectReady(new Error('WebGPU unavailable'))),
				rejectReady
			);
	}

	const chartId = c.chartId;

	// Enhanced initialization with comprehensive error handling
	async function initWebGPU() {
		try {
			// Get shared GPU coordinator
			gpuCoordinator = getGPUContext();

			if (!gpuCoordinator) {
				throw new Error(
					'GPUCoordinator not found. Ensure initFjader() was called in a parent component.'
				);
			}

			// Wait for coordinator initialization with deterministic promise-based approach
			// This eliminates polling and provides exact-time notification when ready
			const timeout = new Promise((_, reject) =>
				setTimeout(() => reject(new Error('GPUCoordinator initialization timeout (5000ms)')), 5000)
			);

			await Promise.race([gpuCoordinator.ready, timeout]);

			// Configure context with proper error handling
			await configureContext();

			// Register with coordinator after context is ready
			registerWithCoordinator();

			// setupCanvas reports its own failure through initializationError,
			// which takes the canvas out of the DOM: not ready, then.
			if (initializationError) {
				rejectReady(new Error(initializationError));
				return;
			}
			console.log(`✅ WebGPUCanvas ${chartId} initialized successfully`);
			resolveReady();
		} catch (error) {
			console.error(`❌ WebGPUCanvas ${chartId} initialization failed:`, error);
			initializationError = (error as Error).message;
			rejectReady(error);
			throw error;
		}
	}

	// Separate context configuration with proper error handling
	async function configureContext() {
		if (!canvas) {
			throw new Error('Canvas element not available for context configuration');
		}

		try {
			// Get WebGPU context
			context = canvas.getContext('webgpu');
			if (!context) {
				throw new Error('Failed to get WebGPU context from canvas. WebGPU may not be supported.');
			}

			const device = gpuCoordinator.device;
			const presentationFormat = gpuCoordinator.presentationFormat;

			if (!device) {
				throw new Error('No WebGPU device available from coordinator');
			}

			// Configure context
			context.configure({
				device,
				format: presentationFormat,
				alphaMode: 'premultiplied',
				// COPY_SRC only for the parity check's readback; production keeps
				// the default usage.
				usage: gpuCoordinator.readbackEnabled
					? GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
					: GPUTextureUsage.RENDER_ATTACHMENT
			});

			contextConfigured = true;

			// Setup initial canvas size
			setupCanvas();
		} catch (error) {
			console.error(`❌ Context configuration failed for chart ${chartId}:`, error);
			contextConfigured = false;
			throw error;
		}
	}

	// Clean registration with coordinator
	function registerWithCoordinator() {
		if (!contextConfigured) {
			console.error(`⚠️ Attempting to register chart ${chartId} before context is configured`);
			return;
		}

		console.log(`📋 Registering chart ${chartId} with coordinator`);

		try {
			chartControl = gpuCoordinator.registerChart(chartId, canvas, {
				zIndex: 0,
				facetIndex: facetIndex ?? 0,
				facetScale,
				entrance: c.config?.chartProps?.entrance as EntranceMode | undefined,
				entranceGate: c.config?.entrance ?? null,
				plotRect: plotRect()
			});

			// Notify coordinator that context is ready
			chartControl.setContextReady();
			atlasSurface = textAtlas.attach(gpuCoordinator.device!, gpuCoordinator, chartId);
			console.log(`✅ Chart ${chartId} registered and ready`);
		} catch (error) {
			console.error(`❌ Chart registration failed for ${chartId}:`, error);
			throw error;
		}
	}

	// Robust canvas setup with dimension change detection
	function setupCanvas() {
		if (!canvas || !contextConfigured) {
			console.debug(`⚠️ setupCanvas called before canvas/context ready for ${chartId}`);
			return;
		}

		try {
			// Calculate new dimensions
			const devicePixelRatio = window.devicePixelRatio || 1;

			const canvasWidth = Math.ceil(cellWidth * devicePixelRatio);
			const canvasHeight = Math.ceil(cellHeight * devicePixelRatio);

			if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
				canvas.width = canvasWidth;
				canvas.height = canvasHeight;
				canvas.style.width = cellWidth + 'px';
				canvas.style.height = cellHeight + 'px';
				chartControl?.invalidate();
			}

			// A margin change moves the plot without resizing the canvas. Its own
			// check: no change, no work.
			chartControl?.setPlotRect(plotRect());
		} catch (error) {
			console.error(`❌ Canvas setup failed for ${chartId}:`, error);
			initializationError = `Canvas setup failed: ${(error as Error).message}`;
		}
	}

	// Enhanced context with better state management and error handling
	setContext<WebGPUCanvasContext>('webgpu-canvas', {
		/** The plot area's size, not the canvas's: the canvas covers the whole cell. */
		getCanvasDimensions() {
			const currentDPR = window.devicePixelRatio || 1;
			return {
				width: width * currentDPR,
				height: height * currentDPR,
				cssWidth: width,
				cssHeight: height,
				currentDPR
			};
		},

		getMsaaSampleCount() {
			return gpuCoordinator?.msaaSampleCount || 4;
		},

		getDevice() {
			return gpuCoordinator?.device;
		},

		getPresentationFormat() {
			return gpuCoordinator?.presentationFormat;
		},

		isInitialized() {
			return contextConfigured && gpuCoordinator?.isInitialized;
		},

		ready,

		invalidate() {
			chartControl?.invalidate();
		},

		getCssColor(property: string, fallback: string) {
			const css = canvas ? getComputedStyle(canvas).getPropertyValue(property).trim() : '';
			const [r, g, b, a] = parseColorToRGBA(css || fallback);
			return [r, g, b, a];
		},

		getTextColor() {
			const css = canvas ? getComputedStyle(canvas).color : '';
			const [r, g, b, a] = parseColorToRGBA(css || '#000');
			return [r, g, b, a];
		},

		// Enhanced debugging support
		getDebugInfo() {
			return {
				chartId,
				contextConfigured,
				initializationError,
				canvasDimensions: {
					width: canvas?.width,
					height: canvas?.height,
					cssWidth: canvas?.style.width,
					cssHeight: canvas?.style.height
				}
			};
		}
	});

	onMount(async () => {
		if (isFaceted) return; // Pass-through mode: no canvas to initialize
		try {
			await initWebGPU();
		} catch (error) {
			console.error(`❌ WebGPUCanvas ${chartId} mount failed:`, error);
			// Error is already stored in initializationError state
		}
	});

	onDestroy(() => {
		if (isFaceted) return; // Pass-through mode: nothing to clean up
		console.log(`🧹 Destroying WebGPUCanvas ${chartId}`);

		try {
			if (atlasSurface) textAtlas.detach(atlasSurface);
			atlasSurface = null;

			// Clean up chart registration
			if (chartControl) {
				chartControl.remove();
				chartControl = null;
			}

			// FIXED: Unconfigure WebGPU context to release swap chain resources
			if (context && contextConfigured) {
				try {
					context.unconfigure();
				} catch (e) {
					// Context may already be invalid, ignore
					console.debug(`Context unconfigure failed (may already be invalid):`, e);
				}
			}

			contextConfigured = false;

			// Clear references
			gpuCoordinator = null;
			context = null;

			console.log(`✅ WebGPUCanvas ${chartId} destroyed successfully`);
		} catch (error) {
			console.error(`❌ Error during WebGPUCanvas ${chartId} destruction:`, error);
		}
	});

	// Whether this canvas is laid out: one that is not (display: none, zero size)
	// gets no paint events, so the atlas must not wait for it (TextAtlas).
	// Deliberately not the coordinator's viewport visibility: an offscreen
	// canvas still paints (AtlasSurface.laidOut says why).
	$effect(() => {
		const surface = atlasSurface;
		if (surface) textAtlas.setLaidOut(surface, canvasClientWidth > 0 && canvasClientHeight > 0);
	});

	$effect(() => {
		if (isFaceted) return; // Pass-through mode: no canvas to resize
		// Dependencies that trigger a canvas resize/reposition
		void width;
		void height;
		void margin;
		void cellWidth;
		void cellHeight;

		// Only run if the canvas and context are fully ready
		if (canvas && contextConfigured) {
			setupCanvas();
			// Tell the coordinator to update this chart's frame uniforms
			if (gpuCoordinator) {
				gpuCoordinator.updateChartFrameUniforms(chartId);
				gpuCoordinator.invalidateChart(chartId);
			}
		}
	});
</script>

{#if isFaceted}
	<!-- Pass-through: marks render here but real canvases live in FacetCells -->
	{@render components?.()}
{:else if initializationError}
	<div class="webgpu-error">
		<p>WebGPU initialization failed for chart {chartId}:</p>
		<p class="error-message">{initializationError}</p>
		<p class="error-help">
			Please ensure your browser supports WebGPU and try refreshing the page.
		</p>
	</div>
{:else}
	<!--
		content="drawable" (and layoutsubtree, its name before Chrome 157): the
		canvas lays out its children without painting them, and draws them on
		request. Its one child is the text atlas.
	-->
	<canvas
		bind:this={canvas}
		bind:clientWidth={canvasClientWidth}
		bind:clientHeight={canvasClientHeight}
		content="drawable"
		layoutsubtree
		onpaint={handlePaint}
	>
		{#if textAtlas.items.length > 0 || textAtlas.swatches.length > 0}
			<div
				class="fjader-text-atlas"
				drawable
				aria-hidden="true"
				style:width="{ATLAS_CSS_WIDTH}px"
				bind:this={atlasContainer}
			>
				{#each textAtlas.items as item (item.slot)}
					<span data-slot={item.slot} style={item.css}>{item.text}</span>
				{/each}
				{#each textAtlas.swatches as swatch (swatch.css)}
					<span class="fjader-swatch" data-swatch={swatch.css} style:background={swatch.css}></span>
				{/each}
			</div>
		{/if}
	</canvas>
	{#if contextConfigured}
		{#if (declarations?.frames.length ?? 0) > 0}
			<PlotBorderRenderer />
		{/if}
		{#each declarations?.axes ?? [] as spec (spec.id)}
			<GpuAxis {spec} />
		{/each}
		{#each declarations?.parallel ?? [] as spec (spec.id)}
			<GpuParallelAxes {spec} />
		{/each}
	{:else}
		<div class="webgpu-loading">
			<p>Initializing WebGPU context for chart {chartId}...</p>
		</div>
	{/if}
{/if}
<!--
	The chart's components, at once: not behind the context, so their queries,
	scales and declarations start while WebGPU comes up, and legends and
	interactors are there even if it never does. Their renderers wait for the
	canvas themselves (WebGPUCanvasContext.ready). Only the GPU-only
	declarations above (border, axes) wait for it. The faceted pass-through
	renders them above.
-->
{#if !isFaceted}{@render components?.()}{/if}

<style>
	canvas {
		position: absolute;
		top: 0;
		left: 0;
		transform: translateZ(0);
		contain: size;
		will-change: transform;
		touch-action: none;
	}

	/*
	 * Laid out, never painted: the canvas draws it into the atlas texture.
	 * White, so shaders tint it; gaps keep each string's texels apart.
	 */
	.fjader-text-atlas {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 2px 3px;
		line-height: 1.2;
	}

	/* Strings white, so shaders tint them; the container keeps the page's colour for swatches. */
	.fjader-text-atlas span {
		white-space: pre;
		color: #fff;
	}

	/*
	 * A colour the GPU follows (TextAtlas.watchColor): one pixel, read on paint.
	 * Inherits the page's colour, not the strings' white, so currentColor means
	 * the page's text colour.
	 */
	.fjader-text-atlas .fjader-swatch {
		color: inherit;
		display: inline-block;
		width: 1px;
		height: 1px;
	}

	.webgpu-error,
	.webgpu-loading {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		background-color: rgba(255, 255, 255, 0.9);
		border: 1px dashed #ccc;
		font-size: 12px;
		color: #666;
		z-index: 1000;
	}

	.webgpu-error {
		background-color: rgba(255, 240, 240, 0.9);
		border-color: #ffcccb;
		color: #d32f2f;
	}

	.error-message {
		font-family: monospace;
		background-color: rgba(255, 255, 255, 0.8);
		padding: 4px 8px;
		border-radius: 4px;
		margin: 8px 0;
		font-size: 11px;
	}

	.error-help {
		font-style: italic;
		margin-top: 8px;
	}

	.webgpu-loading {
		background-color: rgba(240, 248, 255, 0.9);
		border-color: #bbdefb;
		color: #1976d2;
	}
</style>
