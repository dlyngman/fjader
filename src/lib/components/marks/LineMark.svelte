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

	interface Props extends BaseMarkProps, ContinuousScaleTypeProps, ConnectedTopologyProps {
		x: FieldRef;
		y: FieldRef;
		stroke?: FieldRef | null;
		strokeWidth?: number;
		dotRadius?: number;
		lod?: boolean | LODConfig;
		onLodController?: (ctrl: LODController | null) => void;
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
		lod = true,
		onLodController = undefined
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

	const config = $derived({
		markType: 'line',
		supportedScaleTypes: {
			x: ['linear', 'time', 'log', 'symlog'],
			y: ['linear', 'time', 'log', 'symlog']
		},
		scaleRequirements: {
			x: effectiveXScaleType
				? { type: effectiveXScaleType, priority: SCALE_PRIORITIES.PREFER }
				: null,
			y: effectiveYScaleType
				? { type: effectiveYScaleType, priority: SCALE_PRIORITIES.PREFER }
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
		tooltip: entry.tip === false ? false : entry.tooltip
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
		return { dotsR, dotsThreshold, multiplier };
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
	function updateEntryLod(key: string, value: number): void {
		const current = entry.lod;
		const cfg = typeof current === 'object' && current ? current : {};
		let updated: Record<string, unknown>;

		if (key === 'dotsThreshold') {
			const dots = typeof cfg.dots === 'object' && cfg.dots ? { ...cfg.dots } : {};
			dots.threshold = value;
			updated = { ...cfg, dots };
		} else if (key === 'baseRadius') {
			const dots = typeof cfg.dots === 'object' && cfg.dots ? { ...cfg.dots } : {};
			dots.r = value;
			updated = { ...cfg, dots };
		} else {
			updated = { ...cfg, multiplier: value };
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
		const initTunables = lodTunables;
		const ctrl = new LODController(coordinator, gpuCoordinator, chartContext, {
			mode: 'line',
			countQueryBuilder: (xLo: number, xHi: number, yLo: number, yHi: number) =>
				setup.buildViewportCountQuery('x', xLo, xHi, 'y', yLo, yHi),
			baseR: initTunables.dotsR,
			dotsEnabled,
			dotsThreshold: initTunables.dotsThreshold,
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
		const xScaleIndex = chartContext.xScaleState
			? (gpuCoordinator.getScaleIndex?.(chartContext.xScaleState.id) ?? 0)
			: 0;
		m4Decimator.configure(numBins, numSeries, xScaleIndex);
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
			facetData={setup?.facetData}
			dataVersion={setup?.client?.dataVersion || 0}
			m4Decimator={m4Eligible ? m4Decimator : null}
			{lodController}
		/>
	{/key}
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
