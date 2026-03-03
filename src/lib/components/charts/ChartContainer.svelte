<script lang="ts">
	import { setContext, getContext } from 'svelte';
	import type { Snippet } from 'svelte';
	import { ChartLayout } from '$lib/layout/ChartLayout.svelte';
	import type { Margin } from '$lib/types';
	import { ChartScales } from '$lib/scales/ChartScales.svelte';
	import { getGPUContext } from '$lib/gpu';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { ChartContext, Coordinator, FieldRef } from '$lib/types';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import ChartCell from './ChartCell.svelte';

	interface Props {
		xLabel?: string | null;
		yLabel?: string | null;
		fx?: string | null;
		columns?: number | null;
		background?: Snippet;
		foreground?: Snippet;
		canvas?: Snippet;
		canvasComponents?: Snippet;
		overlay?: Snippet;
		interactors?: Snippet;
		legend?: Snippet;
		legendPosition?: 'top' | 'right';
		wheelInteraction?: { dwellTimeMs?: number; momentumThreshold?: number; enabled?: boolean };
		xZoomLimit?: number;
		yZoomLimit?: number;
		xPanLimit?: number;
		yPanLimit?: number;
		margin?: Partial<Margin>;
		useXSelection?: boolean;
		useYSelection?: boolean;
	}

	let {
		xLabel = null,
		yLabel = null,
		fx = null,
		columns: facetColumns = null,
		background = undefined,
		foreground = undefined,
		canvas = undefined,
		canvasComponents = undefined,
		overlay = undefined,
		interactors = undefined,
		legend = undefined,
		legendPosition = 'top',
		wheelInteraction = {
			dwellTimeMs: 250,
			momentumThreshold: 150,
			enabled: true
		},
		xZoomLimit = undefined,
		yZoomLimit = undefined,
		xPanLimit = undefined,
		yPanLimit = undefined,
		margin: marginOverride = {},
		useXSelection = false,
		useYSelection = false
	}: Props = $props();

	const defaultMargin = { top: 30, right: 50, bottom: 35, left: 75 };
	const cellMargin = { ...defaultMargin, ...marginOverride };

	// Layout — used for chartId (stable UUID) and legend positioning
	const layout = new ChartLayout({
		margin: cellMargin,
		height: 250
	});

	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const gpuCoordinator = getGPUContext();
	const coordinator = getContext<Coordinator>('mosaic-coordinator');

	// --- Faceting ---
	const facetBandScale = fx
		? (scaleRegistry.getOrCreateScale(
				`__facet__${fx}`,
				'band',
				{ sourceColumn: fx },
				layout.chartId
			) as BandScaleState)
		: null;
	const facetCategories = $derived(
		facetBandScale?.effectiveDomain?.length ? facetBandScale.effectiveDomain : null
	);
	const isFaceted = $derived(!!facetCategories);
	const effectiveColumns = $derived(facetColumns ?? facetCategories?.length ?? 1);
	const facetChartIds = $derived(facetCategories?.map((_, i) => `${layout.chartId}-fx-${i}`) ?? []);

	const facetingProps = {
		fx,
		get isFaceted() {
			return isFaceted;
		},
		get facetChartIds() {
			return facetChartIds;
		},
		get facetBandScale() {
			return facetBandScale;
		}
	};

	// --- ChartScales ---
	let scales = $state<ChartScales | null>(null);

	// Queue for scale registrations that arrive before ChartScales is created.
	// Marks mount synchronously during render, but ChartScales is created in an
	// $effect (which runs after render). Without queuing, registerScaleType calls
	// from mark constructors silently fail via optional chaining on null.
	interface PendingRegistration {
		dimension: 'x' | 'y';
		type: string;
		priority: number;
		markId: string;
		config: Record<string, unknown>;
		columnName: FieldRef | null;
	}
	let pendingScaleRegistrations: PendingRegistration[] = [];

	$effect(() => {
		const x = xLabel;
		const y = yLabel;
		const l = layout;
		const g = gpuCoordinator;

		const newScales = new ChartScales({
			xLabel: x,
			yLabel: y,
			layout: l,
			gpuCoordinator: g,
			scaleRegistry: scaleRegistry,
			getFacetChartIds: () => facetChartIds,
			xZoomLimit,
			yZoomLimit,
			xPanLimit,
			yPanLimit,
			useXSelection,
			useYSelection
		});

		// Replay any scale registrations that were queued before scales existed
		for (const reg of pendingScaleRegistrations) {
			newScales.registerScaleType(
				reg.dimension,
				reg.type,
				reg.priority,
				reg.markId,
				reg.config,
				reg.columnName
			);
		}
		pendingScaleRegistrations = [];

		scales = newScales;

		return () => {
			if (newScales) {
				newScales.destroy();
			}
		};
	});

	// --- Marks-only context for hidden container (faceted mode) ---
	// In non-faceted mode, ChartCell overrides this with a full context.
	// In faceted mode, marks in the hidden container use this minimal context.
	const marksContext: ChartContext = {
		get width() {
			return layout.width;
		},
		get height() {
			return layout.height;
		},
		get innerWidth() {
			return layout.innerWidth;
		},
		get innerHeight() {
			return layout.innerHeight;
		},
		get margin() {
			return layout.margin;
		},
		get chartId() {
			return layout.chartId;
		},
		get clipPathId() {
			return layout.clipPathId;
		},
		get clipPathUrl() {
			return layout.clipPathUrl;
		},
		get isReady() {
			return layout.isReady;
		},
		get innerTransform() {
			return layout.innerTransform;
		},
		get dimensions() {
			return layout.dimensions;
		},

		updateWidth: (w) => layout.updateWidth(w),
		updateHeight: (h) => layout.updateHeight(h),
		updateMargin: (m) => layout.updateMargin(m),
		toInnerCoordinates: (p) => layout.toInnerCoordinates(p),
		toScreenCoordinates: (p) => layout.toScreenCoordinates(p),
		isWithinInnerBounds: (p) => layout.isWithinInnerBounds(p),
		getActiveAxes: (p) => layout.getActiveAxes(p),
		reset: () => layout.reset(),
		getDebugInfo: () => layout.getDebugInfo(),

		get xScale() {
			return scales?.xScale;
		},
		get yScale() {
			return scales?.yScale;
		},
		get xTargetScale() {
			return scales?.xTargetScale;
		},
		get yTargetScale() {
			return scales?.yTargetScale;
		},

		get xLabel() {
			return scales?.xLabel;
		},
		get yLabel() {
			return scales?.yLabel;
		},

		get currentXDataPoint() {
			return scales?.currentXDataPoint;
		},
		get currentYDataPoint() {
			return scales?.currentYDataPoint;
		},
		get currentXScreenPoint() {
			return scales?.currentXScreenPoint;
		},
		get currentYScreenPoint() {
			return scales?.currentYScreenPoint;
		},

		get xScaleState() {
			return scales?.xScaleState;
		},
		get yScaleState() {
			return scales?.yScaleState;
		},
		get scaleTypes() {
			return scales?.scaleTypes;
		},
		get scalesReady() {
			return scales?.scalesReady;
		},
		get active() {
			return scales?.active;
		},

		get xCategoryPositions() {
			return scales?.xCategoryPositions;
		},
		get yCategoryPositions() {
			return scales?.yCategoryPositions;
		},
		get categoryPositionsReady() {
			return scales?.categoryPositionsReady;
		},
		get xBandwidth() {
			return scales?.xBandwidth;
		},
		get yBandwidth() {
			return scales?.yBandwidth;
		},

		registerScaleType: (dimension, type, priority, markId, config, columnName) => {
			const dim = dimension as 'x' | 'y';
			if (scales) {
				scales.registerScaleType(dim, type, priority, markId, config, columnName);
			} else {
				pendingScaleRegistrations.push({
					dimension: dim,
					type,
					priority,
					markId,
					config,
					columnName
				});
			}
		},
		unregisterScaleType: (dimension, markId) =>
			scales?.unregisterScaleType(dimension as 'x' | 'y', markId),

		get binStepMultiplier() {
			return scales?.binStepMultiplier;
		},

		registerClient(client) {
			if (!client || !scales) return () => {};
			return scales.registerClient(client);
		},
		get markClients() {
			return scales?.markClients;
		},

		get tooltipManager() {
			return null;
		},

		fx,
		get isFaceted() {
			return isFaceted;
		},
		get facetChartIds() {
			return facetChartIds;
		},
		get facetBandScale() {
			return facetBandScale;
		},

		onChartClick: null,
		onInteractorPointerDown: null,
		onInteractorPointerMove: null,
		onInteractorPointerUp: null,
		onInteractorPointerEnter: null
	};

	setContext('chart', marksContext);
	setContext('legend-position', () => legendPosition);
</script>

<div class="figure-container" bind:clientWidth={layout.width}>
	{#if legend && legendPosition === 'top'}
		<div
			class="legend-container legend-top"
			style:padding-left="{cellMargin.left}px"
			style:padding-right="{cellMargin.right}px"
		>
			{@render legend()}
		</div>
	{/if}

	{#if fx}
		<!-- Faceted mode -->
		<div class="facet-marks-container">
			{@render canvas?.()}
		</div>

		{#if facetCategories}
			<div class="facet-grid" style:grid-template-columns="repeat({effectiveColumns}, 1fr)">
				{#each facetCategories as cat, i (cat)}
					<ChartCell
						cellChartId={facetChartIds[i]}
						facetIndex={i}
						facetLabel={cat}
						margin={{ top: 20, right: 10, bottom: 35, left: 55 }}
						{scales}
						{facetingProps}
						{gpuCoordinator}
						{coordinator}
						{wheelInteraction}
						{background}
						{foreground}
						canvas={null}
						{interactors}
						{overlay}
					/>
				{/each}
			</div>
		{:else}
			<div class="facet-loading">Discovering facet categories...</div>
		{/if}
	{:else}
		<!-- Normal (non-faceted) mode -->
		<ChartCell
			cellChartId={layout.chartId}
			margin={cellMargin}
			{scales}
			{facetingProps}
			{gpuCoordinator}
			{coordinator}
			{wheelInteraction}
			{background}
			{foreground}
			{canvas}
			{interactors}
			{overlay}
		/>
	{/if}

	{#if legend && legendPosition === 'right'}
		<div
			class="legend-container legend-right"
			style:top="{cellMargin.top}px"
			style:left="{cellMargin.left + layout.innerWidth + 8}px"
		>
			{@render legend()}
		</div>
	{/if}
</div>

<style>
	.figure-container {
		display: flex;
		flex-direction: column;
		flex: 1;
		height: 100%;
		position: relative;
		overflow: visible;
	}

	.legend-container {
		pointer-events: none;
	}

	.legend-top {
		flex-shrink: 0;
		margin-bottom: -20px;
		position: relative;
		z-index: 4;
	}

	.legend-right {
		position: absolute;
		z-index: 4;
		overflow-y: auto;
		max-height: calc(100% - 60px);
	}

	.facet-marks-container {
		position: absolute;
		width: 0;
		height: 0;
		overflow: hidden;
		pointer-events: none;
	}

	.facet-grid {
		display: grid;
		flex: 1;
		min-height: 0;
		gap: 4px;
	}

	.facet-loading {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--diveplot-text-muted, #d1d5db);
		font-size: 13px;
	}
</style>
