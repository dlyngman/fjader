<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycleV2 } from './lifecycle/MarkLifecycleV2.svelte';
	import { Lines } from '../rendering';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import {
		buildSelectFromChannels,
		resolveChannelData,
		computeInstanceCount,
		buildTooltipConfig,
		MarkColor,
		MarkSeries,
		normalizeSortConfig,
		inferMarkScaleType,
		generateMarkId,
		resolveTip
	} from './utils';
	import { buildReactiveConfig } from './utils/reactive-config';
	import { getGPUContext } from '$lib/gpu';
	import { isColorConstant } from '$lib/scales/color-utils';
	import { M4Decimator, m4Parity } from '$lib/gpu/decimation/M4Decimator.svelte';
	import { DensityHost } from '$lib/lod/DensityHost.svelte';
	import { DotsRung } from '$lib/lod/DotsRung.svelte';
	import { SmoothRung } from '$lib/lod/SmoothRung.svelte';
	import type { MarkLODSurface } from '$lib/lod/rung-types';
	import type { SmoothMode, RollingAvgNode } from '$lib/sql/rolling-avg';
	import type {
		ChannelRef,
		FieldRef,
		BaseMarkProps,
		ContinuousScaleTypeProps,
		ConnectedTopologyProps,
		LODConfig,
		ChartContext
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { QueryEngine } from '$lib/query-engine/QueryEngine';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';
	import type { Snippet } from 'svelte';

	// Self-import for overlay rendering (Svelte 5 replacement for <svelte:self>)
	import LineMark from './LineMark.svelte';

	interface SmoothRungContext {
		table: string;
		x: FieldRef;
		y: FieldRef;
		smoothY: RollingAvgNode;
		stroke: FieldRef | null;
		z: FieldRef | null;
		windowSize: number;
	}

	interface Props extends BaseMarkProps, ContinuousScaleTypeProps, ConnectedTopologyProps {
		x: FieldRef;
		y: ChannelRef;
		stroke?: FieldRef | null;
		strokeWidth?: number;
		dotRadius?: number;
		opacity?: number;
		fitDomain?: 'x' | 'y' | boolean;
		lod?: boolean | LODConfig;
		onMarkLOD?: (surface: MarkLODSurface | null) => void;
		/** Custom rendering for the smoothing overlay rung. */
		rung_smooth?: Snippet<[SmoothRungContext]>;
		/** @internal Prevents recursive overlay spawning. */
		_isOverlay?: boolean;
	}

	let {
		table,
		selection = undefined,
		selectionResponse = undefined,
		nulls = undefined,
		x,
		y,
		stroke = null,
		z = null,
		order = undefined,
		scheme,
		curve = 'linear',
		strokeWidth = 2,
		dotRadius = 0,
		limit,
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = [],
		sort = null,
		domain = null,
		tooltip = true,
		tooltipProximity,
		tip = undefined,
		fitDomain = undefined,
		opacity = 1,
		lod = true,
		onMarkLOD = undefined,
		rung_smooth = undefined,
		_isOverlay = false
	}: Props = $props();

	// Map user-facing aliases to axis-specific variants
	const effectiveCurve = $derived.by(() => {
		const c = entry.curve ?? 'linear';
		return c === 'monotone' ? 'monotone-x' : c === 'bump' ? 'bump-x' : c;
	});

	const markId = generateMarkId('line');
	const queryEngine = getContext<QueryEngine>('query-engine');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');

	// --- ChartConfig registration ---
	const entry = chartContext.config.registerMark(markId, 'line', {
		table: () => table,
		x: () => x,
		y: () => y,
		stroke: () => stroke,
		z: () => z,
		order: () => order,
		scheme: () => scheme,
		curve: () => curve,
		strokeWidth: () => strokeWidth,
		dotRadius: () => dotRadius,
		transforms: () => transforms,
		selection: () => selection,
		selectionResponse: () => selectionResponse,
		nulls: () => nulls,
		limit: () => limit,
		preferredXScaleType: () => preferredXScaleType,
		preferredYScaleType: () => preferredYScaleType,
		sort: () => sort,
		domain: () => domain,
		tooltip: () => tooltip,
		tooltipProximity: () => tooltipProximity,
		tip: () => tip,
		fitDomain: () => fitDomain,
		lod: () => lod
	});

	let setup = $state<MarkLifecycleV2 | null>(null);

	// 0. Scale Type Inference — reads from entry
	const effectiveXScaleType = $derived.by(() =>
		inferMarkScaleType(entry.x, entry.table, entry.preferredXScaleType)
	);
	const effectiveYScaleType = $derived.by(() =>
		inferMarkScaleType(entry.y, entry.table, entry.preferredYScaleType)
	);

	// Series grouping: z overrides stroke for grouping. A selection on either
	// field dims the line (see activityReads in activity-reads.ts).
	const seriesChannelKey = entry.z != null ? 'z' : 'stroke';
	const markSeries = new MarkSeries(
		() => entry.z ?? entry.stroke,
		seriesChannelKey,
		() => setup,
		scaleRegistry,
		chartContext,
		() => markColor.scaleState
	);

	// Color: stroke determines line color — reads from entry
	const markColor = new MarkColor(
		() => entry.stroke,
		() => entry.scheme,
		'stroke',
		() => entry.table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Config with _orderConfig for automatic ORDER BY (series, dimension) — reads from entry
	const channelSelect = $derived(
		buildSelectFromChannels({
			x: entry.x,
			y: entry.y,
			...(markColor.selectField && { stroke: markColor.selectField }),
			...(entry.z != null && markSeries.selectField && { z: markSeries.selectField }),
			...(entry.order != null && { __order: entry.order })
		})
	);
	const resolvedTip = $derived(resolveTip(entry.tip, channelSelect));

	// Resolve fitted axis for scale isolation (fitDomain gets its own scale instance)
	const resolvedFitAxis = $derived.by(() => {
		const fd = entry.fitDomain;
		if (!fd) return null;
		return fd === 'x' ? 'x' : fd === 'y' ? 'y' : 'y';
	});

	const config = $derived({
		markType: 'line',
		supportedScaleTypes: {
			x: ['linear', 'time', 'log', 'symlog'],
			y: ['linear', 'time', 'log', 'symlog']
		},
		scaleRequirements: {
			x: effectiveXScaleType
				? {
						type: effectiveXScaleType,
						priority: SCALE_PRIORITIES.PREFER,
						config: resolvedFitAxis === 'x' ? { __fitDomain: true } : {}
					}
				: null,
			y: effectiveYScaleType
				? {
						type: effectiveYScaleType,
						priority: SCALE_PRIORITIES.PREFER,
						config: resolvedFitAxis === 'y' ? { __fitDomain: true } : {}
					}
				: null
		},
		inferredScaleColumns: {
			x: entry.x,
			y: entry.y
		},
		table: entry.table,
		transforms: entry.transforms ?? [],
		select: { ...channelSelect, ...resolvedTip.extraSelect },
		colorChannel: 'stroke',
		// Connected topology config - ensures data is ordered for line connectivity
		_orderConfig: {
			seriesChannel: markSeries.selectField ? seriesChannelKey : null,
			dimensionChannel: entry.order != null ? '__order' : 'x'
		},
		passiveScales: _isOverlay
	});

	const reactiveConfig = buildReactiveConfig(entry, {
		resolveFitDomain: () => (_isOverlay ? undefined : resolvedFitAxis)
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);
	let yScaleId = $derived(chartContext.yScaleState?.id);

	let instanceCount = $derived(computeInstanceCount(setup?.data, entry.x, entry.y));

	// --- DATA RESOLUTION ---

	let xData = $derived.by(() =>
		resolveChannelData({
			value: entry.x,
			channel: 'x',
			dataAccessor: setup?.data,
			instanceCount
		})
	);

	let yData = $derived.by(() =>
		resolveChannelData({
			value: entry.y,
			channel: 'y',
			dataAccessor: setup?.data,
			instanceCount
		})
	);

	// Series data comes from MarkSeries (uses scale infrastructure)
	let seriesData = $derived(markSeries.data);

	// --- SETUP LIFECYCLE ---

	$effect(() => {
		// Depend on fields that warrant lifecycle recreation (table, channels,
		// scale types) — NOT config as a whole, which recomputes when entry.lod
		// changes via setRungParam (LOD window size adjustments should re-query,
		// not recreate the lifecycle).
		void channelSelect;
		void xScaleId;
		void yScaleId;
		void effectiveXScaleType;
		void effectiveYScaleType;
		untrack(() => {
			if (setup) {
				gpuCoordinator?.markForRetain(markId);
			}
			setup?.destroy();
			setup = null;
			if (entry.table && effectiveXScaleType && effectiveYScaleType && queryEngine) {
				setup = new MarkLifecycleV2(
					config,
					reactiveConfig,
					queryEngine,
					chartContext,
					markId,
					filterGroups.get(entry.selection as string | undefined)
				);
			}
		});
	});

	// MarkColor and MarkSeries connect to setup internally via their lifecycle effects

	// --- LOD CONFIG RESOLUTION ---
	const gpuCoordinator = getGPUContext();
	const faceted = !!chartContext.fx;
	const entryLod = $derived(entry.lod);

	// Structural config — gates rung creation
	const lodEnabled = $derived(entryLod !== false);
	const lodDotsEnabled = $derived.by(() => {
		if (entryLod === false) return false;
		const cfg = typeof entryLod === 'object' ? entryLod : {};
		return cfg.dots !== false;
	});
	const lodDecimate = $derived.by(() => {
		if (entryLod === false) return 'auto' as boolean | 'auto';
		const cfg = typeof entryLod === 'object' ? entryLod : {};
		return cfg.decimate ?? ('auto' as boolean | 'auto');
	});
	const lodOnChange = $derived.by(() => {
		if (entryLod === false) return null;
		const cfg = typeof entryLod === 'object' ? entryLod : {};
		return cfg.onLODChange ?? null;
	});

	// M4 created only when LOD is active and decimation isn't disabled.
	const m4Eligible = $derived.by(() => {
		if (!lodEnabled) return false;
		if (lodDecimate === false || faceted) return false;
		const xType = chartContext.scaleTypes?.x;
		if (xType === 'log' || xType === 'symlog') return false;
		return true;
	});

	// When LOD is active, DotsRung writes dotRadius directly to the GPU buffer.
	const effectiveDotRadius = $derived.by(() => {
		if (lodEnabled && dotsRung) return 0;
		return entry.dotRadius ?? 0;
	});

	let m4Decimator = $state(null);

	$effect(() => {
		if (m4Eligible && gpuCoordinator?.device) {
			const decimator = new M4Decimator(gpuCoordinator.device, gpuCoordinator);
			m4Decimator = decimator;
			return () => {
				decimator.destroy();
				m4Decimator = null;
			};
		} else {
			m4Decimator = null;
		}
	});

	// Write-back: when rung tunables change (shift+scroll), persist to entry.lod
	function setRungParam(rungName: string, key: string, value: number | string): void {
		const current = entry.lod;
		const cfg = typeof current === 'object' && current ? current : {};
		const rungCfg =
			typeof (cfg as Record<string, unknown>)[rungName] === 'object'
				? { ...(cfg as Record<string, Record<string, unknown>>)[rungName] }
				: {};
		rungCfg[key] = value;
		chartContext.config.setMarkProp(markId, 'lod', { ...cfg, [rungName]: rungCfg });
	}

	// --- DENSITY HOST ---
	let densityHost: DensityHost | null = $state(null);

	$effect(() => {
		if (!lodEnabled || !setup || !queryEngine || !gpuCoordinator) return;
		const decimate = lodDecimate;
		const host = new DensityHost(gpuCoordinator, chartContext, queryEngine, {
			callerId: markId,
			countQueryBuilder: (xLo: number, xHi: number, yLo: number, yHi: number) =>
				setup.buildViewportCountQuery(xLo, xHi, yLo, yHi),
			decimate
		});
		densityHost = host;
		return () => {
			host.destroy();
			densityHost = null;
		};
	});

	// --- DOTS RUNG (only when dots enabled) ---
	let dotsRung: DotsRung | null = $state(null);

	$effect(() => {
		const enabled = lodDotsEnabled;
		const host = densityHost;
		if (!enabled || !host || !gpuCoordinator) return;
		const rung = new DotsRung(
			host,
			gpuCoordinator,
			() => {
				const cfg = typeof entry.lod === 'object' ? entry.lod : {};
				return typeof cfg.dots === 'object' ? (cfg.dots?.threshold ?? 18) : 18;
			},
			() => {
				const cfg = typeof entry.lod === 'object' ? entry.lod : {};
				const dr = entry.dotRadius ?? 0;
				return (typeof cfg.dots === 'object' ? cfg.dots?.r : undefined) ?? (dr > 0 ? dr : 2.5);
			},
			(key, val) => setRungParam('dots', key, val)
		);
		dotsRung = rung;
		return () => {
			rung.destroy();
			dotsRung = null;
		};
	});

	// --- SMOOTH RUNG ---
	let smoothRung: SmoothRung | null = $state(null);

	$effect(() => {
		const enabled = lodEnabled;
		if (!enabled) return;
		const rung = new SmoothRung(
			() => {
				const cfg = typeof entry.lod === 'object' ? entry.lod : {};
				return typeof cfg.smooth === 'object' ? (cfg.smooth?.window ?? 0) : 0;
			},
			() => {
				const cfg = typeof entry.lod === 'object' ? entry.lod : {};
				return ((typeof cfg.smooth === 'object' ? cfg.smooth?.mode : undefined) ??
					'centered') as SmoothMode;
			},
			{
				y: () => entry.y,
				x: () => entry.x,
				partition: () => {
					const val = entry.z ?? entry.stroke;
					if (typeof val === 'string' && isColorConstant(val)) return null;
					return val;
				}
			},
			(key, val) => setRungParam('smooth', key, val)
		);
		smoothRung = rung;
		return () => {
			rung.destroy();
			smoothRung = null;
		};
	});

	// --- M4 SYNC (reads DensityHost.shouldDecimate directly) ---
	$effect(() => {
		if (!m4Decimator || !densityHost) return;
		const should = densityHost.ctx.shouldDecimate;
		m4Decimator.setDecimationMode(should ? 'decimate' : 'passthrough');
	});

	// --- onLODChange fire ---
	let prevDecimating = false;
	let prevDotsVisible = false;
	$effect(() => {
		const onChange = lodOnChange;
		if (!onChange || !densityHost) return;
		const decimating = densityHost.ctx.shouldDecimate;
		const dotsVisible = (dotsRung?.dotRadius ?? 0) > 0;
		if (decimating !== prevDecimating || dotsVisible !== prevDotsVisible) {
			prevDecimating = decimating;
			prevDotsVisible = dotsVisible;
			const { visibleCount, density } = densityHost.ctx;
			const cfg = typeof entry.lod === 'object' ? entry.lod : {};
			const smoothWindow = typeof cfg.smooth === 'object' ? (cfg.smooth?.window ?? 0) : 0;
			onChange({
				decimating,
				dotRadius: dotsRung?.dotRadius ?? 0,
				visibleCount,
				density,
				smoothingWindow: smoothWindow
			});
		}
	});

	// Configure M4 decimator when chart dimensions or series count change.
	$effect(() => {
		if (!m4Decimator || !chartContext.innerWidth) return;

		let numSeries;
		if (markSeries.selectField) {
			const domain = markSeries.scaleState?.domain;
			if (!domain || domain.length === 0) return;
			numSeries = domain.length;
		} else {
			numSeries = 1;
		}

		const dpr = window.devicePixelRatio || 1;
		const numBins = Math.ceil(chartContext.innerWidth * dpr);
		// The y scale only for the parity page's control; see m4Parity.
		const scaleState = m4Parity.swapScale ? chartContext.yScaleState : chartContext.xScaleState;
		m4Decimator.configure(numBins, numSeries, scaleState?.id ?? null);
	});

	// --- MARK LOD SURFACE REGISTRATION ---
	$effect(() => {
		if (!lodEnabled) return;
		const host = densityHost;
		const dots = dotsRung;
		const smooth = smoothRung;
		const surface: MarkLODSurface = {
			adjustResolution(deltaY: number) {
				if (smooth?.active || deltaY > 0) {
					smooth?.adjustResolution(deltaY);
				} else {
					dots?.adjustResolution(deltaY);
				}
			},
			getRungs() {
				return [dots, smooth].filter((r): r is DotsRung | SmoothRung => r != null && !r.destroyed);
			},
			getDensityCtx() {
				return host?.ctx ?? null;
			},
			getDensityHost() {
				return host ?? null;
			}
		};
		chartContext.config.registerMarkLOD(markId, surface);
		onMarkLOD?.(surface);
		return () => {
			chartContext.config.unregisterMarkLOD(markId);
			onMarkLOD?.(null);
		};
	});

	// Tooltip registration — only guard conditions are tracked.
	// The registration body runs in untrack to avoid reactive dependencies
	// on scaleTypes, colorScaleState, etc. that recompute when overlay marks
	// register scale requirements (causing spurious unregister/re-register
	// cycles that clear currentMarkId).
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !entry.tooltip || !setup?.tooltipEnabled) return;

		untrack(() => {
			tm.registerMark(
				markId,
				buildTooltipConfig({
					tempTable: setup!.tooltipTableName,
					markType: 'line',
					chartContext,
					channelFields: setup!.channelFieldMap,
					colorColumn: 'stroke',
					...(entry.z != null && { seriesColumn: 'z', markSeries }),
					markColor,
					proximityAxis: entry.tooltipProximity,
					constantRadius: entry.dotRadius ? Number(entry.dotRadius) : undefined,
					displayFields: resolvedTip.displayFields
				})
			);
		});
		return () => tm.unregisterMark(markId);
	});

	// --- SMOOTHING OVERLAY ---
	const effectiveGlobalAlpha = $derived(opacity * (smoothRung?.active ? 0.3 : 1.0));

	onDestroy(() => {
		dotsRung?.destroy();
		smoothRung?.destroy();
		densityHost?.destroy();
		m4Decimator?.destroy();
		setup?.destroy();
		chartContext.config.unregisterMark(markId);
		gpuCoordinator?.releaseRetained(markId);
	});
</script>

{#if (setup?.gpuReady || !table) && markColor.ready && markSeries.ready && xData && yData}
	{#key effectiveCurve}
		<Lines
			{markId}
			{xData}
			{yData}
			{seriesData}
			curve={effectiveCurve}
			colorValueData={markColor.data}
			colorMode={markColor.colorMode}
			colorScaleIndex={markColor.colorScaleIndex}
			groupIndex={setup?.groupIndex ?? 0}
			activitySeriesMode={markSeries.activityMode}
			activitySeriesScaleIndex={markSeries.activityScaleIndex}
			constantColor={markColor.constantColor}
			strokeWidth={entry.strokeWidth ?? 2}
			dotRadius={effectiveDotRadius}
			globalAlpha={effectiveGlobalAlpha}
			facetData={setup?.facetData}
			dataVersion={setup?.dataVersion || 0}
			m4Decimator={m4Eligible ? m4Decimator : null}
			{dotsRung}
		/>
	{/key}
	{#if smoothRung?.active && smoothRung.node}
		{#if rung_smooth}
			{@render rung_smooth({
				table: entry.table,
				x: entry.x,
				y: entry.y,
				smoothY: smoothRung.node,
				stroke: entry.stroke ?? null,
				z: entry.z ?? null,
				windowSize: smoothRung.props.window as number
			})}
		{:else}
			<LineMark
				table={entry.table}
				selection={entry.selection}
				x={entry.x}
				y={smoothRung.node}
				stroke={entry.stroke}
				z={entry.z}
				scheme={entry.scheme}
				curve={effectiveCurve}
				strokeWidth={(entry.strokeWidth ?? 2) + 1}
				tooltip={false}
				lod={false}
				_isOverlay={true}
			/>
		{/if}
	{/if}
{:else}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12">
		Initializing mark...
	</text>
{/if}
