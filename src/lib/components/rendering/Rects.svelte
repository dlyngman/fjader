<script lang="ts">
	import { UNIFORM_BYTES } from './uniform-sizes';
	import { getContext, onMount, onDestroy } from 'svelte';
	import { RendererHost } from './RendererHost.svelte';
	import { getGPUContext } from '$lib/gpu';
	import { DEFAULT_FILL_COLOR } from '$lib/scales/color-utils';
	import type { ChartContext, WebGPUCanvasContext } from '$lib/types';
	import type { SplitProp } from '../marks/lifecycle/other-rows.svelte';
	import { activityReads, markActivityWGSL, otherRowActivityWGSL } from './activity-reads';

	const rectRendererDefinition = {
		x: { concept: 'extent', channels: ['x0', 'x1'] },
		y: { concept: 'extent', channels: ['y0', 'y1'] },
		placeholders: { x: '{{X_AXIS_LOGIC}}', y: '{{Y_AXIS_LOGIC}}' }
	};

	// Named Bindings for safety
	const BINDINGS = {
		X0: 0,
		X1: 1,
		Y0: 2,
		Y1: 3,
		COLOR: 4,
		ALPHA: 5,
		CONSTANTS: 6,
		/**
		 * An Other bar's selected share, per row: 0 on rows that are not an Other
		 * (so the zero-filled stand-in buffer means "no split anywhere"), `1 +
		 * share` on one. Morphed with the bar's length.
		 *
		 * The vertex stage's 8th storage buffer: six channels, the identity slot
		 * table and this fill WebGPU's default maxStorageBuffersPerShaderStage. A
		 * further per-row channel needs another container (an instance vertex
		 * attribute) or a raised device limit.
		 */
		SHARE: 7
	};

	// Facet uses vertex buffer slot 1 (not a storage binding)
	const FACET_VERTEX_SLOT = 1;

	// Uniform struct offsets (matching WGSL MarkConstants layout)
	const UNIFORM_OFFSETS = {
		COLOR_MODE: 0,
		COLOR_SCALE_INDEX: 4,
		INSET: 8,
		GROUP_INDEX: 12,
		CONSTANT_COLOR: 16,
		DX: 32,
		DY: 36,
		OTHER_COLOR_ON_BAND: 40,
		SPLIT_ALONG_X: 44
	};

	interface Props {
		x0Data: Float32Array;
		x1Data: Float32Array;
		y0Data: Float32Array;
		y1Data: Float32Array;
		colorValueData: Float32Array | null;
		alphaData: Float32Array | null;
		/**
		 * A bar's selected share per row (see BINDINGS.SHARE), or null for none: a
		 * bar mark with a topN Other bucket passes its lifecycle's `otherRows.split`.
		 * The fragment draws the bar above the share dimmed.
		 */
		share?: SplitProp | null;
		facetData?: Float32Array | null;
		dataVersion: number;
		zIndex?: number;
		colorMode?: number;
		colorScaleIndex?: number;
		/** The page-wide index of this mark's filter group: which run of a field's activity block it reads. */
		groupIndex?: number;
		constantColor?: [number, number, number, number];
		inset?: number;
		dx?: number;
		dy?: number;
		markId?: string;
		/**
		 * The band axis, when this mark's rows are one per category in category
		 * order and may therefore morph. null to morph nothing.
		 *
		 * The OTHER axis's channels morph. The band's never do: they carry a
		 * category id that the shader resolves through the slot table, and
		 * interpolating an identity produces a fraction that resolves to some
		 * other category. Position already animates, through the slot table.
		 */
		bandAxis?: 'x' | 'y' | null;
	}

	let {
		x0Data,
		x1Data,
		y0Data,
		y1Data,
		colorValueData,
		alphaData,
		share = null,
		facetData = null,
		dataVersion,
		zIndex = 0,
		colorMode = 0,
		colorScaleIndex = 0,
		groupIndex = 0,
		constantColor = DEFAULT_FILL_COLOR,
		inset = 0,
		dx = 0,
		dy = 0,
		markId = '',
		bandAxis = null
	}: Props = $props();

	const splitData = $derived(share?.data ?? null);
	const splitSlides = $derived(share?.slides ?? true);
	// Bars grouped on y run along x, so their split does too.
	const splitAlongX = $derived(share?.axis === 'y');
	const otherColorOnBand = $derived(share?.colorOnBand ?? false);
	const morphX = $derived(bandAxis === 'y');
	const morphY = $derived(bandAxis === 'x');

	const chartContext = getContext<ChartContext>('chart');
	const webGPUContext = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const gpuCoordinator = getGPUContext();
	const faceted = !!chartContext.fx;
	const effectiveMarkType = faceted ? 'rects-faceted' : 'rects';

	// --- Facet compile-time specialization ---
	// Facet index arrives as a vertex attribute (stepMode: instance), not a storage buffer.
	const FACET_DISCARD_WGSL = `
      // Facet filtering: discard vertices not belonging to this cell
      if (u32(facetIdx) != frameUniforms.activeFacetIdx) {
        var degen: VertexOutput;
        degen.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return degen;
      }`;

	const host = new RendererHost({
		markType: effectiveMarkType,
		webGPUContext,
		gpuCoordinator,
		chartContext,
		zIndex,
		label: 'Rects'
	});
	const renderer = $derived(host.renderer);
	const initializationError = $derived(host.error);
	let rectGeometryBuffer: GPUBuffer;

	const rectVertexCount = 6;

	/** The selection activities this shader reads; routing reads the same table. */
	const ACTIVITY_READS = activityReads('rects');

	const rectsShaderCode = `
    // MarkConstants uniform for per-mark configuration
    struct MarkConstants {
      colorMode: u32,           // 0 = constant, 1 = scale
      colorScaleIndex: u32,     // Index into colorConfigs
      inset: f32,               // Pixel inset on all sides
      groupIndex: u32,          // Page-wide filter group index, for activity reads
      constantColor: vec4<f32>, // Used when colorMode = 0
      dx: f32,                  // Horizontal pixel offset
      dy: f32,                  // Vertical pixel offset
      otherColorOnBand: u32,    // 1: an Other row skips its colour activity too
      splitAlongX: u32,         // 1: an Other bar splits along x (horizontal bars)
    };
    @group(1) @binding(6) var<uniform> markConstants: MarkConstants;

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) colorValue: f32,   // Raw value for scale lookup
      @location(1) alpha: f32,
      // The Other bar's selected share, or -1 on every other row; and where this
      // fragment sits along the bar, 0 at its base, 1 at its end.
      @location(2) @interpolate(flat) share: f32,
      @location(3) along: f32,
      // An Other bar's unselected part: dimmed by the other fields' activity and
      // by the field's free slot, so it fades as the rest of the chart does.
      @location(4) alphaRest: f32,
    };

    @group(1) @binding(0) var<storage, read> x0Values: array<f32>;
    @group(1) @binding(1) var<storage, read> x1Values: array<f32>;
    @group(1) @binding(2) var<storage, read> y0Values: array<f32>;
    @group(1) @binding(3) var<storage, read> y1Values: array<f32>;
    @group(1) @binding(4) var<storage, read> colorValues: array<f32>;
    @group(1) @binding(5) var<storage, read> alphaValues: array<f32>;
    @group(1) @binding(7) var<storage, read> splitValues: array<f32>;

    @vertex
    fn vertexMain(
      @location(0) rectCorner: vec2<f32>,
      @builtin(instance_index) instanceIdx: u32,
      {{FACET_PARAM}}
    ) -> VertexOutput {
      {{FACET_DISCARD}}
      let x0 = x0Values[instanceIdx];
      let x1 = x1Values[instanceIdx];
      let y0 = y0Values[instanceIdx];
      let y1 = y1Values[instanceIdx];
      let alpha = alphaValues[instanceIdx];
      let colorValue = colorValues[instanceIdx];

      // X axis scaling (generated based on scale type)
      {{X_AXIS_LOGIC}}

      // Y axis scaling (generated based on scale type)
      {{Y_AXIS_LOGIC}}

      // Apply inset (shrink rect inward on all sides)
      let ix = markConstants.inset * sign(scaledX1 - scaledX0);
      let iy = markConstants.inset * sign(scaledY1 - scaledY0);

      // Interpolate rectangle corners and apply pixel offsets
      let finalX = mix(scaledX0 + ix, scaledX1 - ix, rectCorner.x) + markConstants.dx;
      let finalY = mix(scaledY0 + iy, scaledY1 - iy, rectCorner.y) + markConstants.dy;

      // Convert to normalized device coordinates
      let worldPos = vec2<f32>(finalX, finalY);
      let normalizedPos = (worldPos / frameUniforms.resolution) * 2.0 - 1.0;

      var output: VertexOutput;
      output.position = vec4<f32>(normalizedPos.x, -normalizedPos.y, 0.0, 1.0);
      output.colorValue = colorValue;
      // An Other row (split > 0) is drawn in two parts, mixed in the fragment at
      // its share. Below: as any bar, by its full activity, its own field's
      // included, so it dims and lights with the bucket's lit state (#23). Above:
      // by the other fields' activity and the field's free slot, so it is lit
      // only while nothing is selected. Both fade on the selection clock, and the
      // split only moves when the share moves between two parts that differ.
      let split = splitValues[instanceIdx];
      let isOther = split > 0.5;
      output.share = select(-1.0, split - 1.0, isOther);
      output.along = select(rectCorner.y, rectCorner.x, markConstants.splitAlongX == 1u);
      let activity = ${markActivityWGSL(ACTIVITY_READS, {
				color: 'markConstants.colorMode, markConstants.colorScaleIndex, colorValue',
				x: 'x0',
				y: 'y0',
				group: 'markConstants.groupIndex'
			})};
      output.alpha = alpha * selectionDim(activity);
      // The unselected part is drawn only on an Other row: every other bar skips
      // its activity reads.
      output.alphaRest = output.alpha;
      if (isOther) {
        let otherActivity = ${otherRowActivityWGSL(ACTIVITY_READS, {
					color: 'markConstants.colorMode, markConstants.colorScaleIndex, colorValue',
					group: 'markConstants.groupIndex',
					skipColor: 'markConstants.otherColorOnBand == 1u'
				})};
        let free = select(
          bandFreeActivityX(markConstants.groupIndex),
          bandFreeActivityY(markConstants.groupIndex),
          markConstants.splitAlongX == 1u
        );
        output.alphaRest = alpha * selectionDim(min(otherActivity, free));
      }
      return output;
    }
  
    @fragment
    fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
      // Before any branch: a derivative must be taken in uniform control flow.
      let aa = max(fwidth(input.along), 1e-4);

      // Get color based on mode
      var baseColor: vec4<f32>;
      if (markConstants.colorMode == 0u) {
        // Constant color
        baseColor = markConstants.constantColor;
      } else {
        // Scale-based color lookup
        baseColor = getColorFromScale(
          markConstants.colorScaleIndex,
          input.colorValue,
          frameUniforms.nullColor
        );
      }
  
      var finalAlpha = baseColor.a * input.alpha;
      // An Other bar's split: its own part up to the selected share, from its
      // base, its unselected part above, with an anti-aliased edge. At share 1
      // the whole bar is its own part, with no half-dimmed top row.
      if (input.share >= 0.0 && input.share < 1.0) {
        let below = 1.0 - smoothstep(input.share - aa, input.share + aa, input.along);
        finalAlpha = baseColor.a * mix(input.alphaRest, input.alpha, below);
      }
      return vec4<f32>(baseColor.rgb * finalAlpha, finalAlpha);
    }
  `
		.replace('{{FACET_PARAM}}', faceted ? '@location(1) facetIdx: f32,' : '')
		.replace('{{FACET_DISCARD}}', faceted ? FACET_DISCARD_WGSL : '');

	const vertexBufferLayout: GPUVertexBufferLayout[] = [
		{
			arrayStride: 2 * 4,
			attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }]
		},
		// Facet index: per-instance f32 via vertex attribute (not a storage buffer)
		...(faceted
			? [
					{
						arrayStride: 4,
						stepMode: 'instance' as GPUVertexStepMode,
						attributes: [{ shaderLocation: 1, offset: 0, format: 'float32' as GPUVertexFormat }]
					}
				]
			: [])
	];

	const dataBindingConfig = [
		{ binding: BINDINGS.X0, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.X1, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.Y0, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.Y1, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.COLOR, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.ALPHA, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.SHARE, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{
			binding: BINDINGS.CONSTANTS,
			type: 'uniform',
			visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
		}
	];

	// --- DATA WRITING EFFECTS (Independent & Fine-Grained) ---

	// The measure axis's two edges morph, as ONE write per data update, so one
	// update starts one transition. The band's ids go with them: they are how a
	// row set that is not the one being animated gets noticed and snapped.
	//
	// The band axis's own channels never morph. A horizontal bar puts literally
	// the same array — the category id — in y0 and y1, and blending two ids gives
	// a fraction that the slot table resolves to a DIFFERENT category.
	$effect(() => {
		if (!renderer?.resourcesCreated || !bandAxis) return;
		// The Other share travels with the bar's length, on the same clock, so the
		// split and the bar land together. A share that changes alone (a click)
		// starts a transition of its own on that clock.
		const split = splitData ? ([[BINDINGS.SHARE, splitData]] as const) : [];
		const land = splitData && !splitSlides ? [BINDINGS.SHARE] : undefined;
		if (bandAxis === 'x') {
			renderer.writeMorphed(
				'x',
				x0Data,
				[[BINDINGS.Y0, y0Data], [BINDINGS.Y1, y1Data], ...split],
				land
			);
		} else {
			renderer.writeMorphed(
				'y',
				y0Data,
				[[BINDINGS.X0, x0Data], [BINDINGS.X1, x1Data], ...split],
				land
			);
		}
	});
	// Without a band axis the share is written as is. A mark that had shares and
	// has none now writes one array of zeros, which also drops a morphed channel:
	// left alone, the shader would keep reading the last shares. A mark that
	// never had any writes nothing and reads the zero-filled stand-in.
	let splitWritten = false;
	$effect(() => {
		if (!renderer?.resourcesCreated) return;
		if (splitData) {
			if (!bandAxis) renderer.writeAttribute(BINDINGS.SHARE, splitData);
			splitWritten = true;
		} else if (splitWritten) {
			renderer.writeAttribute(BINDINGS.SHARE, new Float32Array(Math.max(1, x0Data.length)));
			splitWritten = false;
		}
	});
	$effect(() => {
		if (renderer?.resourcesCreated && !morphX) renderer.writeAttribute(BINDINGS.X0, x0Data);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && !morphX) renderer.writeAttribute(BINDINGS.X1, x1Data);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && !morphY) renderer.writeAttribute(BINDINGS.Y0, y0Data);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && !morphY) renderer.writeAttribute(BINDINGS.Y1, y1Data);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && colorValueData)
			renderer.writeAttribute(BINDINGS.COLOR, colorValueData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.ALPHA, alphaData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && facetData)
			renderer.writeVertexBuffer(FACET_VERTEX_SLOT, facetData);
	});

	// Uniforms
	$effect(() => {
		if (renderer?.resourcesCreated) {
			// Guard: skip uniform write when colorMode=1 but color data hasn't
			// arrived yet. colorValueData is tracked reactively so the effect
			// re-fires once data loads.
			if (colorMode === 1 && !colorValueData) return;

			const buffer = new ArrayBuffer(UNIFORM_BYTES.rectsMarkConstants);
			const view = new DataView(buffer);
			const LE = true;

			view.setUint32(UNIFORM_OFFSETS.COLOR_MODE, colorMode, LE);
			view.setUint32(UNIFORM_OFFSETS.COLOR_SCALE_INDEX, colorScaleIndex, LE);
			view.setUint32(UNIFORM_OFFSETS.GROUP_INDEX, groupIndex, LE);
			view.setFloat32(UNIFORM_OFFSETS.INSET, inset, LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 0, constantColor[0], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 4, constantColor[1], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 8, constantColor[2], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 12, constantColor[3], LE);
			view.setFloat32(UNIFORM_OFFSETS.DX, dx, LE);
			view.setFloat32(UNIFORM_OFFSETS.DY, dy, LE);
			view.setUint32(UNIFORM_OFFSETS.OTHER_COLOR_ON_BAND, otherColorOnBand ? 1 : 0, LE);
			view.setUint32(UNIFORM_OFFSETS.SPLIT_ALONG_X, splitAlongX ? 1 : 0, LE);

			renderer.writeUniform(BINDINGS.CONSTANTS, new Uint8Array(buffer));
		}
	});

	// Instance Count
	$effect(() => {
		if (renderer?.resourcesCreated) {
			renderer.updateInstanceCount(x0Data?.length ?? 0);
		}
	});

	// Facet layer registration (reactive — fires when FacetCells resolve)
	$effect(() => {
		if (!renderer?.resourcesCreated || !faceted) return;
		const ids = chartContext.facetChartIds;
		if (!ids?.length) return;
		renderer.registerFacetLayers(ids, drawRects);
	});

	function createRectGeometry() {
		return new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);
	}

	async function initializeRectGeometry() {
		const device = webGPUContext.getDevice();
		const rectVertices = createRectGeometry();
		rectGeometryBuffer = device.createBuffer({
			size: rectVertices.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			label: 'rects-geometry'
		});
		device.queue.writeBuffer(rectGeometryBuffer, 0, rectVertices);
	}

	function drawRects(passEncoder: GPURenderPassEncoder) {
		if (!rectGeometryBuffer || renderer.instanceCount === 0) return;
		passEncoder.setVertexBuffer(0, rectGeometryBuffer);
		if (faceted) {
			// The faceted pipeline declares vertex slot 1, so drawing without it is
			// a validation error that invalidates the entire command buffer — every
			// other mark on the canvas disappears too, with an error naming only
			// the pipeline. Skip this mark's draw until the facet data lands. (#193)
			const facetBuffer = renderer.getVertexBuffer(FACET_VERTEX_SLOT);
			if (!facetBuffer) return;
			passEncoder.setVertexBuffer(1, facetBuffer);
		}
		passEncoder.draw(rectVertexCount, renderer.instanceCount);
	}

	onMount(() =>
		host.mount({
			init: {
				markShaderCode: rectsShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition: rectRendererDefinition
			},
			async ready(r) {
				await initializeRectGeometry();

				// Non-faceted: register with the single chart canvas.
				// Faceted: registration handled by the reactive $effect above.
				if (!faceted) r.registerLayer(drawRects);
			}
		})
	);

	// Release retained renderer from a previous instance once this one has data
	$effect(() => {
		if (renderer?.resourcesCreated && markId) {
			gpuCoordinator?.releaseRetained(markId);
		}
	});

	onDestroy(() => {
		const r = renderer;
		const rgb = rectGeometryBuffer;
		const retained =
			r &&
			markId &&
			gpuCoordinator?.retainRenderer(markId, {
				destroy() {
					rgb?.destroy();
					r.destroy();
				}
			});
		if (retained) return;
		if (rgb) rgb.destroy();
		if (r) r.destroy();
	});
</script>

{#if initializationError}
	<div class="rects-error">{initializationError}</div>
{/if}
