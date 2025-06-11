<script>
    import { onMount, onDestroy, setContext, getContext } from "svelte";
  
    let {
      canvasComponents,
      msaaSampleCount = 4 
    } = $props();
  
    const c = getContext('chart');
    let width = $derived(c.innerWidth)
    let height = $derived(c.innerHeight)
    let margin = $derived(c.margin)
  
    let canvas;
    let device;
    let context;
    let rafId = null;
    let needsRedraw = false;
    let initialized = false;
  
    // WebGPU state
    let presentationFormat;

    const devicePixelRatio = window.devicePixelRatio || 1;
  
    // Layer management system
    const layers = [];
  
    async function initWebGPU() {
      if (!navigator.gpu) {
        throw new Error('WebGPU not supported');
      }
  
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        throw new Error('No appropriate GPUAdapter found');
      }
  
      device = await adapter.requestDevice();
      context = canvas.getContext('webgpu');
      
      presentationFormat = navigator.gpu.getPreferredCanvasFormat();
      context.configure({
        device,
        format: presentationFormat,
        alphaMode: 'premultiplied',
      });
  
      initialized = true;
      setupCanvas();
      requestRedraw(); // Initial draw after initialization
    }
  
    function setupCanvas() {
      if (!canvas || !initialized) return;
      
      // Set canvas size
      canvas.width = width * devicePixelRatio;
      canvas.height = height * devicePixelRatio;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      canvas.style.transform = `translate(${margin.left}px, ${margin.top}px)`;
      
      needsRedraw = true;

      // Reconfigure WebGPU context when size changes
      // context.configure({
      //   device,
      //   format: presentationFormat,
      //   alphaMode: 'premultiplied',
      // });
    }

    function update() {
      if (!device || !context || !needsRedraw || !initialized) return;
      
      // Create command encoder for all drawing operations
      const commandEncoder = device.createCommandEncoder();
      const textureView = context.getCurrentTexture().createView();

      let renderPassDescriptor;
      
      if (msaaSampleCount > 1) {
        // Create a multisampled texture for rendering when msaaSampleCount > 1
        const multisampleTexture = device.createTexture({
          size: {
            width: canvas.width,
            height: canvas.height
          },
          sampleCount: msaaSampleCount,
          format: presentationFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT
        });
        
        // Configure render pass with multisampling
        renderPassDescriptor = {
          colorAttachments: [{
            view: multisampleTexture.createView(),
            resolveTarget: textureView,
            clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
            loadOp: 'clear',
            storeOp: 'store',
          }],
        };
        
        // Rest of the rendering code...
        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
        
        // Draw all registered layers in order
        for (let i = 0; i < layers.length; i++) {
          const layer = layers[i];
          if (layer.visible !== false) {
            layer.draw(passEncoder, device, presentationFormat);
          }
        }
        
        passEncoder.end();
        device.queue.submit([commandEncoder.finish()]);
        
        // Clean up
        multisampleTexture.destroy();
      } else {
        // Use the original non-multisampled configuration when msaaSampleCount is 0 or 1
        renderPassDescriptor = {
          colorAttachments: [{
            view: textureView,
            clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
            loadOp: 'clear',
            storeOp: 'store',
          }],
        };
        
        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
        
        // Draw all registered layers in order
        for (let i = 0; i < layers.length; i++) {
          const layer = layers[i];
          if (layer.visible !== false) {
            layer.draw(passEncoder, device, presentationFormat);
          }
        }
        
        passEncoder.end();
        device.queue.submit([commandEncoder.finish()]);
      }
      
      needsRedraw = false;
      rafId = null;
    }

    // function update() {
    //   if (!device || !context || !needsRedraw || !initialized) return;
      
    //   // Create command encoder for all drawing operations
    //   const commandEncoder = device.createCommandEncoder();
    //   const textureView = context.getCurrentTexture().createView();
  
    //   // Create a multisampled texture for rendering
    //   const multisampleTexture = device.createTexture({
    //     size: {
    //       width: canvas.width,
    //       height: canvas.height
    //     },
    //     sampleCount: 4, // 4x MSAA
    //     format: presentationFormat,
    //     usage: GPUTextureUsage.RENDER_ATTACHMENT
    //   });

    //   // Render pass descriptor with transparent background
    //   const renderPassDescriptor = {
    //     colorAttachments: [{
    //       view: multisampleTexture.createView(), // Render to multisampled texture
    //       resolveTarget: textureView,  // Resolve to the canvas texture
    //       clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 }, // Transparent background
    //       loadOp: 'clear',
    //       storeOp: 'store',
    //     }],
    //   };
  
    //   const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
  
    //   // Draw all registered layers in order
    //   for (let i = 0; i < layers.length; i++) {
    //     const layer = layers[i];
    //     if (layer.visible !== false) {
    //       layer.draw(passEncoder, device, presentationFormat);
    //     }
    //   }
      
    //   passEncoder.end();
    //   device.queue.submit([commandEncoder.finish()]);

    //   // Clean up the multisampled texture
    //   multisampleTexture.destroy();
      
    //   needsRedraw = false;
    //   rafId = null;
    // }
  
    function requestRedraw() {
      if (rafId !== null || !initialized) return;
      needsRedraw = true;
      rafId = requestAnimationFrame(update);
    }
  
    // WebGPU context that child components can use
    setContext('webgpu-canvas', {
      registerLayer(layer) {
        // Allow specifying a z-index for ordering
        const zIndex = layer.zIndex || 0;
        let insertIndex = layers.length;
        
        // Find the correct position to insert based on zIndex
        for (let i = 0; i < layers.length; i++) {
          if ((layers[i].zIndex || 0) > zIndex) {
            insertIndex = i;
            break;
          }
        }
        
        layers.splice(insertIndex, 0, layer);
        if (initialized) {
          requestRedraw();
        }
        
        // Return functions to interact with this layer
        return {
          update(newProps) {
            Object.assign(layer, newProps);
            if (initialized) {
              requestRedraw();
            }
          },
          remove() {
            const index = layers.indexOf(layer);
            if (index !== -1) {
              layers.splice(index, 1);
              if (initialized) {
                requestRedraw();
              }
            }
          },
          invalidate() {
            if (initialized) {
              requestRedraw();
            }
          }
        };
      },
      
      getCanvasDimensions() {
        return { 
          width: width * devicePixelRatio, 
          height: height * devicePixelRatio
        };
      },

      getMsaaSampleCount() {
        return msaaSampleCount;
      },
  
      getDevice() {
        return device;
      },
  
      getPresentationFormat() {
        return presentationFormat;
      },
  
      isInitialized() {
        return initialized;
      },
      
      invalidate() {
        if (initialized) {
          requestRedraw();
        }
      }
    });
  
    onMount(async () => {
      try {
        await initWebGPU();
      } catch (error) {
        console.error('WebGPU initialization failed:', error);
      }
    });
  
    onDestroy(() => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      if (device) {
        device.destroy();
      }
    });

    $effect(() => {
      // Trigger on width, height, or margin changes
      void width;
      void height;
      void margin;
  
      if (canvas && initialized) {
        setupCanvas();
        requestRedraw(); // Add this to trigger a redraw after resizing
        // console.log('canvas resize redraw')
      }
    });
  
</script>
  
<canvas bind:this={canvas}></canvas>
{@render canvasComponents?.()}