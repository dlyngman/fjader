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
		Y: 0,
		X0: 1,
		X1: 2,
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
		yData: Float32Array;
		x0Data?: Float32Array | null;
		x1Data?: Float32Array | null;
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
		yData,
		x0Data = null,
		x1Data = null,
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
	const hasExtent = !!x0Data;
	const effectiveMarkType = faceted
		? hasExtent
			? 'ruleY-extent-faceted'
			: 'ruleY-faceted'
		: hasExtent
			? 'ruleY-extent'
			: 'ruleY';

	// --- Renderer definition (compile-time) ---
	const rendererDefinition = hasExtent
		? {
				x: { concept: 'extent', channels: ['x0', 'x1'] },
				y: { concept: 'position', channels: ['y'] },
				placeholders: { x: '{{X_AXIS_LOGIC}}', y: '{{Y_AXIS_LOGIC}}' }
			}
		: {
				x: null,
				y: { concept: 'position', channels: ['y'] },
				placeholders: { y: '{{Y_AXIS_LOGIC}}' }
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
		label: 'RuleY mark'
	});
	const renderer = $derived(host.renderer);
	const initializationError = $derived(host.error);
	let lineGeometryBuffer: GPUBuffer;

	/** The selection activities this shader reads; routing reads the same table. */
	const ACTIVITY_READS = activityReads('ruley', hasExtent);

	const ruleYShaderCode = `
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

    @group(1) @binding(0) var<storage, read> yValues: array<f32>;
    ${hasExtent ? '@group(1) @binding(1) var<storage, read> x0Values: array<f32>;' : ''}
    ${hasExtent ? '@group(1) @binding(2) var<storage, read> x1Values: array<f32>;' : ''}
    @group(1) @binding(3) var<storage, read> colorValues: array<f32>;
    @group(1) @binding(4) var<storage, read> alphaValues: array<f32>;

    @vertex
    fn vertexMain(
      @location(0) lineVertex: vec2<f32>,
      @builtin(instance_index) instanceIdx: u32,
      ${faceted ? '@location(1) facetIdx: f32,' : ''}
    ) -> VertexOutput {
      ${faceted ? FACET_DISCARD_WGSL : ''}
      let y = yValues[instanceIdx];
      ${hasExtent ? 'let x0 = x0Values[instanceIdx];' : ''}
      ${hasExtent ? 'let x1 = x1Values[instanceIdx];' : ''}
      let colorValue = colorValues[instanceIdx];
      let alpha = alphaValues[instanceIdx];

      // Y axis scaling — position concept
      {{Y_AXIS_LOGIC}}

      ${hasExtent ? '// X axis scaling — extent concept\n      {{X_AXIS_LOGIC}}' : ''}

      // Render horizontal line as a thin quad
      let halfWidth = markConstants.strokeWidth * 0.5 * frameUniforms.devicePixelRatio;

      // Y: position + pixel-space width expansion
      let offsetY = (lineVertex.y - 0.5) * 2.0 * halfWidth;
      let screenY = scaledY + offsetY;

      // X: extent or full frame span
      ${hasExtent ? 'let screenX = mix(scaledX0, scaledX1, lineVertex.x);' : 'let screenX = mix(0.0, frameUniforms.resolution.x, lineVertex.x);'}

      let worldPos = vec2<f32>(screenX, screenY);
      let normalizedPos = (worldPos / frameUniforms.resolution) * 2.0 - 1.0;

      var output: VertexOutput;
      output.position = vec4<f32>(normalizedPos.x, -normalizedPos.y, 0.0, 1.0);
      output.colorValue = colorValue;
      output.alpha = alpha * entranceAlpha(0u) * selectionDim(
        ${markActivityWGSL(ACTIVITY_READS, {
					color: 'markConstants.colorMode, markConstants.colorScaleIndex, colorValue',
					x: 'x0',
					y: 'y',
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
		{ binding: BINDINGS.Y, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		...(hasExtent
			? [
					{
						binding: BINDINGS.X0,
						type: 'read-only-storage',
						visibility: GPUShaderStage.VERTEX
					},
					{
						binding: BINDINGS.X1,
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
		if (renderer?.resourcesCreated) renderer.writeAttribute(BINDINGS.Y, yData);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && hasExtent && x0Data)
			renderer.writeAttribute(BINDINGS.X0, x0Data);
	});
	$effect(() => {
		if (renderer?.resourcesCreated && hasExtent && x1Data)
			renderer.writeAttribute(BINDINGS.X1, x1Data);
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

			const buffer = new ArrayBuffer(UNIFORM_BYTES.ruleYMarkConstants);
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
			renderer.updateInstanceCount(yData?.length ?? 0);
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
			label: 'ruleY-mark-geometry'
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
				markShaderCode: ruleYShaderCode,
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
