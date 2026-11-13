<script lang="ts">
	import { UNIFORM_BYTES } from './uniform-sizes';
	import { getContext, onMount, onDestroy } from 'svelte';
	import { RendererHost } from './RendererHost.svelte';
	import { getGPUContext } from '$lib/gpu';
	import { DEFAULT_FILL_COLOR } from '$lib/scales/color-utils';
	import type { ChartContext, WebGPUCanvasContext } from '$lib/types';
	import { activityReads, markActivityWGSL } from './activity-reads';

	// Named Bindings — stable indices regardless of hasExtent
	const BINDINGS = {
		X: 0,
		Y0: 1,
		Y1: 2,
		COLOR: 3,
		ALPHA: 4,
		CONSTANTS: 6
	};

	// Facet uses vertex buffer slot 1 (not a storage binding)
	const FACET_VERTEX_SLOT = 1;

	// Uniform struct offsets (matching WGSL MarkConstants layout)
	const UNIFORM_OFFSETS = {
		COLOR_MODE: 0,
		COLOR_SCALE_INDEX: 4,
		STROKE_WIDTH: 8,
		GROUP_INDEX: 12,
		CONSTANT_COLOR: 16,
		_PAD1: 32,
		_PAD2: 36,
		_PAD3: 40,
		_PAD4: 44
	};

	interface Props {
		xData: Float32Array;
		y0Data?: Float32Array | null;
		y1Data?: Float32Array | null;
		colorValueData: Float32Array | null;
		alphaData: Float32Array | null;
		facetData?: Float32Array | null;
		dataVersion: number;
		zIndex?: number;
		colorMode?: number;
		colorScaleIndex?: number;
		/** The page-wide index of this mark's filter group: which run of a field's activity block it reads. */
		groupIndex?: number;
		constantColor?: [number, number, number, number];
		strokeWidth?: number;
		markId?: string;
	}

	let {
		xData,
		y0Data = null,
		y1Data = null,
		colorValueData,
		alphaData,
		facetData = null,
		dataVersion: _dataVersion,
		zIndex = 0,
		colorMode = 0,
		colorScaleIndex = 0,
		groupIndex = 0,
		constantColor = DEFAULT_FILL_COLOR,
		strokeWidth = 1,
		markId = ''
	}: Props = $props();

	const chartContext = getContext<ChartContext>('chart');
	const webGPUContext = getContext<WebGPUCanvasContext>('webgpu-canvas');
	const gpuCoordinator = getGPUContext();
	const faceted = !!chartContext.fx;

	// Compile-time selection: does this rule have cross-axis extent?
	// Determined once at mount, same pattern as Rects uses `faceted`
	const hasExtent = !!y0Data;
	const effectiveMarkType = faceted
		? hasExtent
			? 'ruleX-extent-faceted'
			: 'ruleX-faceted'
		: hasExtent
			? 'ruleX-extent'
			: 'ruleX';

	// --- Renderer definition (compile-time) ---
	const rendererDefinition = hasExtent
		? {
				x: { concept: 'position', channels: ['x'] },
				y: { concept: 'extent', channels: ['y0', 'y1'] },
				placeholders: { x: '{{X_AXIS_LOGIC}}', y: '{{Y_AXIS_LOGIC}}' }
			}
		: {
				x: { concept: 'position', channels: ['x'] },
				y: null,
				placeholders: { x: '{{X_AXIS_LOGIC}}' }
			};

	// --- Facet compile-time specialization ---
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
		label: 'RuleX mark'
	});
	const renderer = $derived(host.renderer);
	const initializationError = $derived(host.error);
	let lineGeometryBuffer: GPUBuffer;

	/** The selection activities this shader reads; routing reads the same table. */
	const ACTIVITY_READS = activityReads('rulex', hasExtent);

	const ruleXShaderCode = `
    struct MarkConstants {
      colorMode: u32,
      colorScaleIndex: u32,
      strokeWidth: f32,
      groupIndex: u32,
      constantColor: vec4<f32>,
      _pad1: f32,
      _pad2: f32,
      _pad3: f32,
      _pad4: f32,
    };
    @group(1) @binding(6) var<uniform> markConstants: MarkConstants;

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) colorValue: f32,
      @location(1) alpha: f32,
    };

    @group(1) @binding(0) var<storage, read> xValues: array<f32>;
    ${hasExtent ? '@group(1) @binding(1) var<storage, read> y0Values: array<f32>;' : ''}
    ${hasExtent ? '@group(1) @binding(2) var<storage, read> y1Values: array<f32>;' : ''}
    @group(1) @binding(3) var<storage, read> colorValues: array<f32>;
    @group(1) @binding(4) var<storage, read> alphaValues: array<f32>;

    @vertex
    fn vertexMain(
      @location(0) lineVertex: vec2<f32>,
      @builtin(instance_index) instanceIdx: u32,
      ${faceted ? '@location(1) facetIdx: f32,' : ''}
    ) -> VertexOutput {
      ${faceted ? FACET_DISCARD_WGSL : ''}
      let x = xValues[instanceIdx];
      ${hasExtent ? 'let y0 = y0Values[instanceIdx];' : ''}
      ${hasExtent ? 'let y1 = y1Values[instanceIdx];' : ''}
      let colorValue = colorValues[instanceIdx];
      let alpha = alphaValues[instanceIdx];

      // X axis scaling — position concept
      {{X_AXIS_LOGIC}}

      ${hasExtent ? '// Y axis scaling — extent concept\n      {{Y_AXIS_LOGIC}}' : ''}

      // Render vertical line as a thin quad
      let halfWidth = markConstants.strokeWidth * 0.5 * frameUniforms.devicePixelRatio;

      // X: position + pixel-space width expansion
      let offsetX = (lineVertex.x - 0.5) * 2.0 * halfWidth;
      let screenX = scaledX + offsetX;

      // Y: extent or full frame span
      ${hasExtent ? 'let screenY = mix(scaledY0, scaledY1, lineVertex.y);' : 'let screenY = mix(0.0, frameUniforms.resolution.y, lineVertex.y);'}

      let worldPos = vec2<f32>(screenX, screenY);
      let normalizedPos = (worldPos / frameUniforms.resolution) * 2.0 - 1.0;

      var output: VertexOutput;
      output.position = vec4<f32>(normalizedPos.x, -normalizedPos.y, 0.0, 1.0);
      output.colorValue = colorValue;
      output.alpha = alpha * entranceAlpha(0u) * selectionDim(
        ${markActivityWGSL(ACTIVITY_READS, {
					color: 'markConstants.colorMode, markConstants.colorScaleIndex, colorValue',
					x: 'x',
					y: 'y0',
					group: 'markConstants.groupIndex'
				})}
      );
      return output;
    }

    @fragment
    fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
      var baseColor: vec4<f32>;
      if (markConstants.colorMode == 0u) {
        baseColor = markConstants.constantColor;
      } else {
        baseColor = getColorFromScale(
          markConstants.colorScaleIndex,
          input.colorValue,
          frameUniforms.nullColor
        );
      }

      let finalAlpha = baseColor.a * input.alpha;
      return vec4<f32>(baseColor.rgb * finalAlpha, finalAlpha);
    }
  `;

	const vertexBufferLayout: GPUVertexBufferLayout[] = [
		{
			arrayStride: 2 * 4,
			attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }]
		},
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
		{ binding: BINDINGS.X, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		...(hasExtent
			? [
					{
						binding: BINDINGS.Y0,
						type: 'read-only-storage',
						visibility: GPUShaderStage.VERTEX
					},
					{
						binding: BINDINGS.Y1,
						type: 'read-only-storage',
						visibility: GPUShaderStage.VERTEX
					}
				]
			: []),
		{ binding: BINDINGS.COLOR, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{ binding: BINDINGS.ALPHA, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{
			binding: BINDINGS.CONSTANTS,
			type: 'uniform',
			visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
		}
	];

	// --- DATA WRITING EFFECTS ---

	$effect(() => {
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.X, xData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && hasExtent && y0Data)
			renderer.writeAttribute(BINDINGS.Y0, y0Data);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && hasExtent && y1Data)
			renderer.writeAttribute(BINDINGS.Y1, y1Data);
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
			if (colorMode === 1 && !colorValueData) return;

			const buffer = new ArrayBuffer(UNIFORM_BYTES.ruleXMarkConstants);
			const view = new DataView(buffer);
			const LE = true;

			view.setUint32(UNIFORM_OFFSETS.COLOR_MODE, colorMode, LE);
			view.setUint32(UNIFORM_OFFSETS.COLOR_SCALE_INDEX, colorScaleIndex, LE);
			view.setUint32(UNIFORM_OFFSETS.GROUP_INDEX, groupIndex, LE);
			view.setFloat32(UNIFORM_OFFSETS.STROKE_WIDTH, strokeWidth, LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 0, constantColor[0], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 4, constantColor[1], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 8, constantColor[2], LE);
			view.setFloat32(UNIFORM_OFFSETS.CONSTANT_COLOR + 12, constantColor[3], LE);
			// padding at 32-47

			renderer.writeUniform(BINDINGS.CONSTANTS, new Uint8Array(buffer));
		}
	});

	// Instance Count
	$effect(() => {
		if (renderer?.resourcesCreated) {
			renderer.updateInstanceCount(xData?.length ?? 0);
		}
	});

	// Facet layer registration
	$effect(() => {
		if (!renderer?.resourcesCreated || !faceted) return;
		const ids = chartContext.facetChartIds;
		if (!ids?.length) return;
		renderer.registerFacetLayers(ids, drawRules);
	});

	function createLineGeometry() {
		return new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);
	}

	async function initializeLineGeometry() {
		const device = webGPUContext.getDevice();
		const lineVertices = createLineGeometry();
		lineGeometryBuffer = device.createBuffer({
			size: lineVertices.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			label: 'ruleX-mark-geometry'
		});
		device.queue.writeBuffer(lineGeometryBuffer, 0, lineVertices);
	}

	function drawRules(passEncoder: GPURenderPassEncoder) {
		if (!lineGeometryBuffer || renderer.instanceCount === 0) return;
		passEncoder.setVertexBuffer(0, lineGeometryBuffer);
		if (faceted) {
			// The faceted pipeline declares vertex slot 1, so drawing without it is
			// a validation error that invalidates the entire command buffer — every
			// other mark on the canvas disappears too, with an error naming only
			// the pipeline. Skip this mark's draw until the facet data lands. (#193)
			const facetBuffer = renderer.getVertexBuffer(FACET_VERTEX_SLOT);
			if (!facetBuffer) return;
			passEncoder.setVertexBuffer(1, facetBuffer);
		}
		passEncoder.draw(6, renderer.instanceCount);
	}

	onMount(() =>
		host.mount({
			init: {
				markShaderCode: ruleXShaderCode,
				vertexBufferLayout,
				dataBindingConfig,
				rendererDefinition
			},
			async ready(r) {
				await initializeLineGeometry();
				if (!faceted) r.registerLayer(drawRules);
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
		const lgb = lineGeometryBuffer;
		const retained =
			r &&
			markId &&
			gpuCoordinator?.retainRenderer(markId, {
				destroy() {
					lgb?.destroy();
					r.destroy();
				}
			});
		if (retained) return;
		if (lgb) lgb.destroy();
		if (r) r.destroy();
	});
</script>

{#if initializationError}
	<div class="rule-error">{initializationError}</div>
{/if}
