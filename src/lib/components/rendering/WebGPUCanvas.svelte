<script lang="ts">
	import { onMount, onDestroy, setContext, getContext } from 'svelte';
	import { getGPUContext } from '$lib/gpu';
	import type { Snippet } from 'svelte';
	import type { ChartContext, EntranceMode, WebGPUCanvasContext } from '$lib/types';
	import type { GPUCoordinator, ChartRegistrationResult } from '$lib/gpu/GPUCoordinator.svelte';
	import type { FacetScaleRef } from '$lib/gpu/GPUCoordinator.svelte';
	import { TextAtlas, ATLAS_CSS_WIDTH } from '$lib/gpu/text/TextAtlas.svelte';
	import { parseColorToRGBA } from '$lib/scales/color-utils';
	import GpuAxis from '../axes/GpuAxis.svelte';
	import { AXIS_REGISTRY, type AxisRegistry } from '../axes/axis-registry.svelte';

	interface Props {
		canvasComponents?: Snippet | undefined;
		facetIndex?: number;
		facetScale?: FacetScaleRef | null;
	}

	let { canvasComponents = undefined, facetIndex, facetScale = null }: Props = $props();

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
	 * The chart's text atlas: text layers acquire their strings from it, this
	 * component renders them inside the canvas, and the canvas's `paint` hands
	 * them to the GPU (gpu/text/TextAtlas.svelte.ts).
	 */
	const textAtlas = new TextAtlas();
	/** The cell's declared axes (AxisLeft, AxisBottom), drawn here, on the GPU. */
	const axisRegistry = getContext<AxisRegistry | undefined>(AXIS_REGISTRY);
	setContext('text-atlas', textAtlas);

	function handlePaint() {
		if (canvas && atlasContainer) textAtlas.paint(canvas, atlasContainer);
	}
	let context: GPUCanvasContext | null = null;
	let gpuCoordinator: GPUCoordinator | null | undefined = isFaceted ? getGPUContext() : undefined;
	let chartControl: ChartRegistrationResult | null = null;
	let contextConfigured = $state(isFaceted);
	let initializationError = $state<string | null>(null);

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

			console.log(`✅ WebGPUCanvas ${chartId} initialized successfully`);
		} catch (error) {
			console.error(`❌ WebGPUCanvas ${chartId} initialization failed:`, error);
			initializationError = (error as Error).message;
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
			textAtlas.attach(gpuCoordinator.device!, gpuCoordinator, chartId);
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
			textAtlas.destroy();

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
	{@render canvasComponents?.()}
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
	<canvas bind:this={canvas} content="drawable" layoutsubtree onpaint={handlePaint}>
		{#if textAtlas.items.length > 0}
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
			</div>
		{/if}
	</canvas>
	{#if contextConfigured}
		{@render canvasComponents?.()}
		{#each axisRegistry?.axes ?? [] as spec (spec.id)}
			<GpuAxis {spec} />
		{/each}
	{:else}
		<div class="webgpu-loading">
			<p>Initializing WebGPU context for chart {chartId}...</p>
		</div>
	{/if}
{/if}

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
		color: #fff;
		line-height: 1.2;
	}

	.fjader-text-atlas span {
		white-space: pre;
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
