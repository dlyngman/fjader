<script lang="ts">
	import { UNIFORM_BYTES } from './uniform-sizes';
	import { getContext, onMount, onDestroy, untrack } from 'svelte';
	import { RendererHost } from './RendererHost.svelte';
	import { getGPUContext } from '$lib/gpu';
	import { DEFAULT_FILL_COLOR } from '$lib/scales/color-utils';
	import type { ChartContext, WebGPUCanvasContext } from '$lib/types';
	import type { SplitProp } from '../marks/lifecycle/other-rows.svelte';
	import type { RebinSource } from '$lib/gpu/bin-remap';
	import { activityReads, markActivityWGSL, otherRowActivityWGSL } from './activity-reads';
	import { PLACEMENT_WORKGROUP, type PlacementConfig } from '$lib/gpu/placement';

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
		 */
		SHARE: 7,
		/**
		 * Each drawn row's placed geometry and appearance (RECORD_WGSL), written
		 * by the placement kernels and read by the draw. The draw binds only this
		 * and the constants: its vertex stage holds 2 storage buffers (this and
		 * the shared slot table), where it held all 8 when it placed rows itself.
		 */
		RECORD: 8,
		/** The kernels' seams (from their vertex slot) and facet indices. */
		SEAMS: 9,
		FACET: 10
	};

	/** Bytes per row of the record: RECORD_WGSL, four f32 after a vec4. */
	const RECORD_STRIDE = 32;

	// Facet indices: vertex slot 1. The draw reads them as an instance attribute
	// (its facet discard); the faceted kernels bind the same buffer as storage,
	// which is why vertex-slot buffers are created with STORAGE usage too.
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
		SPLIT_ALONG_X: 44,
		ENTRANCE_AXIS: 48,
		SEAM_FADE: 52
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
		/**
		 * The data version whose first write lands without morphing, or 0: a
		 * catch-up result (MarkLifecycleV2.landsFor). Later writes of that version
		 * animate as usual.
		 */
		landsFor?: number;
		/**
		 * A binned mark's rebins (MarkLifecycleV2.rebinSource): the renderer
		 * asks it once per data version written, so a rebin's bars start where
		 * the old bars they cover were drawn. Bars span their bins: `interval`.
		 */
		rebinSource?: RebinSource | null;
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
		 * order and may therefore morph; or a histogram's binned axis, one row per
		 * bin in bin order. null to morph nothing.
		 *
		 * The OTHER axis's channels morph. The band's never do: they carry a
		 * category id that the shader resolves through the slot table, and
		 * interpolating an identity produces a fraction that resolves to some
		 * other category. Position already animates, through the slot table. A
		 * bin's edges do not change under a filter; a rebin changes the rows,
		 * which follow it through the renderer's binning (`rebinSource`).
		 */
		bandAxis?: 'x' | 'y' | null;
		/**
		 * The axis this mark bins, when it does (a histogram), as known when it
		 * mounts: read once, it picks the pipeline. A binned mark's pipeline
		 * reads per-rect seams, so the pieces of a bar a merge cuts draw flush
		 * at the cut (BinCut.seams). Every other mark's pipeline is unchanged.
		 */
		binnedAxis?: 'x' | 'y' | null;
		/**
		 * The axis this mark grows along when its chart enters: its measure axis,
		 * for bars and histograms anchored at 0. null fades it in instead, for
		 * rects with bounds of their own (a Gantt bar has no 0 to grow from).
		 */
		grow?: 'x' | 'y' | null;
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
		landsFor = 0,
		rebinSource = null,
		zIndex = 0,
		colorMode = 0,
		colorScaleIndex = 0,
		groupIndex = 0,
		constantColor = DEFAULT_FILL_COLOR,
		inset = 0,
		dx = 0,
		dy = 0,
		markId = '',
		bandAxis = null,
		binnedAxis = null,
		grow = null
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
	// The binned axis picks the pipeline, so it is read once, as the facet is.
	const seamAxis = untrack(() => binnedAxis);
	const SEAM_VERTEX_SLOT = faceted ? 2 : 1;
	const effectiveMarkType = `rects${faceted ? '-faceted' : ''}${seamAxis ? `-seams-${seamAxis}` : ''}`;

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

	/**
	 * A row as placed (gpu/placement.ts): the bar's two corners in plot device
	 * pixels, insets and offsets applied (corner 0 is the bar's base on the
	 * measure axis, not necessarily its minimum); its opacity, and the Other
	 * split's unselected part; its colour value for the fragment's lookup; its
	 * Other share (0 on other rows, 1 + share on an Other bar).
	 */
	const RECORD_WGSL = `
    struct Record {
      box: vec4<f32>,
      alpha: f32,
      alphaRest: f32,
      colorValue: f32,
      share: f32,
    };`;

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
      entranceAxis: u32,        // 0: fades in, 1: grows along x, 2: along y
      seamFade: f32,            // Share of the inset on sibling seams (rebins)
      _pad1: u32,
      _pad2: u32,
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

    ${RECORD_WGSL}
    @group(1) @binding(8) var<storage, read> records: array<Record>;

    // The row as the placement kernels left it this frame: corners only here.
    @vertex
    fn vertexMain(
      @location(0) rectCorner: vec2<f32>,
      @builtin(instance_index) instanceIdx: u32,
      {{FACET_PARAM}}
    ) -> VertexOutput {
      {{FACET_DISCARD}}
      let r = records[instanceIdx];
      let worldPos = vec2<f32>(mix(r.box.x, r.box.z, rectCorner.x), mix(r.box.y, r.box.w, rectCorner.y));

      var output: VertexOutput;
      output.position = pixelsToClip(worldPos);
      output.colorValue = r.colorValue;
      output.alpha = r.alpha;
      output.alphaRest = r.alphaRest;
      // An Other row (share > 0) is drawn in two parts, mixed in the fragment
      // at its share; every other row is -1, one part.
      output.share = select(-1.0, r.share - 1.0, r.share > 0.5);
      output.along = select(rectCorner.y, rectCorner.x, markConstants.splitAlongX == 1u);
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

	// --- Placement kernels (gpu/placement.ts) ---
	//
	// Two, because one would bind 9-10 storage buffers and the default is 8.
	// Each covers the drawn rows; a faceted mark's dispatch per cell places
	// only that cell's rows, with that cell's frame uniforms.

	const MARK_CONSTANTS_WGSL = rectsShaderCode.slice(
		rectsShaderCode.indexOf('struct MarkConstants'),
		rectsShaderCode.indexOf('struct VertexOutput')
	);

	/** A faceted kernel's facet indices, and the skip for another cell's rows. */
	const FACET_KERNEL_BINDING = faceted
		? `@group(1) @binding(${BINDINGS.FACET}) var<storage, read> facets: array<f32>;`
		: '';
	const FACET_KERNEL_SKIP = faceted
		? `if (i >= arrayLength(&facets) || u32(facets[i]) != frameUniforms.activeFacetIdx) { return; }`
		: '';
	const KERNEL_HEAD = `
    @compute @workgroup_size(${PLACEMENT_WORKGROUP})
    fn placeMain(@builtin(global_invocation_id) gid: vec3<u32>) {
      if (gid.x >= chartScales.rows.x) { return; }
      let i = gid.x + chartScales.rows.y;
      ${FACET_KERNEL_SKIP}`;

	/** Where each bar is: the box, as the vertex stage used to compute it per corner. */
	const geometryKernelCode = `
    ${MARK_CONSTANTS_WGSL}
    ${RECORD_WGSL}
    @group(1) @binding(${BINDINGS.X0}) var<storage, read> x0Values: array<f32>;
    @group(1) @binding(${BINDINGS.X1}) var<storage, read> x1Values: array<f32>;
    @group(1) @binding(${BINDINGS.Y0}) var<storage, read> y0Values: array<f32>;
    @group(1) @binding(${BINDINGS.Y1}) var<storage, read> y1Values: array<f32>;
    @group(1) @binding(${BINDINGS.RECORD}) var<storage, read_write> records: array<Record>;
    ${seamAxis ? `@group(1) @binding(${BINDINGS.SEAMS}) var<storage, read> seams: array<u32>;` : ''}
    ${FACET_KERNEL_BINDING}
    ${KERNEL_HEAD}
      let x0 = x0Values[i];
      let x1 = x1Values[i];
      let y0 = y0Values[i];
      let y1 = y1Values[i];

      {{X_AXIS_LOGIC}}
      {{Y_AXIS_LOGIC}}

      // The chart's entrance: both edges pulled toward 0 on the measure axis,
      // so a stack grows as one block rather than its segments floating up.
      let p0 = entrancePosition(vec2<f32>(scaledX0, scaledY0), markConstants.entranceAxis);
      let p1 = entrancePosition(vec2<f32>(scaledX1, scaledY1), markConstants.entranceAxis);

      // Inset, shrinking the rect inward on all sides; a rebin's seams adjust it.
      let ix = markConstants.inset * sign(p1.x - p0.x);
      let iy = markConstants.inset * sign(p1.y - p0.y);
      ${seamAxis ? 'let seam = select(0u, seams[i], i < arrayLength(&seams));' : ''}
      ${seamInsetsWGSL(seamAxis)}

      let d = vec2<f32>(markConstants.dx, markConstants.dy);
      records[i].box = vec4<f32>(
        p0.x + ix0 + d.x, p0.y + iy0 + d.y,
        p1.x - ix1 + d.x, p1.y - iy1 + d.y
      );
    }`;

	/**
	 * How opaque each bar is, and what colours it: selection dimming, the
	 * entrance fade, and an Other bar's two parts. Below its share, as any bar,
	 * by its full activity, its own field's included, so it dims and lights
	 * with the bucket's lit state (#23). Above, by the other fields' activity
	 * and the field's free slot, so it is lit only while nothing is selected.
	 */
	const appearanceKernelCode = `
    ${MARK_CONSTANTS_WGSL}
    ${RECORD_WGSL}
    @group(1) @binding(${BINDINGS.X0}) var<storage, read> x0Values: array<f32>;
    @group(1) @binding(${BINDINGS.Y0}) var<storage, read> y0Values: array<f32>;
    @group(1) @binding(${BINDINGS.COLOR}) var<storage, read> colorValues: array<f32>;
    @group(1) @binding(${BINDINGS.ALPHA}) var<storage, read> alphaValues: array<f32>;
    @group(1) @binding(${BINDINGS.SHARE}) var<storage, read> splitValues: array<f32>;
    @group(1) @binding(${BINDINGS.RECORD}) var<storage, read_write> records: array<Record>;
    ${FACET_KERNEL_BINDING}
    ${KERNEL_HEAD}
      let x0 = x0Values[i];
      let y0 = y0Values[i];
      let alpha = alphaValues[i];
      let colorValue = colorValues[i];
      let split = splitValues[i];
      let enterAlpha = entranceAlpha(markConstants.entranceAxis);
      let activity = ${markActivityWGSL(ACTIVITY_READS, {
				color: 'markConstants.colorMode, markConstants.colorScaleIndex, colorValue',
				x: 'x0',
				y: 'y0',
				group: 'markConstants.groupIndex'
			})};
      let a = alpha * selectionDim(activity) * enterAlpha;
      // The unselected part is computed only on an Other row: every other bar
      // skips its activity reads.
      var rest = a;
      if (split > 0.5) {
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
        rest = alpha * selectionDim(min(otherActivity, free)) * enterAlpha;
      }
      records[i].alpha = a;
      records[i].alphaRest = rest;
      records[i].colorValue = colorValue;
      records[i].share = split;
    }`;

	const facetKernelBinding = faceted
		? [{ binding: BINDINGS.FACET, source: 'vertex' as const, slot: FACET_VERTEX_SLOT }]
		: [];
	const placement: PlacementConfig = {
		recordBinding: BINDINGS.RECORD,
		recordStride: RECORD_STRIDE,
		kernels: [
			{
				name: 'geometry',
				code: geometryKernelCode,
				bindings: [
					{ binding: BINDINGS.X0, source: 'channel', channel: BINDINGS.X0 },
					{ binding: BINDINGS.X1, source: 'channel', channel: BINDINGS.X1 },
					{ binding: BINDINGS.Y0, source: 'channel', channel: BINDINGS.Y0 },
					{ binding: BINDINGS.Y1, source: 'channel', channel: BINDINGS.Y1 },
					{ binding: BINDINGS.CONSTANTS, source: 'uniform', channel: BINDINGS.CONSTANTS },
					{ binding: BINDINGS.RECORD, source: 'record' },
					...(seamAxis
						? [
								{
									binding: BINDINGS.SEAMS,
									source: 'vertex' as const,
									slot: SEAM_VERTEX_SLOT,
									// Seams cover every drawn row or none apply (u32 each).
									rowBytes: 4
								}
							]
						: []),
					...facetKernelBinding
				]
			},
			{
				name: 'appearance',
				code: appearanceKernelCode,
				bindings: [
					{ binding: BINDINGS.X0, source: 'channel', channel: BINDINGS.X0 },
					{ binding: BINDINGS.Y0, source: 'channel', channel: BINDINGS.Y0 },
					{ binding: BINDINGS.COLOR, source: 'channel', channel: BINDINGS.COLOR },
					{ binding: BINDINGS.ALPHA, source: 'channel', channel: BINDINGS.ALPHA },
					{ binding: BINDINGS.SHARE, source: 'channel', channel: BINDINGS.SHARE },
					{ binding: BINDINGS.CONSTANTS, source: 'uniform', channel: BINDINGS.CONSTANTS },
					{ binding: BINDINGS.RECORD, source: 'record' },
					...facetKernelBinding
				]
			}
		]
	};

	/**
	 * Each side's inset. On the binned axis of a binned mark (p0 is the lower
	 * edge): a side a cut made (seam bit 1 lower, 2 upper) takes none; a side
	 * shared with a sibling (4 lower, 8 upper) takes it scaled by the seam
	 * fade (bin-remap's SEAM_* and SIBLING_*).
	 */
	function seamInsetsWGSL(axis: 'x' | 'y' | null): string {
		const side = (cut: number, sibling: number, inset: string) =>
			`select(select(${inset}, ${inset} * markConstants.seamFade, (seam & ${sibling}u) != 0u), 0.0, (seam & ${cut}u) != 0u)`;
		return `
      let ix0 = ${axis === 'x' ? side(1, 4, 'ix') : 'ix'};
      let ix1 = ${axis === 'x' ? side(2, 8, 'ix') : 'ix'};
      let iy0 = ${axis === 'y' ? side(1, 4, 'iy') : 'iy'};
      let iy1 = ${axis === 'y' ? side(2, 8, 'iy') : 'iy'};`;
	}

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
		// A binned mark's seams are written to a vertex slot (SEAM_VERTEX_SLOT)
		// that the geometry kernel reads as storage: the draw does not bind them.
	];

	// The draw binds the record and the constants; the channels go to the kernels.
	const dataBindingConfig = [
		{ binding: BINDINGS.RECORD, type: 'read-only-storage', visibility: GPUShaderStage.VERTEX },
		{
			binding: BINDINGS.CONSTANTS,
			type: 'uniform',
			visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
		}
	];

	// --- DATA WRITING EFFECTS (Independent & Fine-Grained) ---

	// Before the data effects, so a version's first write already asks it.
	$effect(() => {
		if (!renderer?.resourcesCreated) return;
		// The bin edges are the band axis's static pair: a cut writes the pieces' own.
		const edges =
			bandAxis === 'x'
				? ([BINDINGS.X0, BINDINGS.X1] as const)
				: bandAxis === 'y'
					? ([BINDINGS.Y0, BINDINGS.Y1] as const)
					: null;
		// Seams only where the pipeline reads them, on the axis it was built for.
		const seams = seamAxis && seamAxis === bandAxis ? SEAM_VERTEX_SLOT : null;
		renderer.setBinning(rebinSource, {
			geometry: 'interval',
			edges,
			seams,
			seamFade:
				seams === null ? null : { binding: BINDINGS.CONSTANTS, offset: UNIFORM_OFFSETS.SEAM_FADE }
		});
	});

	// Whether this write lands: the first of the catch-up's data version
	// (landsFor). Plain, not $state: only the write effect reads and sets it.
	// Assumes a catch-up result is ONE morph write: should it ever take two
	// (values, then band ids after the instant layout), the second springs.
	// A morph SPRING right after a morph snap on a return points here.
	let lastMorphedVersion = -1;
	// The morphed edges measured on the value axis: a folding snap of that
	// scale holds them on their pixels (MorphedChannels). Not the Other share.
	const SCALED_Y = [BINDINGS.Y0, BINDINGS.Y1];
	const SCALED_X = [BINDINGS.X0, BINDINGS.X1];
	/** Whether this is the first morphed write of the current data version. */
	function firstOfVersion(): boolean {
		const first = dataVersion !== lastMorphedVersion;
		lastMorphedVersion = dataVersion;
		return first;
	}

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
		const first = firstOfVersion();
		const lands = first && landsFor !== 0 && landsFor === dataVersion;
		const land = lands ? 'all' : splitData && !splitSlides ? [BINDINGS.SHARE] : undefined;
		if (bandAxis === 'x') {
			renderer.writeMorphed(
				'x',
				x0Data,
				[[BINDINGS.Y0, y0Data], [BINDINGS.Y1, y1Data], ...split],
				land,
				SCALED_Y
			);
		} else {
			renderer.writeMorphed(
				'y',
				y0Data,
				[[BINDINGS.X0, x0Data], [BINDINGS.X1, x1Data], ...split],
				land,
				SCALED_X
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
			view.setUint32(UNIFORM_OFFSETS.ENTRANCE_AXIS, grow === 'x' ? 1 : grow === 'y' ? 2 : 0, LE);
			// Full gaps on sibling seams; a running fade writes its own value on top.
			view.setFloat32(UNIFORM_OFFSETS.SEAM_FADE, 1, LE);

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
				rendererDefinition: rectRendererDefinition,
				placement
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
