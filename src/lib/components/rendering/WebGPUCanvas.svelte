<script>
	import { onMount, onDestroy, setContext, getContext } from 'svelte';
	import { getGPUContext } from '$lib/gpu';

	let { canvasComponents } = $props();

	const c = getContext('chart');
	let width = $derived(c.innerWidth);
	let height = $derived(c.innerHeight);
	let margin = $derived(c.margin);

	// let canvas;
	let canvas = $state();
	let context;
	let gpuCoordinator;
	let chartControl;
	let contextConfigured = $state(false);
	let initializationError = $state(null);
	let lastTransform = '';

	const chartId = c.chartId;

	// Enhanced initialization with comprehensive error handling
	async function initWebGPU() {
		try {
			// Get shared GPU coordinator
			gpuCoordinator = getGPUContext();

			if (!gpuCoordinator) {
				throw new Error(
					'GPUCoordinator not found. Ensure setCoordinators() was called in a parent component.'
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
			initializationError = error.message;
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
				// alphaMode: 'opaque',
				alphaMode: 'premultiplied',
				desynchronized: true
				// desynchronized: false
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
				zIndex: 0
			});

			// Notify coordinator that context is ready
			chartControl.setContextReady();
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

			const canvasWidth = Math.ceil(width * devicePixelRatio);
			const canvasHeight = Math.ceil(height * devicePixelRatio);

			// Only update if dimensions actually changed to avoid unnecessary work
			const dimensionsChanged = canvas.width !== canvasWidth || canvas.height !== canvasHeight;

			const newTransform = `translate(${margin.left}px, ${margin.top}px)`;
			const positionChanged = lastTransform !== newTransform;

			// Only proceed if there's an actual change
			if (!dimensionsChanged && !positionChanged) return;

			if (dimensionsChanged) {
				canvas.width = canvasWidth;
				canvas.height = canvasHeight;
				canvas.style.width = width + 'px';
				canvas.style.height = height + 'px';
			}

			if (positionChanged) {
				canvas.style.transform = newTransform;
				lastTransform = newTransform;
			}

			if (chartControl) {
				chartControl.invalidate();
			}
		} catch (error) {
			console.error(`❌ Canvas setup failed for ${chartId}:`, error);
			initializationError = `Canvas setup failed: ${error.message}`;
		}
	}

	// Enhanced context with better state management and error handling
	setContext('webgpu-canvas', {
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
		try {
			await initWebGPU();
		} catch (error) {
			console.error(`❌ WebGPUCanvas ${chartId} mount failed:`, error);
			// Error is already stored in initializationError state
		}
	});

	onDestroy(() => {
		console.log(`🧹 Destroying WebGPUCanvas ${chartId}`);

		try {
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
		// Dependencies that trigger a canvas resize/reposition
		void width;
		void height;
		void margin;

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

{#if initializationError}
	<div class="webgpu-error">
		<p>WebGPU initialization failed for chart {chartId}:</p>
		<p class="error-message">{initializationError}</p>
		<p class="error-help">
			Please ensure your browser supports WebGPU and try refreshing the page.
		</p>
	</div>
{:else}
	<canvas bind:this={canvas}></canvas>
	{#if contextConfigured}
		{@render canvasComponents?.()}
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
		will-change: contents;
		touch-action: none;
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
