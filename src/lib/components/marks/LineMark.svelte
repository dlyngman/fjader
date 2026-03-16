<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycle } from './lifecycle/MarkLifecycle.svelte';
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
		resolveTip,
		resolveSelection
	} from './utils';
	import { getGPUContext } from '$lib/gpu';
	import { M4Decimator } from '$lib/gpu/decimation/M4Decimator.svelte';
	import { LODController } from '$lib/lod';
	import { RollingAvgNode, type SmoothMode } from '$lib/sql/rolling-avg';
	import type {
		FieldRef,
		BaseMarkProps,
		ContinuousScaleTypeProps,
		ConnectedTopologyProps,
		LODConfig,
		Coordinator,
		ChartContext
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
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
		y: FieldRef;
		stroke?: FieldRef | null;
		strokeWidth?: number;
		dotRadius?: number;
		fitDomain?: 'x' | 'y' | boolean;
		lod?: boolean | LODConfig;
		onLodController?: (ctrl: LODController | null) => void;
		/** Custom rendering for the smoothing overlay rung. */
		rung_smooth?: Snippet<[SmoothRungContext]>;
		/** @internal Prevents recursive overlay spawning. */
		_isOverlay?: boolean;
	}

	let {
		table,
		selection = undefined,
		x,
		y,
		stroke = null,
		z = null,
		scheme,
		curve = 'linear',
		strokeWidth = 2,
		dotRadius = 0,
		limit,
		filterNulls = false,
		preferredXScaleType = null,
		preferredYScaleType = null,
		transforms = [],
		sort = null,
		tooltip = true,
		tooltipProximity,
		tip = undefined,
		fitDomain = undefined,
		lod = true,
		onLodController = undefined,
		rung_smooth = undefined,
		_isOverlay = false
	}: Props = $props();

	// Map user-facing aliases to axis-specific variants
	const effectiveCurve = $derived.by(() => {
		const c = entry.curve ?? 'linear';
		return c === 'monotone' ? 'monotone-x' : c === 'bump' ? 'bump-x' : c;
	});

	const markId = generateMarkId('line');
	const coordinator = getContext<Coordinator>('mosaic-coordinator');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');

	// Ensure services are ready before inference (idempotent)
	MarkLifecycle.ensureServices(coordinator);

	// --- ChartConfig registration ---
	const entry = chartContext.config.registerMark(markId, 'line', {
		table: () => table,
		x: () => x,
		y: () => y,
		stroke: () => stroke,
		z: () => z,
		scheme: () => scheme,
		curve: () => curve,
		strokeWidth: () => strokeWidth,
		dotRadius: () => dotRadius,
		transforms: () => transforms,
		selection: () => selection,
		limit: () => limit,
		filterNulls: () => filterNulls,
		preferredXScaleType: () => preferredXScaleType,
		preferredYScaleType: () => preferredYScaleType,
		sort: () => sort,
		tooltip: () => tooltip,
		tooltipProximity: () => tooltipProximity,
		tip: () => tip,
		fitDomain: () => fitDomain,
		lod: () => lod
	});

	let setup = $state(null);

	// 0. Scale Type Inference — reads from entry
	const effectiveXScaleType = $derived.by(() =>
		inferMarkScaleType(entry.x, entry.table, entry.preferredXScaleType)
	);
	const effectiveYScaleType = $derived.by(() =>
		inferMarkScaleType(entry.y, entry.table, entry.preferredYScaleType)
	);

	// Series grouping: z overrides stroke for grouping
	const seriesChannelKey = entry.z != null ? 'z' : 'stroke';
	const markSeries = new MarkSeries(
		() => entry.z ?? entry.stroke,
		seriesChannelKey,
		() => entry.table,
		() => setup,
		scaleRegistry,
		chartContext
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

	// Config with _connectedConfig for automatic ORDER BY — reads from entry
	const channelSelect = $derived(
		buildSelectFromChannels({
			x: entry.x,
			y: entry.y,
			...(markColor.selectField && { stroke: markColor.selectField }),
			...(entry.z != null && markSeries.selectField && { z: markSeries.selectField })
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
		selection: resolveSelection(entry.selection),
		transforms: entry.transforms ?? [],
		select: { ...channelSelect, ...resolvedTip.extraSelect },
		colorChannel: 'stroke',
		// Connected topology config - ensures data is ordered for line connectivity
		_connectedConfig: {
			seriesChannel: markSeries.selectField ? seriesChannelKey : null,
			dimensionChannel: 'x'
		},
		clientOptions: {
			limit: entry.limit,
			filterNulls: entry.filterNulls ? ([entry.x, entry.y] as FieldRef[]) : null
		},
		sort: normalizeSortConfig(entry.sort ?? null),
		tooltip: entry.tip === false ? false : entry.tooltip,
		fitDomain: _isOverlay ? undefined : (entry.fitDomain as 'x' | 'y' | boolean | undefined),
		passiveScales: _isOverlay
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
		(void config, xScaleId, yScaleId);
		untrack(() => {
			if (setup) {
				gpuCoordinator?.markForRetain(markId);
			}
			setup?.destroy();
			setup = null;
			// Don't create MarkLifecycle until scale type inference has resolved.
			if (entry.table && effectiveXScaleType && effectiveYScaleType) {
				setup = new MarkLifecycle(config, coordinator, chartContext, markId);
			}
		});
	});

	// MarkColor and MarkSeries connect to setup internally via their lifecycle effects

	// --- LOD CONFIG RESOLUTION ---
	const gpuCoordinator = getGPUContext();
	const faceted = !!chartContext.fx;
	const entryLod = $derived(entry.lod);

	// Structural config — individual primitives so Svelte 5 can compare by value.
	// Only changes to these recreate the LODController.
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

	// Tunable values — read from entry.lod, synced to controller without recreation.
	const lodTunables = $derived.by(() => {
		const cfg = typeof entryLod === 'object' ? entryLod : {};
		const dr = entry.dotRadius ?? 0;
		const dotsR =
			(typeof cfg.dots === 'object' ? cfg.dots.r : undefined) ?? (dr > 0 ? dr : 2.5);
		const dotsThreshold =
			typeof cfg.dots === 'object' ? (cfg.dots.threshold ?? 18) : 18;
		const multiplier = cfg.multiplier ?? 1.0;
		const smoothWindow =
			typeof cfg.smooth === 'object' ? (cfg.smooth?.window ?? 0) : 0;
		const smoothMode =
			(typeof cfg.smooth === 'object' ? cfg.smooth?.mode : undefined) ?? 'centered';
		return { dotsR, dotsThreshold, multiplier, smoothWindow, smoothMode };
	});

	// M4 created only when LODController is active and decimation isn't disabled.
	// No LODController = no M4 (raw data passthrough, correct for sparse data).
	const m4Eligible = $derived.by(() => {
		if (!lodEnabled) return false;
		if (lodDecimate === false || faceted) return false;
		const xType = chartContext.scaleTypes?.x;
		if (xType === 'log' || xType === 'symlog') return false;
		return true;
	});

	// When LOD is active, LODController writes dotRadius directly to the GPU buffer
	// via its frame callback — no reactive chain. We set 0 here as a placeholder.
	// Without LOD: dotRadius > 0 shows fixed dots, 0 = no dots.
	const effectiveDotRadius = $derived.by(() => {
		if (lodEnabled && lodController) return 0; // LODController writes directly to GPU
		return entry.dotRadius ?? 0;
	});

	let m4Decimator = $state(null);

	$effect(() => {
		if (m4Eligible && gpuCoordinator?.device && gpuCoordinator?.globalScaleLayout) {
			const decimator = new M4Decimator(gpuCoordinator.device, gpuCoordinator.globalScaleLayout);
			m4Decimator = decimator;
			return () => {
				decimator.destroy();
				m4Decimator = null;
			};
		} else {
			m4Decimator = null;
		}
	});

	// Write-back: when LODController tunables change (shift+scroll), persist to entry.lod
	function updateEntryLod(key: string, value: number | string): void {
		const current = entry.lod;
		const cfg = typeof current === 'object' && current ? current : {};
		let updated: Record<string, unknown>;

		if (key === 'dotsThreshold') {
			const dots = typeof cfg.dots === 'object' && cfg.dots ? { ...cfg.dots } : {};
			dots.threshold = value as number;
			updated = { ...cfg, dots };
		} else if (key === 'baseRadius') {
			const dots = typeof cfg.dots === 'object' && cfg.dots ? { ...cfg.dots } : {};
			dots.r = value as number;
			updated = { ...cfg, dots };
		} else if (key === 'smoothWindow' || key === 'smoothMode') {
			const smooth =
				typeof cfg.smooth === 'object' && cfg.smooth ? { ...cfg.smooth } : {};
			if (key === 'smoothWindow') smooth.window = value as number;
			else smooth.mode = value as SmoothMode;
			updated = { ...cfg, smooth };
		} else {
			updated = { ...cfg, multiplier: value as number };
		}

		chartContext.config.setMarkProp(markId, 'lod', updated);
	}

	// --- LOD CONTROLLER ---
	let lodController: LODController | null = $state(null);

	$effect(() => {
		if (!lodEnabled || !setup || !coordinator || !gpuCoordinator) {
			lodController?.destroy();
			lodController = null;
			onLodController?.(null);
			return;
		}
		// Read structural primitives — these are tracked, recreation happens only
		// when they change. Tunables synced via separate effect below.
		const dotsEnabled = lodDotsEnabled;
		const decimate = lodDecimate;
		const onLODChange = lodOnChange;
		// Read tunables WITHOUT tracking — tunable changes are synced via separate effect.
		// Tracking here would re-create the controller on every tunable edit (flicker).
		const initTunables = untrack(() => lodTunables);
		const ctrl = new LODController(coordinator, gpuCoordinator, chartContext, {
			mode: 'line',
			countQueryBuilder: (xLo: number, xHi: number, yLo: number, yHi: number) =>
				setup.buildViewportCountQuery('x', xLo, xHi, 'y', yLo, yHi),
			baseR: initTunables.dotsR,
			dotsEnabled,
			dotsThreshold: initTunables.dotsThreshold,
			smoothWindow: initTunables.smoothWindow,
			smoothMode: initTunables.smoothMode as SmoothMode,
			decimate,
			onLODChange,
			onTunableChange: (key, value) => updateEntryLod(key, value)
		});
		lodController = ctrl;
		onLodController?.(ctrl);
		return () => {
			ctrl.destroy();
			lodController = null;
			onLodController?.(null);
		};
	});

	// Sync tunable changes to controller without recreating it.
	// Palette writes to entry.lod → lodTunables updates → this effect pushes to controller.
	$effect(() => {
		if (!lodController) return;
		const t = lodTunables;
		lodController.setDotsThreshold(t.dotsThreshold);
		lodController.setBaseRadius(t.dotsR);
		lodController.setSmoothWindow(t.smoothWindow);
		lodController.setSmoothMode(t.smoothMode as SmoothMode);
		// Multiplier is chart-level state but we persist the mark's requested value
		if (lodController.mode === 'binned') {
			lodController.setBinMultiplier(t.multiplier);
		}
	});

	// Sync M4 decimator to LODController — decoupled so M4 recreation
	// (e.g. on resize) doesn't tear down the controller and lose state.
	$effect(() => {
		lodController?.setM4Decimator(m4Decimator);
	});

	// Configure M4 decimator when chart dimensions or series count change.
	// When stroke is set, wait for the series domain to be populated (async fetch).
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
		// Resolver is called at dispatch time — always gets the current index
		// even after ScaleIndexManager rebuilds shift slot assignments.
		const scaleState = chartContext.xScaleState;
		const resolveIndex = () =>
			scaleState ? (gpuCoordinator.getScaleIndex?.(scaleState.id) ?? 0) : 0;
		m4Decimator.configure(numBins, numSeries, resolveIndex);
	});

	// LODController registration with ChartConfig (palette access + shift+scroll routing via TooltipManager delegation)
	$effect(() => {
		if (!lodController) return;
		chartContext.config.registerLodController(markId, lodController);
		return () => chartContext.config.unregisterLodController(markId);
	});

	// Tooltip registration — reads from entry
	$effect(() => {
		const tm = chartContext.tooltipManager;
		if (!tm || !entry.tooltip || !setup?.tooltipEnabled) return;

		tm.registerMark(
			markId,
			buildTooltipConfig({
				tempTable: setup.tooltipTableName,
				markType: 'line',
				chartContext,
				channelFields: setup.channelFieldMap,
				colorColumn: 'stroke',
				markColor,
				proximityAxis: entry.tooltipProximity,
				constantRadius: entry.dotRadius ? Number(entry.dotRadius) : undefined,
				displayFields: resolvedTip.displayFields
			})
		);
		return () => tm.unregisterMark(markId);
	});

	// --- SMOOTHING OVERLAY ---
	const smoothWindow = $derived(lodController?.state?.smoothWindow ?? 0);
	const smoothMode = $derived(lodController?.state?.smoothMode ?? 'centered');
	const overlayActive = $derived(!_isOverlay && smoothWindow > 0);
	const effectiveGlobalAlpha = $derived(overlayActive ? 0.3 : 1.0);

	// Stable RollingAvgNode — created once, mutated on window size changes.
	// MarkLifecycle resolves it during buildQuery() and re-queries via invalidation
	// callback (same pattern as AutoBinNode + triggerReBin). No lifecycle recreation.
	let rollingAvgNode: RollingAvgNode | null = $state(null);
	$effect(() => {
		if (!overlayActive) {
			rollingAvgNode = null;
			return;
		}
		// Create once when overlay activates, reuse across window changes
		if (!rollingAvgNode) {
			const seriesField = entry.z ?? entry.stroke;
			rollingAvgNode = new RollingAvgNode(
				String(entry.y),
				String(entry.x),
				seriesField ? String(seriesField) : null,
				smoothWindow,
				smoothMode as SmoothMode
			);
		}
	});

	// Sync window size and mode to the node — triggers invalidation callback → re-query
	$effect(() => {
		if (rollingAvgNode && smoothWindow > 0) {
			rollingAvgNode.setWindowSize(smoothWindow);
			rollingAvgNode.setMode(smoothMode as SmoothMode);
		}
	});

	onDestroy(() => {
		lodController?.destroy();
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
			constantColor={markColor.constantColor}
			strokeWidth={entry.strokeWidth ?? 2}
			dotRadius={effectiveDotRadius}
			globalAlpha={effectiveGlobalAlpha}
			facetData={setup?.facetData}
			dataVersion={setup?.client?.dataVersion || 0}
			m4Decimator={m4Eligible ? m4Decimator : null}
			{lodController}
		/>
	{/key}
	{#if overlayActive && rollingAvgNode}
		{#if rung_smooth}
			{@render rung_smooth({
				table: entry.table,
				x: entry.x,
				y: entry.y,
				smoothY: rollingAvgNode,
				stroke: entry.stroke ?? null,
				z: entry.z ?? null,
				windowSize: smoothWindow
			})}
		{:else}
			<LineMark
				table={entry.table}
				selection={entry.selection}
				x={entry.x}
				y={rollingAvgNode as any}
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
{:else if setup?.client?.error}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="red" font-size="12">
		Error: {setup.client.error.message}
	</text>
{:else if setup?.client?.delayedLoading}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12">
		Loading data...
	</text>
{:else}
	<text x={chartContext.margin.left} y={chartContext.margin.top} fill="currentColor" font-size="12">
		Initializing mark...
	</text>
{/if}
