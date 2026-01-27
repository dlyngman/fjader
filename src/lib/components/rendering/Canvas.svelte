<script>
	import { onMount, onDestroy, setContext, getContext } from 'svelte';

	let { canvasComponents } = $props();

	const c = getContext('chart');
	let width = $derived(c.innerWidth);
	let height = $derived(c.innerHeight);
	let margin = $derived(c.margin);

	let canvas;
	let ctx;
	let rafId = null;
	let needsRedraw = false;

	// Layer management system
	const layers = [];

	function scaleCanvas(canvas, ctx, width, height, margin) {
		const devicePixelRatio = window.devicePixelRatio || 1;

		canvas.width = width * devicePixelRatio;
		canvas.height = height * devicePixelRatio;
		canvas.style.width = width + 'px';
		canvas.style.height = height + 'px';
		canvas.style.transform = `translate(${margin.left}px, ${margin.top}px)`;

		ctx.scale(devicePixelRatio, devicePixelRatio);

		needsRedraw = true;
	}

	function update() {
		if (!ctx || !needsRedraw) return;

		// Clear the canvas
		ctx.clearRect(0, 0, width, height);

		// Draw all registered layers in order
		for (let i = 0; i < layers.length; i++) {
			const layer = layers[i];
			if (layer.visible !== false) {
				ctx.save();
				layer.draw(ctx);
				ctx.restore();
			}
		}

		needsRedraw = false;
		rafId = null;
	}

	function requestRedraw() {
		if (rafId !== null) return;
		needsRedraw = true;
		rafId = requestAnimationFrame(update);
	}

	// Canvas context that child components can use
	setContext('canvas', {
		// Register a layer that can contain multiple elements
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
			requestRedraw();

			// Return functions to interact with this layer
			return {
				// Update layer properties
				update(newProps) {
					Object.assign(layer, newProps);
					requestRedraw();
				},
				// Remove this layer
				remove() {
					const index = layers.indexOf(layer);
					if (index !== -1) {
						layers.splice(index, 1);
						requestRedraw();
					}
				},
				// Request a redraw (if layer content changed)
				invalidate() {
					requestRedraw();
				}
			};
		},

		// Expose canvas dimensions
		getCanvasDimensions() {
			return { width, height };
		},

		// Force a redraw
		invalidate() {
			requestRedraw();
		}
	});

	onMount(() => {
		ctx = canvas.getContext('2d', {
			willReadFrequently: false, // Hint that we won't read pixel data often
			desynchronized: true // Lower latency rendering
		});

		scaleCanvas(canvas, ctx, width, height, margin);
		requestRedraw();
	});

	onDestroy(() => {
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
		}
	});

	$effect(() => {
		if (canvas && ctx) {
			scaleCanvas(canvas, ctx, width, height, margin);
		}
	});
</script>

<canvas bind:this={canvas}></canvas>
{@render canvasComponents?.()}

<!-- <script>
  import { onMount, onDestroy, setContext, getContext } from "svelte";
	let {
    canvasComponents
	} = $props();

	const c = getContext('chart');
  let width = $derived(c.innerWidth)
  let height = $derived(c.innerHeight)
  let margin = $derived(c.margin)

  const drawFunctions = [];

  let canvas; // state needed here?
  let ctx;
  let pendingInvalidation = false;
  let frameId;

  function scaleCanvas(canvas, ctx, width, height, margin) {
    const devicePixelRatio = window.devicePixelRatio || 1;

    canvas.width = width * devicePixelRatio;
    canvas.height = height * devicePixelRatio;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    canvas.style.transform = `translate(${margin.left}px, ${margin.top}px)`;

    ctx.scale(devicePixelRatio, devicePixelRatio);
  }

  function update() {
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    drawFunctions.forEach((fn) => {
      ctx.save();
      fn(ctx);
      ctx.restore();
    });

    pendingInvalidation = false
  }

  onMount(() => {
    ctx = canvas.getContext('2d', {
      // alpha: false,            // Disable transparency if not needed
      // willReadFrequently: false, // Hint that we won't read pixel data often
      // desynchronized: true     // Lower latency rendering
    })
  })

  onDestroy(() => {
    if (frameId) {
      cancelAnimationFrame(frameId);
    }
  })

  setContext('canvas', {
    register(fn) { 
      drawFunctions.push(fn);
    },
    deregister(fn) {
      drawFunctions.splice(drawFunctions.indexOf(fn), 1);
    },
    invalidate() {
      if (pendingInvalidation) return;
      pendingInvalidation = true;
      frameId = requestAnimationFrame(update);
    }
  })

  $effect(() => {
    if (canvas && ctx) scaleCanvas(canvas, ctx, width, height, margin)
  })
</script>

<canvas bind:this={canvas}></canvas>
{@render canvasComponents?.()} -->
