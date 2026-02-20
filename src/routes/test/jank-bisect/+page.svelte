<script>
	import { onMount, onDestroy } from 'svelte';

	let canvas;
	let canvas2d = $state();
	let ctx2d;
	let canvasGrid = $state();
	let ctxGrid;
	let dotSprite; // pre-rendered dot for fast 2D blitting
	let device;
	let context;
	let pipeline;
	let uniformBuffer;
	let dotBuffer;
	let bindGroup;
	let rafId = null;
	let format;
	let dotPositions; // JS copy of dot data for Canvas 2D
	let showCanvas2D = $state(true);
	let showWebGPU = $state(true);
	let show2DGrid = $state(false); // 2D grid underlay beneath WebGPU

	// --- Frame timing ---
	let frameCount = 0;
	let deltas = [];
	let jankCount = $state(0);
	let info = $state('Initializing...');
	let lastTime = 0;

	// --- Scatter plot data ---
	const NUM_DOTS = 3000;
	const DATA_MIN = 0;
	const DATA_MAX = 1000;
	const DOT_RADIUS = 4; // CSS pixels

	// --- Spring physics (inline copy of DivePlot's Spring) ---
	const PHYSICS_HZ = 360;
	const DT = 1 / PHYSICS_HZ; // ~2.78ms
	const MAX_DELTA = 0.1;
	const PAN_STIFFNESS = 600; // matches DivePlot pan preset
	const DEFAULT_STIFFNESS = 400;

	function createSpring(initial, stiffness = DEFAULT_STIFFNESS) {
		const s = {
			current: initial,
			target: initial,
			velocity: 0,
			omega: Math.sqrt(stiffness),
			expDt: Math.exp(-Math.sqrt(stiffness) * DT)
		};
		return s;
	}

	function springConfigure(s, stiffness) {
		s.omega = Math.sqrt(stiffness);
		s.expDt = Math.exp(-s.omega * DT);
	}

	function springStep(s) {
		const d = s.current - s.target;
		const v = s.velocity;
		const omega = s.omega;
		const expDt = s.expDt;
		const displacement = expDt * (d + (v + omega * d) * DT);
		s.current = s.target + displacement;
		s.velocity = displacement * -omega + expDt * (v + omega * d);
	}

	function springGetRenderable(s, dt) {
		const d = s.current - s.target;
		const v = s.velocity;
		if (d === 0 && v === 0) return s.current;
		if (dt === 0) return s.current;
		const omega = s.omega;
		const exp = Math.exp(-omega * dt);
		return s.target + exp * (d + (v + omega * d) * dt);
	}

	function springIsAtRest(s) {
		return Math.abs(s.current - s.target) < 1e-6 && Math.abs(s.velocity) < 1e-6;
	}

	// Domain springs (min/max for x and y)
	const xMinSpring = createSpring(DATA_MIN, PAN_STIFFNESS);
	const xMaxSpring = createSpring(DATA_MAX, PAN_STIFFNESS);
	const yMinSpring = createSpring(DATA_MIN, PAN_STIFFNESS);
	const yMaxSpring = createSpring(DATA_MAX, PAN_STIFFNESS);

	// --- Interaction ---
	let isDragging = false;
	let lastDragX = 0;
	let lastDragY = 0;
	let panStartDomainXMin = 0;
	let panStartDomainXMax = 0;
	let panStartDomainYMin = 0;
	let panStartDomainYMax = 0;
	let panStartScreenX = 0;
	let panStartScreenY = 0;

	// --- Pointer event rate tracking ---
	let pointerEvents = [];
	let pointerRate = $state(0);
	let usePointerRawUpdate = $state(false);
	const hasPointerRawUpdate = typeof window !== 'undefined' && 'onpointerrawupdate' in window;

	let accumulator = 0;
	let physicsStepsThisFrame = 0;

	// --- Animation loop toggles ---
	let useRafAtEnd = $state(false);
	let useFixedTimestep = $state(false);
	let useSpring = $state(false);
	let useIdleDetection = $state(false);
	let useExtraBufferWrites = $state(false);

	// Extra buffer writes (simulate DivePlot's per-frame SSBO updates)
	let extraBuffers = [];
	const extraBufferData = new Float32Array(16);
	const NUM_EXTRA_BUFFERS = 6;

	// --- Wrapper CSS toggles ---
	let wrapContainStrict = $state(false);
	let wrapIsolation = $state(false);
	let wrapTranslateZ = $state(false);
	let wrapWillChange = $state(false);

	// --- Canvas layer CSS toggles ---
	let layerContainStrict = $state(false);
	let layerWillChange = $state(false);

	// --- Canvas element CSS toggles ---
	let canvasTranslateZ = $state(false);
	let canvasContainSize = $state(false);
	let canvasWillChange = $state(false);

	// --- Canvas context options ---
	let useDesynchronized = $state(true);

	// --- DOM sibling toggles ---
	let showSvgBg = $state(false);
	let showSvgFg = $state(false);
	let showOverlay = $state(false);
	let svgTickCount = $state(10);

	// --- Dummy Canvas 2D (separate compositor layer workaround test) ---
	let showDummyCanvas = $state(false);
	let dummyCanvas = $state();
	let dummyCtx;
	let dummySize = $state(600);
	let dummyDrawWork = $state(true); // fill rect each frame vs just clearRect

	function initDummyCanvas() {
		if (!dummyCanvas) return;
		const dpr = window.devicePixelRatio || 1;
		dummyCanvas.width = dummySize * dpr;
		dummyCanvas.height = dummySize * dpr;
		dummyCtx = dummyCanvas.getContext('2d');
	}

	function renderDummyCanvas() {
		if (!dummyCtx) return;
		const w = dummyCanvas.width;
		const h = dummyCanvas.height;
		if (dummyDrawWork) {
			dummyCtx.fillStyle = 'rgb(15, 15, 26)';
			dummyCtx.fillRect(0, 0, w, h);
		} else {
			dummyCtx.clearRect(0, 0, w, h);
		}
	}

	$effect(() => {
		if (dummyCanvas && showDummyCanvas) {
			initDummyCanvas();
		}
	});

	// Reinit when size changes
	$effect(() => {
		dummySize; // track
		if (dummyCanvas && showDummyCanvas) {
			initDummyCanvas();
		}
	});

	const ticks = $derived(Array.from({ length: svgTickCount }, (_, i) => i * (800 / svgTickCount)));

	let activeToggles = $derived.by(() => {
		const on = [];
		if (useRafAtEnd) on.push('RAF:end');
		if (useFixedTimestep) on.push('fixedTS');
		if (useSpring) on.push('spring');
		if (useIdleDetection) on.push('idle');
		if (useExtraBufferWrites) on.push('SSBOs');
		if (usePointerRawUpdate) on.push('rawUpdate');
		if (wrapContainStrict) on.push('W:contain');
		if (wrapIsolation) on.push('W:isolation');
		if (wrapTranslateZ) on.push('W:translateZ');
		if (wrapWillChange) on.push('W:will-change');
		if (layerContainStrict) on.push('L:contain');
		if (layerWillChange) on.push('L:will-change');
		if (canvasTranslateZ) on.push('C:translateZ');
		if (canvasContainSize) on.push('C:contain');
		if (canvasWillChange) on.push('C:will-change');
		if (useDesynchronized) on.push('desync');
		if (showDummyCanvas) on.push('dummy2D');
		if (showSvgBg) on.push('SVG-bg');
		if (showSvgFg) on.push('SVG-fg');
		if (showOverlay) on.push('overlay');
		return on.length ? on.join(', ') : 'none';
	});

	// --- Presets ---
	function applyBare() {
		useRafAtEnd = false;
		useFixedTimestep = false;
		useSpring = false;
		useIdleDetection = false;
		usePointerRawUpdate = false;
		useExtraBufferWrites = false;
		wrapContainStrict = false;
		wrapIsolation = false;
		wrapTranslateZ = false;
		wrapWillChange = false;
		layerContainStrict = false;
		layerWillChange = false;
		canvasTranslateZ = false;
		canvasContainSize = false;
		canvasWillChange = false;
		showSvgBg = false;
		showSvgFg = false;
		showOverlay = false;
		useDesynchronized = false;
		resetStats();
		ensureLoopRunning();
	}

	function applyDivePlot() {
		useRafAtEnd = true;
		useFixedTimestep = true;
		useSpring = true;
		useIdleDetection = true;
		usePointerRawUpdate = true;
		useExtraBufferWrites = true;
		wrapContainStrict = true;
		wrapIsolation = true;
		wrapTranslateZ = true;
		wrapWillChange = true;
		layerContainStrict = true;
		layerWillChange = true;
		canvasTranslateZ = true;
		canvasContainSize = true;
		canvasWillChange = true;
		showSvgBg = true;
		showSvgFg = true;
		showOverlay = true;
		useDesynchronized = true;
		resetStats();
		ensureLoopRunning();
	}

	function applyLoopOnly() {
		applyBare();
		useRafAtEnd = true;
		useFixedTimestep = true;
		useSpring = true;
		useIdleDetection = true;
		usePointerRawUpdate = true;
		useExtraBufferWrites = true;
		resetStats();
		ensureLoopRunning();
	}

	function resetStats() {
		jankCount = 0;
		frameCount = 0;
		deltas = [];
	}

	function ensureLoopRunning() {
		if (rafId === null && device) {
			lastTime = performance.now();
			accumulator = 0;
			rafId = requestAnimationFrame(frame);
		}
	}

	// Reconfigure context when desynchronized changes
	$effect(() => {
		const desynced = useDesynchronized;
		if (context && device && format) {
			context.configure({
				device,
				format,
				alphaMode: 'premultiplied',
				desynchronized: desynced
			});
			resetStats();
		}
	});

	// --- Seeded PRNG for reproducible scatter data ---
	function mulberry32(a) {
		return function () {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	// WGSL shader: instanced scatter plot dots
	const shaderCode = /* wgsl */ `
struct Uniforms {
  domainMinX: f32,
  domainMaxX: f32,
  domainMinY: f32,
  domainMaxY: f32,
  screenWidth: f32,
  screenHeight: f32,
  dotRadius: f32,
  numDots: f32,
}

struct Dot {
  x: f32,
  y: f32,
  colorR: f32,
  colorG: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> dots: array<Dot>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) color: vec3f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let dot = dots[ii];

  // Map data coords to normalized [0,1] within current domain
  let nx = (dot.x - uniforms.domainMinX) / (uniforms.domainMaxX - uniforms.domainMinX);
  let ny = (dot.y - uniforms.domainMinY) / (uniforms.domainMaxY - uniforms.domainMinY);

  // Quad vertex offsets (-1 to 1)
  let qx = f32(i32(vi & 1u)) * 2.0 - 1.0;
  let qy = f32(i32(vi >> 1u)) * 2.0 - 1.0;

  // Screen position in pixels
  let sx = nx * uniforms.screenWidth + qx * uniforms.dotRadius;
  let sy = (1.0 - ny) * uniforms.screenHeight + qy * uniforms.dotRadius;

  // To clip space
  let cx = sx / uniforms.screenWidth * 2.0 - 1.0;
  let cy = 1.0 - sy / uniforms.screenHeight * 2.0;

  let color = vec3f(dot.colorR, dot.colorG, 0.7);

  return VSOut(vec4f(cx, cy, 0.0, 1.0), vec2f(qx, qy), color);
}

@fragment
fn fs(input: VSOut) -> @location(0) vec4f {
  let dist = length(input.uv);
  if (dist > 1.0) { discard; }
  let alpha = 1.0 - smoothstep(0.6, 1.0, dist);
  return vec4f(input.color * alpha, alpha);
}
`;

	async function initWebGPU() {
		if (!navigator.gpu) {
			info = 'WebGPU not supported';
			return;
		}

		const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
		device = await adapter.requestDevice();
		format = navigator.gpu.getPreferredCanvasFormat();

		context = canvas.getContext('webgpu');
		context.configure({
			device,
			format,
			alphaMode: 'premultiplied',
			desynchronized: useDesynchronized
		});

		const dpr = window.devicePixelRatio || 1;
		canvas.width = 600 * dpr;
		canvas.height = 600 * dpr;

		const module = device.createShaderModule({ code: shaderCode });

		pipeline = device.createRenderPipeline({
			layout: 'auto',
			vertex: { module, entryPoint: 'vs' },
			fragment: {
				module,
				entryPoint: 'fs',
				targets: [
					{
						format,
						blend: {
							color: {
								srcFactor: 'src-alpha',
								dstFactor: 'one-minus-src-alpha',
								operation: 'add'
							},
							alpha: {
								srcFactor: 'one',
								dstFactor: 'one-minus-src-alpha',
								operation: 'add'
							}
						}
					}
				]
			},
			primitive: {
				topology: 'triangle-strip',
				stripIndexFormat: undefined
			}
		});

		// Generate scatter data
		const rng = mulberry32(42);
		const dotData = new Float32Array(NUM_DOTS * 4); // x, y, colorR, colorG per dot
		for (let i = 0; i < NUM_DOTS; i++) {
			const off = i * 4;
			dotData[off] = rng() * DATA_MAX; // x
			dotData[off + 1] = rng() * DATA_MAX; // y
			dotData[off + 2] = 0.3 + rng() * 0.5; // colorR
			dotData[off + 3] = 0.4 + rng() * 0.4; // colorG
		}
		dotPositions = dotData; // keep JS copy for Canvas 2D

		// Pre-render a dot sprite for fast Canvas 2D blitting
		initDotSprite();

		dotBuffer = device.createBuffer({
			size: dotData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(dotBuffer, 0, dotData);

		// Uniform buffer: 8 floats = 32 bytes
		uniformBuffer = device.createBuffer({
			size: 32,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});

		bindGroup = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: { buffer: dotBuffer } }
			]
		});

		// Extra buffers for SSBO simulation
		for (let i = 0; i < NUM_EXTRA_BUFFERS; i++) {
			extraBuffers.push(
				device.createBuffer({
					size: 64,
					usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
				})
			);
		}

		lastTime = performance.now();
		accumulator = 0;
		rafId = requestAnimationFrame(frame);
		info = 'Drag to pan. Toggle settings and feel for stutter.';
	}

	// --- Canvas 2D setup ---
	function initDotSprite() {
		const dpr = window.devicePixelRatio || 1;
		const r = Math.ceil(DOT_RADIUS * dpr);
		const size = r * 2 + 2;
		const off = new OffscreenCanvas(size, size);
		const c = off.getContext('2d');
		c.beginPath();
		c.arc(size / 2, size / 2, r, 0, Math.PI * 2);
		c.fillStyle = 'rgba(140, 170, 220, 0.8)';
		c.fill();
		dotSprite = off;
	}

	function initCanvas2D() {
		if (!canvas2d) return;
		const dpr = window.devicePixelRatio || 1;
		canvas2d.width = 600 * dpr;
		canvas2d.height = 600 * dpr;
		ctx2d = canvas2d.getContext('2d');
	}

	function renderCanvas2D(rxMin, rxMax, ryMin, ryMax) {
		if (!ctx2d || !dotPositions || !dotSprite) return;
		const w = canvas2d.width;
		const h = canvas2d.height;
		const dpr = window.devicePixelRatio || 1;
		const r = Math.ceil(DOT_RADIUS * dpr);
		const spriteSize = r * 2 + 2;
		const halfSprite = spriteSize / 2;

		// Clear
		ctx2d.fillStyle = 'rgb(15, 15, 26)';
		ctx2d.fillRect(0, 0, w, h);

		// Domain range
		const domainW = rxMax - rxMin;
		const domainH = ryMax - ryMin;
		const scaleX = w / domainW;
		const scaleY = h / domainH;

		// Draw dots using pre-rendered sprite
		for (let i = 0; i < NUM_DOTS; i++) {
			const off = i * 4;
			const sx = (dotPositions[off] - rxMin) * scaleX;
			const sy = (1 - (dotPositions[off + 1] - ryMin) / domainH) * h;

			// Cull offscreen
			if (sx < -r || sx > w + r || sy < -r || sy > h + r) continue;

			ctx2d.drawImage(dotSprite, sx - halfSprite, sy - halfSprite);
		}
	}

	// --- Canvas 2D grid underlay ---
	function initCanvasGrid() {
		if (!canvasGrid) return;
		const dpr = window.devicePixelRatio || 1;
		canvasGrid.width = 600 * dpr;
		canvasGrid.height = 600 * dpr;
		ctxGrid = canvasGrid.getContext('2d');
	}

	function renderGrid(rxMin, rxMax, ryMin, ryMax) {
		if (!ctxGrid) return;
		const w = canvasGrid.width;
		const h = canvasGrid.height;
		const domainW = rxMax - rxMin;
		const domainH = ryMax - ryMin;

		ctxGrid.clearRect(0, 0, w, h);
		ctxGrid.strokeStyle = '#333';
		ctxGrid.lineWidth = 1;

		// Compute nice grid spacing (~10 lines per axis)
		const stepX = niceStep(domainW / 10);
		const stepY = niceStep(domainH / 10);

		// Vertical lines
		const startX = Math.ceil(rxMin / stepX) * stepX;
		for (let x = startX; x <= rxMax; x += stepX) {
			const sx = ((x - rxMin) / domainW) * w;
			ctxGrid.beginPath();
			ctxGrid.moveTo(sx, 0);
			ctxGrid.lineTo(sx, h);
			ctxGrid.stroke();
		}

		// Horizontal lines
		const startY = Math.ceil(ryMin / stepY) * stepY;
		for (let y = startY; y <= ryMax; y += stepY) {
			const sy = (1 - (y - ryMin) / domainH) * h;
			ctxGrid.beginPath();
			ctxGrid.moveTo(0, sy);
			ctxGrid.lineTo(w, sy);
			ctxGrid.stroke();
		}
	}

	function niceStep(rough) {
		const pow = Math.pow(10, Math.floor(Math.log10(rough)));
		const norm = rough / pow;
		if (norm <= 1.5) return pow;
		if (norm <= 3.5) return 2 * pow;
		if (norm <= 7.5) return 5 * pow;
		return 10 * pow;
	}

	// Watch for canvas mounts
	$effect(() => {
		if (canvas2d && showCanvas2D) {
			initCanvas2D();
		}
	});

	$effect(() => {
		if (canvasGrid && show2DGrid) {
			initCanvasGrid();
		}
	});

	const uniformData = new Float32Array(8);

	function frame(time) {
		// --- RAF position: top (default) or bottom (DivePlot style) ---
		if (!useRafAtEnd) {
			rafId = requestAnimationFrame(frame);
		}

		let delta = (time - lastTime) / 1000;
		lastTime = time;
		frameCount++;

		const deltaMs = delta * 1000;
		deltas.push(deltaMs);
		if (deltas.length > 360) deltas.shift();

		if (deltaMs > 12.5 && frameCount > 10) {
			jankCount++;
		}

		if (delta > MAX_DELTA) delta = MAX_DELTA;

		const dpr = window.devicePixelRatio || 1;
		const screenW = 600 * dpr;
		const screenH = 600 * dpr;

		// --- Compute rendered domain ---
		// 4 independent combinations:
		//   spring OFF + fixedTS OFF  = direct (target → render)
		//   spring ON  + fixedTS OFF  = spring stepped once per frame, no accumulator
		//   spring OFF + fixedTS ON   = accumulator loop runs (busywork) but render uses target directly
		//   spring ON  + fixedTS ON   = full DivePlot: accumulator + spring steps + extrapolation
		let renderXMin, renderXMax, renderYMin, renderYMax;

		if (useFixedTimestep) {
			accumulator += delta;
			physicsStepsThisFrame = 0;

			while (accumulator >= DT) {
				if (useSpring) {
					springStep(xMinSpring);
					springStep(xMaxSpring);
					springStep(yMinSpring);
					springStep(yMaxSpring);
				}
				accumulator -= DT;
				physicsStepsThisFrame++;
			}

			if (useSpring) {
				// Extrapolate from spring state
				renderXMin = springGetRenderable(xMinSpring, accumulator);
				renderXMax = springGetRenderable(xMaxSpring, accumulator);
				renderYMin = springGetRenderable(yMinSpring, accumulator);
				renderYMax = springGetRenderable(yMaxSpring, accumulator);
			} else {
				// Accumulator ran but domain is direct
				renderXMin = xMinSpring.target;
				renderXMax = xMaxSpring.target;
				renderYMin = yMinSpring.target;
				renderYMax = yMaxSpring.target;
			}
		} else if (useSpring) {
			// Spring without fixed timestep: step N times to match elapsed time,
			// but no accumulator/extrapolation pattern (all steps in one burst)
			const steps = Math.round(delta / DT);
			for (let i = 0; i < steps; i++) {
				springStep(xMinSpring);
				springStep(xMaxSpring);
				springStep(yMinSpring);
				springStep(yMaxSpring);
			}
			physicsStepsThisFrame = steps;

			renderXMin = xMinSpring.current;
			renderXMax = xMaxSpring.current;
			renderYMin = yMinSpring.current;
			renderYMax = yMaxSpring.current;
		} else {
			// Fully direct: target → render, no spring
			renderXMin = xMinSpring.target;
			renderXMax = xMaxSpring.target;
			renderYMin = yMinSpring.target;
			renderYMax = yMaxSpring.target;
			physicsStepsThisFrame = 0;
		}

		// Keep spring state synced when spring is off (so toggling on doesn't jump)
		if (!useSpring) {
			xMinSpring.current = xMinSpring.target;
			xMaxSpring.current = xMaxSpring.target;
			yMinSpring.current = yMinSpring.target;
			yMaxSpring.current = yMaxSpring.target;
			xMinSpring.velocity = 0;
			xMaxSpring.velocity = 0;
			yMinSpring.velocity = 0;
			yMaxSpring.velocity = 0;
		}

		// --- Extra buffer writes (only when GPU is rendering) ---
		if (useExtraBufferWrites && showWebGPU) {
			for (let i = 0; i < NUM_EXTRA_BUFFERS; i++) {
				extraBufferData[0] = renderXMin + i;
				extraBufferData[1] = renderXMax;
				extraBufferData[2] = renderYMin;
				extraBufferData[3] = renderYMax;
				device.queue.writeBuffer(extraBuffers[i], 0, extraBufferData);
			}
		}

		// WebGPU render
		if (showWebGPU) {
			uniformData[0] = renderXMin;
			uniformData[1] = renderXMax;
			uniformData[2] = renderYMin;
			uniformData[3] = renderYMax;
			uniformData[4] = screenW;
			uniformData[5] = screenH;
			uniformData[6] = DOT_RADIUS * dpr;
			uniformData[7] = NUM_DOTS;
			device.queue.writeBuffer(uniformBuffer, 0, uniformData);

			const texture = context.getCurrentTexture();
			const encoder = device.createCommandEncoder();
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: texture.createView(),
						loadOp: 'clear',
						storeOp: 'store',
						clearValue: { r: 0.06, g: 0.06, b: 0.1, a: 1 }
					}
				]
			});
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, bindGroup);
			pass.draw(4, NUM_DOTS);
			pass.end();
			device.queue.submit([encoder.finish()]);
		}

		// Canvas 2D reference render (same domain, same frame)
		if (showCanvas2D && ctx2d) {
			renderCanvas2D(renderXMin, renderXMax, renderYMin, renderYMax);
		}

		// 2D grid underlay (lightweight — just grid lines beneath WebGPU)
		if (show2DGrid && ctxGrid) {
			renderGrid(renderXMin, renderXMax, renderYMin, renderYMax);
		}

		// Dummy canvas (1x1 separate compositor layer)
		if (showDummyCanvas) {
			renderDummyCanvas();
		}

		// Stats
		if (frameCount % 60 === 0) {
			const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
			const maxDelta = Math.max(...deltas.slice(-120));
			const fps = (1000 / avg).toFixed(1);
			const stepsInfo = useFixedTimestep ? ` | Steps: ${physicsStepsThisFrame}` : '';
			info = `FPS: ${fps} | Avg: ${avg.toFixed(2)}ms | Max(2s): ${maxDelta.toFixed(2)}ms | Janks(>12.5ms): ${jankCount}${stepsInfo}`;
		}

		// --- RAF at end + idle detection ---
		if (useRafAtEnd) {
			if (useIdleDetection) {
				const atRest = useSpring
					? springIsAtRest(xMinSpring) &&
						springIsAtRest(xMaxSpring) &&
						springIsAtRest(yMinSpring) &&
						springIsAtRest(yMaxSpring)
					: true; // no spring = always at rest when not dragging
				if (!isDragging && atRest) {
					rafId = null;
					return;
				}
			}
			rafId = requestAnimationFrame(frame);
		}
	}

	// --- Pointer handlers (simulate DivePlot panning exactly) ---
	function trackPointerRate() {
		const now = performance.now();
		pointerEvents.push(now);
		// Keep last 1 second of events
		while (pointerEvents.length > 0 && pointerEvents[0] < now - 1000) {
			pointerEvents.shift();
		}
		pointerRate = pointerEvents.length;
	}

	function handlePointerDown(e) {
		isDragging = true;
		lastDragX = e.clientX;
		lastDragY = e.clientY;
		panStartDomainXMin = xMinSpring.target;
		panStartDomainXMax = xMaxSpring.target;
		panStartDomainYMin = yMinSpring.target;
		panStartDomainYMax = yMaxSpring.target;
		panStartScreenX = e.clientX;
		panStartScreenY = e.clientY;
		springConfigure(xMinSpring, PAN_STIFFNESS);
		springConfigure(xMaxSpring, PAN_STIFFNESS);
		springConfigure(yMinSpring, PAN_STIFFNESS);
		springConfigure(yMaxSpring, PAN_STIFFNESS);
		e.target.setPointerCapture(e.pointerId);
		ensureLoopRunning();
	}

	function applyPanFromPointer(clientX, clientY) {
		trackPointerRate();
		const screenDx = clientX - panStartScreenX;
		const screenDy = clientY - panStartScreenY;
		const domainWidth = panStartDomainXMax - panStartDomainXMin;
		const domainHeight = panStartDomainYMax - panStartDomainYMin;
		const dataDx = -(screenDx / 600) * domainWidth;
		const dataDy = (screenDy / 600) * domainHeight;
		xMinSpring.target = panStartDomainXMin + dataDx;
		xMaxSpring.target = panStartDomainXMax + dataDx;
		yMinSpring.target = panStartDomainYMin + dataDy;
		yMaxSpring.target = panStartDomainYMax + dataDy;
	}

	function handlePointerMove(e) {
		if (!isDragging) return;
		// Skip if pointerrawupdate is handling it
		if (usePointerRawUpdate && hasPointerRawUpdate) return;
		applyPanFromPointer(e.clientX, e.clientY);
	}

	function handlePointerRawUpdate(e) {
		if (!isDragging) return;
		if (!usePointerRawUpdate) return;
		applyPanFromPointer(e.clientX, e.clientY);
	}

	function handlePointerUp(e) {
		isDragging = false;
		springConfigure(xMinSpring, DEFAULT_STIFFNESS);
		springConfigure(xMaxSpring, DEFAULT_STIFFNESS);
		springConfigure(yMinSpring, DEFAULT_STIFFNESS);
		springConfigure(yMaxSpring, DEFAULT_STIFFNESS);
		e.target.releasePointerCapture(e.pointerId);
	}

	function handlePointerEnter() {
		ensureLoopRunning();
	}

	function handleWheel(e) {
		e.preventDefault();
		const scaleFactor =
			e.deltaY < 0 ? 1 + Math.abs(e.deltaY) * 0.003 : 1 / (1 + Math.abs(e.deltaY) * 0.003);
		// Zoom around cursor — use whichever canvas wrapper received the event
		const rect = e.currentTarget.getBoundingClientRect();
		const nx = (e.clientX - rect.left) / rect.width;
		const ny = 1 - (e.clientY - rect.top) / rect.height;
		const domainX = xMinSpring.target + nx * (xMaxSpring.target - xMinSpring.target);
		const domainY = yMinSpring.target + ny * (yMaxSpring.target - yMinSpring.target);
		xMinSpring.target = domainX + (xMinSpring.target - domainX) / scaleFactor;
		xMaxSpring.target = domainX + (xMaxSpring.target - domainX) / scaleFactor;
		yMinSpring.target = domainY + (yMinSpring.target - domainY) / scaleFactor;
		yMaxSpring.target = domainY + (yMaxSpring.target - domainY) / scaleFactor;
		ensureLoopRunning();
	}

	function handleDblClick() {
		xMinSpring.target = DATA_MIN;
		xMaxSpring.target = DATA_MAX;
		yMinSpring.target = DATA_MIN;
		yMaxSpring.target = DATA_MAX;
		ensureLoopRunning();
	}

	onMount(() => {
		initWebGPU();
	});

	onDestroy(() => {
		if (rafId) cancelAnimationFrame(rafId);
	});
</script>

<div class="page">
	<h2>Jank Bisect — Scatter Plot Pan Test</h2>
	<p class="info">{info}</p>
	<p class="info ptr-rate">
		Pointer events/sec: <strong>{pointerRate}</strong>
		{pointerRate < 60 ? '— low, try mouse or click-drag' : ''}
	</p>
	<p class="active">Active: {activeToggles}</p>

	<div class="layout">
		<div class="controls">
			<div class="group">
				<strong>Presets</strong>
				<div class="row">
					<button onclick={applyBare}>Bare</button>
					<button onclick={applyLoopOnly}>Loop only</button>
					<button onclick={applyDivePlot}>Full DivePlot</button>
					<button onclick={resetStats}>Reset Stats</button>
					<button
						class="toggle-canvas"
						class:active-btn={showWebGPU}
						onclick={() => (showWebGPU = !showWebGPU)}
					>
						GPU {showWebGPU ? 'ON' : 'OFF'}
					</button>
					<button
						class="toggle-canvas"
						class:active-btn={showCanvas2D}
						onclick={() => (showCanvas2D = !showCanvas2D)}
					>
						2D {showCanvas2D ? 'ON' : 'OFF'}
					</button>
					<button
						class="toggle-canvas"
						class:active-btn={show2DGrid}
						onclick={() => (show2DGrid = !show2DGrid)}
					>
						Grid
					</button>
				</div>
			</div>

			<div class="group">
				<strong>Animation Loop</strong>
				<label
					><input type="checkbox" bind:checked={useRafAtEnd} onchange={resetStats} /> RAF at end of
					frame
					<span class="note-inline">(vs top)</span></label
				>
				<label
					><input type="checkbox" bind:checked={useFixedTimestep} onchange={resetStats} /> Fixed
					timestep 360Hz
					<span class="note-inline">(accumulator loop)</span></label
				>
				<label
					><input type="checkbox" bind:checked={useSpring} onchange={resetStats} /> Spring physics
					<span class="note-inline">(critically-damped, stiffness 600)</span></label
				>
				<label
					><input type="checkbox" bind:checked={useIdleDetection} onchange={resetStats} /> Idle
					detection
					<span class="note-inline">(stop/start RAF)</span></label
				>
				<label
					><input type="checkbox" bind:checked={usePointerRawUpdate} onchange={resetStats} />
					pointerrawupdate
					<span class="note-inline">{hasPointerRawUpdate ? '(available)' : '(not supported)'}</span
					></label
				>
				<label
					><input type="checkbox" bind:checked={useExtraBufferWrites} onchange={resetStats} />
					Extra buffer writes
					<span class="note-inline">(6x writeBuffer/frame)</span></label
				>
			</div>

			<div class="group">
				<strong>Wrapper (.chart-container)</strong>
				<label
					><input type="checkbox" bind:checked={wrapContainStrict} onchange={resetStats} /> contain:
					strict</label
				>
				<label
					><input type="checkbox" bind:checked={wrapIsolation} onchange={resetStats} /> isolation: isolate</label
				>
				<label
					><input type="checkbox" bind:checked={wrapTranslateZ} onchange={resetStats} /> transform: translateZ(0)</label
				>
				<label
					><input type="checkbox" bind:checked={wrapWillChange} onchange={resetStats} /> will-change:
					transform</label
				>
			</div>

			<div class="group">
				<strong>Canvas Layer (.canvas-layer)</strong>
				<label
					><input type="checkbox" bind:checked={layerContainStrict} onchange={resetStats} /> contain:
					strict</label
				>
				<label
					><input type="checkbox" bind:checked={layerWillChange} onchange={resetStats} /> will-change:
					transform</label
				>
			</div>

			<div class="group">
				<strong>Canvas Element</strong>
				<label
					><input type="checkbox" bind:checked={canvasTranslateZ} onchange={resetStats} /> transform:
					translateZ(0)</label
				>
				<label
					><input type="checkbox" bind:checked={canvasContainSize} onchange={resetStats} /> contain:
					size</label
				>
				<label
					><input type="checkbox" bind:checked={canvasWillChange} onchange={resetStats} /> will-change:
					transform</label
				>
			</div>

			<div class="group">
				<strong>Context Options</strong>
				<label
					><input type="checkbox" bind:checked={useDesynchronized} /> desynchronized
					<span class="note-inline">(reconfigures context)</span></label
				>
			</div>

			<div class="group">
				<strong>DOM Siblings</strong>
				<label
					><input type="checkbox" bind:checked={showDummyCanvas} onchange={resetStats} /> Dummy
					Canvas 2D
					<span class="note-inline">({dummySize}×{dummySize}px, outside wrapper)</span></label
				>
				{#if showDummyCanvas}
					<label class="range"
						>Size: <input type="range" min="1" max="600" bind:value={dummySize} />
						{dummySize}px</label
					>
					<label
						><input type="checkbox" bind:checked={dummyDrawWork} /> fillRect each frame
						<span class="note-inline">(vs clearRect only)</span></label
					>
				{/if}
				<label
					><input type="checkbox" bind:checked={showSvgBg} onchange={resetStats} /> SVG background (z-index:
					1)</label
				>
				<label
					><input type="checkbox" bind:checked={showSvgFg} onchange={resetStats} /> SVG foreground (z-index:
					3)</label
				>
				<label
					><input type="checkbox" bind:checked={showOverlay} onchange={resetStats} /> Overlay div (z-index:
					10)</label
				>
				{#if showSvgBg || showSvgFg}
					<label class="range"
						>Ticks: <input type="range" min="0" max="50" bind:value={svgTickCount} />
						{svgTickCount}</label
					>
				{/if}
			</div>
		</div>

		<div class="canvases">
			<!-- WebGPU canvas -->
			{#if showWebGPU}
				<div class="canvas-col">
					<div class="canvas-label">WebGPU</div>
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="chart-wrapper"
						class:cw-contain-strict={wrapContainStrict}
						class:cw-isolation={wrapIsolation}
						class:cw-translate-z={wrapTranslateZ}
						class:cw-will-change={wrapWillChange}
						onpointerdown={handlePointerDown}
						onpointermove={handlePointerMove}
						onpointerrawupdate={handlePointerRawUpdate}
						onpointerup={handlePointerUp}
						onpointercancel={handlePointerUp}
						onpointerenter={handlePointerEnter}
						onwheel={handleWheel}
						ondblclick={handleDblClick}
					>
						{#if show2DGrid}
							<canvas
								bind:this={canvasGrid}
								class="grid-underlay"
								style="width: 600px; height: 600px;"
							></canvas>
						{/if}

						{#if showSvgBg}
							<svg class="svg-bg" width="600" height="600">
								{#each ticks as y, i (i)}
									<line x1="0" x2="600" y1={y} y2={y} stroke="#333" />
								{/each}
								{#each ticks as x, i (i)}
									<line x1={x} x2={x} y1="0" y2="600" stroke="#333" />
								{/each}
							</svg>
						{/if}

						<div
							class="canvas-layer"
							class:cl-contain-strict={layerContainStrict}
							class:cl-will-change={layerWillChange}
						>
							<canvas
								bind:this={canvas}
								class:cv-translate-z={canvasTranslateZ}
								class:cv-contain-size={canvasContainSize}
								class:cv-will-change={canvasWillChange}
								style="width: 600px; height: 600px;"
							></canvas>
						</div>

						{#if showSvgFg}
							<svg class="svg-fg" width="600" height="600">
								{#each ticks as x, i (i)}
									<line x1={x} x2={x} y1="590" y2="600" stroke="#888" />
								{/each}
							</svg>
						{/if}

						{#if showOverlay}
							<div class="overlay-layer">
								<div class="overlay-content">overlay</div>
							</div>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Canvas 2D reference -->
			{#if showCanvas2D}
				<div class="canvas-col">
					<div class="canvas-label">Canvas 2D (reference)</div>
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="chart-wrapper chart-wrapper-2d"
						onpointerdown={handlePointerDown}
						onpointermove={handlePointerMove}
						onpointerrawupdate={handlePointerRawUpdate}
						onpointerup={handlePointerUp}
						onpointercancel={handlePointerUp}
						onpointerenter={handlePointerEnter}
						onwheel={handleWheel}
						ondblclick={handleDblClick}
					>
						<canvas bind:this={canvas2d} style="width: 600px; height: 600px;"></canvas>
					</div>
				</div>
			{/if}
		</div>
	</div>

	{#if showDummyCanvas}
		<canvas
			bind:this={dummyCanvas}
			class="dummy-canvas"
			style="width: {dummySize}px; height: {dummySize}px;"
		></canvas>
	{/if}

	<p class="note">
		Drag on either canvas to pan both. Same domain, same frame. Compare WebGPU vs Canvas 2D
		smoothness.<br />
		Scroll to zoom, double-click to reset.
	</p>

	<details class="investigation">
		<summary>Investigation Log — Chrome 120fps Microstutter</summary>

		<h3>The Problem</h3>
		<p>
			DivePlot shows intermittent microstutter/jank when panning on Chrome at 120fps. Safari 26 with
			WebGPU is buttery smooth. The jank manifests as periods of lower perceived refresh rate that
			come and go during interaction.
		</p>

		<h3>Confirmed Facts</h3>
		<ul>
			<li>RAF cadence is perfect: avg 8.33ms, max 9.7ms, zero frames over 10ms</li>
			<li>JS work time is 1.5ms — well within the 8.33ms frame budget</li>
			<li>Chrome FPS counter shows 120fps throughout</li>
			<li>GPU timing queries show fast execution</li>
			<li>
				<code>/test/gpu-minimal</code> (standalone WebGPU, no DivePlot) is smooth on the same Chrome
			</li>
			<li>Safari 26 is buttery smooth with identical DivePlot code</li>
		</ul>

		<h3>Phase 1: DivePlot Component Testing (all no improvement)</h3>
		<table>
			<thead>
				<tr><th>Test</th><th>Change</th><th>Result</th></tr>
			</thead>
			<tbody>
				<tr
					><td>SVG layers off</td><td>Removed SVG axis/grid components</td><td>No difference</td
					></tr
				>
				<tr><td>MSAA off</td><td>msaaSampleCount: 4 → 1</td><td>No difference</td></tr>
				<tr
					><td>Svelte reactivity off</td><td>Commented out _version++ in updateRenderState</td><td
						>No difference</td
					></tr
				>
				<tr
					><td>SSBO fresh buffer/frame</td><td>New GPUBuffer + GPUBindGroup each frame</td><td
						>No difference</td
					></tr
				>
				<tr
					><td>Extrapolation off</td><td>#onRender(0) instead of #onRender(accumulator)</td><td
						>Slightly different, still bad</td
					></tr
				>
				<tr
					><td>desynchronized off</td><td>Removed desynchronized: true</td><td>Slightly worse</td
					></tr
				>
				<tr
					><td>desynchronized + CSS</td><td>Removed desynchronized + will-change + translateZ</td
					><td>Worse</td></tr
				>
				<tr
					><td>Render pass → clear</td><td>Only color clear, no marks/MSAA/bind groups</td><td
						>Couldn't evaluate (no motion)</td
					></tr
				>
			</tbody>
		</table>

		<h3>Ruled Out</h3>
		<ul>
			<li>
				WebGPU object lifecycle (pipelines, MSAA textures, render pass descriptors, bind groups —
				all cached)
			</li>
			<li>Per-frame allocations (only standard WebGPU ops)</li>
			<li>Buffer barriers (fresh buffer per frame didn't help)</li>
			<li>Svelte framework overhead (disabling _version++ had no effect)</li>
			<li>SVG/DOM mutations (turning off all SVG had no effect)</li>
			<li>MSAA resolve cost (sample count 1 had no effect)</li>
		</ul>

		<h3>Phase 2: CSS/DOM Bisect (this page)</h3>
		<p>
			Built this isolated test page replicating DivePlot's DOM structure (contain: strict,
			isolation: isolate, translateZ(0), will-change, z-indexed SVG/canvas/overlay layers).
		</p>
		<p>
			<strong>Result: "Full DivePlot" CSS preset looked smooth.</strong>
			CSS properties and DOM structure alone are NOT the cause.
		</p>

		<h3>Phase 3: Animation Loop Bisect</h3>
		<p>Added toggles for DivePlot's runtime behaviors:</p>
		<ul>
			<li><strong>RAF at end</strong> — requestAnimationFrame after submit (vs top of frame)</li>
			<li>
				<strong>Fixed timestep 360Hz</strong> — accumulator loop, ~3 physics steps per 120fps frame
			</li>
			<li>
				<strong>Spring physics</strong> — critically-damped spring (stiffness 600 for pan, 400 default)
			</li>
			<li><strong>Idle detection</strong> — stop/start RAF on interaction boundaries</li>
			<li>
				<strong>Extra buffer writes</strong> — 6× writeBuffer per frame simulating SSBO updates
			</li>
			<li><strong>pointerrawupdate</strong> — higher-frequency input events</li>
		</ul>

		<h3>Phase 3 Findings</h3>
		<ul>
			<li>
				Pointer event rate is ~110Hz (pointermove) / ~123Hz (pointerrawupdate) — input frequency is
				fine
			</li>
			<li>
				<strong>Bare mode (direct domain, no spring) feels WORSE than with spring</strong> — the spring
				provides temporal smoothing of discrete pointer events, which is essential at 120fps
			</li>
			<li>Spring + fixed timestep still shows some perceived jank on WebGPU</li>
		</ul>

		<h3>Phase 4: Canvas 2D Reference</h3>
		<p>
			Added a Canvas 2D scatter plot side-by-side with WebGPU, sharing the same domain springs. Both
			render in the same RAF callback, same pointer events, same frame.
		</p>
		<p>
			<strong
				>Key observation: WebGPU canvas may feel smoother when a Canvas 2D element is also present
				on the page</strong
			> — suggesting Chrome's compositor changes scheduling behavior with mixed rendering contexts.
		</p>
		<p>
			The "Grid" toggle adds a lightweight Canvas 2D layer underneath the WebGPU canvas
			(domain-aware grid lines only) to test if a layered 2D canvas affects WebGPU presentation
			without the overhead of rendering 3000 dots.
		</p>

		<h3>Current Hypothesis</h3>
		<p>
			The issue lives between <code>queue.submit()</code> and pixels appearing on screen — Chrome's internal
			presentation/compositor pipeline. Our code submits perfectly-timed, fast-executing frames, but
			Chrome delivers them to the 120Hz display unevenly. This does NOT happen on Safari or on simpler
			WebGPU pages within the same Chrome. The presence of a Canvas 2D element may influence Chrome's
			compositor scheduling heuristics in a way that improves WebGPU frame pacing.
		</p>

		<h3>Remaining Unknowns</h3>
		<ul>
			<li>Does a Chrome Performance trace (Frames lane) show compositor-level frame drops?</li>
			<li>
				Does a production build (<code>npm run build && npm run preview</code>) behave differently?
			</li>
			<li>
				Do Chrome flags (<code>chrome://flags/#enable-webgpu-developer-features</code>) affect it?
			</li>
			<li>Is the effect reproducible with a dummy Canvas 2D (just clear, no drawing)?</li>
			<li>
				Does the number/complexity of WebGPU draw calls matter, or is it purely a presentation
				issue?
			</li>
		</ul>
	</details>
</div>

<style>
	.page {
		padding: 1.5rem;
		font-family: system-ui;
		background: #1a1a2e;
		color: #e0e0e0;
		min-height: 100vh;
	}
	h2 {
		margin: 0 0 8px;
		color: #fff;
	}
	.info {
		font-family: monospace;
		font-size: 13px;
		background: #2a2a3e;
		padding: 6px 10px;
		border-radius: 4px;
		margin: 8px 0;
		color: #9be;
	}
	.ptr-rate {
		margin: 2px 0;
		min-height: 1.3em;
	}
	.ptr-rate strong {
		color: #fc6;
	}
	.active {
		font-family: monospace;
		font-size: 12px;
		color: #8a8;
		margin: 4px 0 12px;
	}
	.layout {
		display: flex;
		gap: 20px;
		align-items: flex-start;
	}
	.controls {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 280px;
		font-size: 13px;
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 10px;
		background: #22223a;
		border-radius: 6px;
		border: 1px solid #333;
	}
	.group strong {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #8af;
		margin-bottom: 2px;
	}
	.controls label {
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.row {
		display: flex;
		gap: 6px;
	}
	.row button {
		padding: 4px 10px;
		cursor: pointer;
		background: #334;
		color: #ccc;
		border: 1px solid #555;
		border-radius: 4px;
		font-size: 12px;
	}
	.row button:hover {
		background: #445;
	}
	.toggle-canvas {
		margin-left: 0;
	}
	.toggle-canvas:first-of-type {
		margin-left: auto;
	}
	.active-btn {
		background: #354 !important;
		border-color: #6a8 !important;
		color: #afa !important;
	}
	.note-inline {
		font-size: 11px;
		color: #888;
	}
	.range {
		gap: 8px;
	}

	/* === Canvas columns === */
	.canvases {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
	}
	.canvas-col {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.canvas-label {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #8af;
		padding-left: 2px;
	}

	/* === Chart wrapper === */
	.chart-wrapper {
		position: relative;
		width: 600px;
		height: 600px;
		border: 1px solid #444;
		touch-action: none;
		overscroll-behavior: none;
		cursor: grab;
		flex-shrink: 0;
	}
	.chart-wrapper-2d {
		border-color: #554;
	}
	.chart-wrapper:active {
		cursor: grabbing;
	}
	.cw-contain-strict {
		contain: strict;
	}
	.cw-isolation {
		isolation: isolate;
	}
	.cw-translate-z {
		transform: translateZ(0);
	}
	.cw-will-change {
		will-change: transform;
	}

	/* === 2D grid underlay === */
	.grid-underlay {
		position: absolute;
		top: 0;
		left: 0;
		z-index: 5;
		pointer-events: none;
	}

	/* === SVG layers === */
	.svg-bg,
	.svg-fg {
		position: absolute;
		top: 0;
		left: 0;
		pointer-events: none;
	}
	.svg-bg {
		z-index: 1;
	}
	.svg-fg {
		z-index: 3;
	}

	/* === Canvas layer === */
	.canvas-layer {
		position: absolute;
		top: 0;
		left: 0;
		z-index: 2;
		width: 100%;
		height: 100%;
	}
	.cl-contain-strict {
		contain: strict;
	}
	.cl-will-change {
		will-change: transform;
	}

	/* === Canvas element === */
	canvas {
		display: block;
	}
	.cv-translate-z {
		transform: translateZ(0);
	}
	.cv-contain-size {
		contain: size;
	}
	.cv-will-change {
		will-change: transform;
	}

	/* === Overlay === */
	.overlay-layer {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		z-index: 10;
		pointer-events: none;
	}
	.overlay-content {
		position: absolute;
		bottom: 8px;
		right: 8px;
		padding: 4px 8px;
		background: rgba(0, 0, 0, 0.5);
		color: #888;
		font-size: 11px;
		border-radius: 3px;
		pointer-events: auto;
	}

	.dummy-canvas {
		display: block;
		border: 1px solid #333;
	}
	.note {
		font-size: 12px;
		color: #888;
		margin-top: 16px;
		line-height: 1.5;
	}

	/* === Investigation log === */
	.investigation {
		margin-top: 24px;
		padding: 16px;
		background: #1e1e32;
		border: 1px solid #333;
		border-radius: 8px;
		font-size: 13px;
		line-height: 1.6;
		max-width: 900px;
	}
	.investigation summary {
		cursor: pointer;
		font-weight: bold;
		font-size: 14px;
		color: #aaf;
		padding: 4px 0;
	}
	.investigation h3 {
		color: #8cf;
		font-size: 13px;
		margin: 16px 0 6px;
		border-bottom: 1px solid #2a2a44;
		padding-bottom: 4px;
	}
	.investigation p {
		margin: 6px 0;
		color: #bbb;
	}
	.investigation ul {
		margin: 6px 0;
		padding-left: 20px;
		color: #bbb;
	}
	.investigation li {
		margin: 3px 0;
	}
	.investigation strong {
		color: #fc6;
	}
	.investigation code {
		background: #2a2a44;
		padding: 1px 5px;
		border-radius: 3px;
		font-size: 12px;
		color: #9be;
	}
	.investigation table {
		border-collapse: collapse;
		margin: 8px 0;
		font-size: 12px;
		width: 100%;
	}
	.investigation th,
	.investigation td {
		border: 1px solid #333;
		padding: 4px 8px;
		text-align: left;
	}
	.investigation th {
		background: #2a2a44;
		color: #8af;
	}
	.investigation td {
		color: #bbb;
	}
</style>
