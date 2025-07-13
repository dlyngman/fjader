<script>
  import { onMount, onDestroy, setContext, getContext } from "svelte";
  import { getGPUContext } from '$lib/gpu';

  let {
    canvasComponents,
    msaaSampleCount = 4 
  } = $props();

  const c = getContext('chart');
  let width = $derived(c.innerWidth);
  let height = $derived(c.innerHeight);
  let margin = $derived(c.margin);

  let canvas;
  let context;
  let gpuCoordinator;
  let chartControl;
  let contextConfigured = $state(false);
  let initializationError = $state(null);

  const chartId = c.chartId;
  const devicePixelRatio = window.devicePixelRatio || 1;  // TODO look into using svelte reactiv alternative

  // Enhanced initialization with comprehensive error handling
  async function initWebGPU() {
    try {
      console.log(`🚀 Initializing WebGPUCanvas ${chartId}`);
      
      // Get shared GPU coordinator
      gpuCoordinator = getGPUContext();
      
      if (!gpuCoordinator) {
        throw new Error('GPUCoordinator not found. Ensure setCoordinators() was called in a parent component.');
      }

      // Wait for coordinator initialization with timeout
      let attempts = 0;
      const maxAttempts = 100; // 5 seconds at 50ms intervals
      
      while (!gpuCoordinator.isInitialized && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 50));
        attempts++;
      }

      if (!gpuCoordinator.isInitialized) {
        throw new Error(`GPUCoordinator failed to initialize within ${maxAttempts * 50}ms timeout`);
      }

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
        alphaMode: 'premultiplied',
      });
      
      contextConfigured = true;
      console.log(`🎨 Context configured successfully for chart ${chartId}`);
      
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
        zIndex: 0, // zIndex might still be useful for chart-level ordering
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
      const canvasWidth = width * devicePixelRatio;
      const canvasHeight = height * devicePixelRatio;
      
      // Only update if dimensions actually changed to avoid unnecessary work
      const dimensionsChanged = 
        canvas.width !== canvasWidth || 
        canvas.height !== canvasHeight;
      
      const positionChanged = 
        canvas.style.transform !== `translate(${margin.left}px, ${margin.top}px)`;

      // Only proceed if there's an actual change.
      if (!dimensionsChanged && !positionChanged) return;

      console.log(`[${chartId}] Canvas needs update. Resized: ${dimensionsChanged}, Repositioned: ${positionChanged}`);

      if (dimensionsChanged) {
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        
        console.debug(`📐 Canvas ${chartId} resized to ${canvasWidth}x${canvasHeight}`);
      }

      if (positionChanged) {
        canvas.style.transform = `translate(${margin.left}px, ${margin.top}px)`;
        console.debug(`📍 Canvas ${chartId} repositioned to (${margin.left}, ${margin.top})`);
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
      return { 
        width: width * devicePixelRatio, 
        height: height * devicePixelRatio,
        cssWidth: width,
        cssHeight: height,
        devicePixelRatio
      };
    },

    getMsaaSampleCount() {
      return gpuCoordinator?.msaaSampleCount || msaaSampleCount;
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
        layerCount: layers.length,
        layers: layers.map(l => ({
          id: l.id,
          markType: l.markType,
          zIndex: l.zIndex,
          visible: l.visible
        })),
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
      
      // Context cleanup happens automatically when canvas is removed
      contextConfigured = false;
      
      // Clear references
      gpuCoordinator = null;
      context = null;
      
      console.log(`✅ WebGPUCanvas ${chartId} destroyed successfully`);
    } catch (error) {
      console.error(`❌ Error during WebGPUCanvas ${chartId} destruction:`, error);
    }
  });

  $effect.pre(() => {
    // Dependencies that trigger a canvas resize/reposition.
    void width;
    void height;
    void margin;

    // Only run if the canvas and context are fully ready.
    if (canvas && contextConfigured) {
        console.log(`[${chartId}] Canvas dimension/margin effect triggered.`);
        // The setupCanvas function already contains the logic to check
        // if dimensions *actually* changed before doing expensive work.
        setupCanvas();
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