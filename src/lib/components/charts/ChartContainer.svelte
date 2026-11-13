<script lang="ts">
	import { ScaleGeneration } from '$lib/scales/ScaleGeneration.svelte';
	import { ChartVisibility } from './ChartVisibility.svelte';
	import { ChartHover } from './ChartHover.svelte';
	import { setContext, getContext, onDestroy } from 'svelte';
	import type { Snippet } from 'svelte';
	import { ChartLayout } from '$lib/layout/ChartLayout.svelte';
	import type { Margin } from '$lib/types';
	import { ChartScales } from '$lib/scales/ChartScales.svelte';
	import { ChartConfig } from '$lib/config';
	import { getGPUContext } from '$lib/gpu';
	import type { ScaleRegistry, AnyScaleState } from '$lib/scales/ScaleRegistry.svelte';
	import type { ChartContext, EntranceMode, FieldRef } from '$lib/types';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import type { DimValue } from '$lib/query-engine/categorical-identity';
	import { identityKeyFor } from '$lib/query-engine/identity-key';
	import { checkFacetCells } from './facet-limits';
	import ChartCell from './ChartCell.svelte';
	import { categoryLabel } from '$lib/query-engine/categorical-identity';

	interface Props {
		xLabel?: string | null;
		yLabel?: string | null;
		/**
		 * The facet channel: a column name, or a fixed SQL expression over one.
		 *
		 * Whatever a categorical channel accepts anywhere else, because it goes
		 * through the same `identityKeyFor` and the same dim (#197) — an
		 * expression is keyed on its own text and gets an identity exactly as a
		 * column does. bin(), aggregates and window functions are refused for the
		 * reasons stated there, and the mark reports the refusal.
		 *
		 * Expressions matter here more than on an axis: one cell per distinct
		 * TIMESTAMP is one cell per row, so `date_trunc` is the operation a
		 * temporal facet almost always wants, and before this it could only be
		 * had by materialising a column in SQL first.
		 */
		fx?: FieldRef | null;
		/**
		 * Explicit cell order for the facet grid, as source values.
		 *
		 * Without it, cell order is the dim's — ordered by value, so id equals
		 * cell index and the two are indistinguishable. This is what makes them
		 * differ, which every part of the facet identity path depends on being
		 * handled and no chart previously exercised.
		 *
		 * Applied during MARK setup, not here. ScaleRegistry destroys a scale when
		 * its chart-id usage hits zero — clearing the explicit domain and the
		 * extents while keeping the instance — and a faceted container triggers
		 * exactly that when it stops being a single chart and becomes a grid. So
		 * anything registered at container init is wiped before the cells mount.
		 *
		 * Static, not reactive: changing it after mount will not move the cells.
		 *
		 * SHARED, and this will surprise you. ScaleRegistry keys scales by name
		 * plus type plus config, and a facet scale is named `__facet__<fx>`, so
		 * every ChartContainer faceting on the same field holds the SAME
		 * BandScaleState. Setting this reorders the cells of all of them, not
		 * just this one. Give a chart its own facet column when you want its
		 * order to be its own — the same workaround the positional `domain` prop
		 * needs, for the same reason.
		 */
		fxDomain?: DimValue[] | null;
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
		xDisableZoom?: boolean;
		yDisableZoom?: boolean;
		margin?: Partial<Margin>;
		clipPadding?: number;
		useXSelection?: boolean;
		useYSelection?: boolean;
		/**
		 * The tooltip's colours against the color-scheme the chart inherits:
		 * `contrast` is the opposite scheme (dark on a light page), `follow` the
		 * same. Unset, the nearest `data-fjader-tooltip` ancestor decides, else
		 * contrast. `--fjader-tooltip-bg`/`-text` set by the app override both.
		 */
		tooltipScheme?: 'contrast' | 'follow';
		/**
		 * How the marks enter when data first draws: 'auto' grows bars and
		 * areas from 0 and fades the rest, 'fade' fades everything, 'none'
		 * shows them at once. Reduced motion turns 'auto' into 'fade'.
		 */
		entrance?: EntranceMode;
	}

	let {
		xLabel = null,
		yLabel = null,
		fx = null,
		fxDomain = null,
		columns: facetColumns = null,
		background = undefined,
		foreground = undefined,
		canvas = undefined,
		canvasComponents = undefined,
		overlay = undefined,
		interactors = undefined,
		legend = undefined,
		legendPosition = 'top',
		entrance = 'auto',
		wheelInteraction = {
			dwellTimeMs: 250,
			momentumThreshold: 150,
			enabled: true
		},
		xZoomLimit = undefined,
		yZoomLimit = undefined,
		xPanLimit = undefined,
		yPanLimit = undefined,
		xDisableZoom = undefined,
		yDisableZoom = undefined,
		margin: marginOverride = {},
		clipPadding = 0,
		useXSelection = false,
		useYSelection = false,
		tooltipScheme = undefined
	}: Props = $props();

	const defaultMargin = { top: 30, right: 50, bottom: 35, left: 75 };
	const cellMargin = { ...defaultMargin, ...marginOverride };

	// Layout — used for chartId (stable UUID) and legend positioning
	const layout = new ChartLayout({
		margin: cellMargin,
		height: 250,
		clipPadding
	});

	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const gpuCoordinator = getGPUContext();

	// --- Faceting ---
	//
	// Named and registered on the IDENTITY KEY, not on `fx` itself. For a column
	// the two are the same string; for an expression the key is its SQL text,
	// while `${fx}` on the node would name the scale after whatever toString
	// happens to produce. The key is also what CategoricalIdentity names the dim
	// after and what the mark looks the scale up by, so deriving all three from
	// one function is what stops them diverging (see identity-key.ts).
	const facetKey = identityKeyFor(fx);
	const facetBandScale = facetKey
		? (scaleRegistry.getOrCreateScale(
				`__facet__${facetKey.key}`,
				'band',
				{ sourceField: facetKey.key },
				layout.chartId
			) as BandScaleState)
		: null;
	// The container HOLDS this scale for its whole life, but its usage as a
	// *chart* is transient: it registers under layout.chartId, then becomes a
	// grid, and ChartScales' teardown calls removeChartUsage for that id. Usage
	// hits zero while the object is still in use by the container and every cell
	// it handed the reference to, and deregisterChart then destroys it, drops it
	// from scaleUsage and removes it from storage.
	//
	// So ownership is registered separately from chart usage, under an id that
	// lives exactly as long as this component. Synchronous here rather than in
	// onMount because the teardown it has to outlive happens before cells mount
	// — an onMount registration would restore the refcount after the eviction
	// instead of preventing it.
	//
	// Cells are NOT registered individually. They come and go with the facet
	// domain, which would reintroduce a window at every domain change; the
	// container outlives all of them and is the honest owner.
	const facetOwnerId = facetBandScale ? `${layout.chartId}-fx-owner` : null;
	if (facetBandScale && facetOwnerId) {
		scaleRegistry.registerChart(facetBandScale, facetOwnerId);
	}

	onDestroy(() => {
		if (facetBandScale && facetOwnerId) {
			scaleRegistry.deregisterChart(facetBandScale, facetOwnerId);
		}
	});

	const facetCategories = $derived(
		facetBandScale?.effectiveDomain?.length ? facetBandScale.effectiveDomain : null
	);

	// A grid of one chart per category, gated on the count. The dim's
	// own limit is three orders of magnitude higher and answers a different
	// question — see facet-limits.ts.
	const facetCheck = $derived(
		facetCategories ? checkFacetCells(facetCategories.length, facetKey?.key ?? 'fx') : null
	);
	const facetRefusal = $derived(facetCheck && !facetCheck.ok ? facetCheck.message : null);
	const isFaceted = $derived(!!facetCategories && !facetRefusal);
	const effectiveColumns = $derived(facetColumns ?? facetCategories?.length ?? 1);
	// Gated on isFaceted, not on facetCategories: a refused grid must not hand
	// out cell ids, or the marks compile a faceted pipeline for cells that are
	// never mounted.
	const facetChartIds = $derived(
		isFaceted ? (facetCategories?.map((_, i) => `${layout.chartId}-fx-${i}`) ?? []) : []
	);

	const facetingProps = {
		fx,
		fxDomain,
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
	// Survives `scales` being recreated: see ScaleGeneration.
	const scaleGeneration = new ScaleGeneration(() => scales);
	// Whether any cell is on screen; the cells report into it.
	const chartVisibility = new ChartVisibility(
		gpuCoordinator
			? {
					chartsUsing: (scale) => scaleRegistry.chartsUsing(scale as AnyScaleState),
					isChartVisible: (chartId) => gpuCoordinator.isChartVisible(chartId)
				}
			: null
	);
	// Whether the pointer is over any cell; the cells report into it.
	const chartHover = new ChartHover();

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
			xDisableZoom,
			yDisableZoom,
			useXSelection,
			useYSelection,
			entranceGate: chartConfig.entrance
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

	// --- ChartConfig (reactive configuration store) ---
	const chartConfig = new ChartConfig();
	onDestroy(() => chartConfig.entrance.destroy());

	// Register chart-level props for palette overrides
	chartConfig.registerChart({
		entrance: () => entrance,
		marginTop: () => cellMargin.top,
		marginRight: () => cellMargin.right,
		marginBottom: () => cellMargin.bottom,
		marginLeft: () => cellMargin.left
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
		get xColumnName() {
			return scales?.xColumnName ?? null;
		},
		get yColumnName() {
			return scales?.yColumnName ?? null;
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
		get scaleGeneration() {
			return scaleGeneration.value;
		},
		get visible() {
			return chartVisibility.visible;
		},
		shownElsewhere: (scale) => chartVisibility.shownElsewhere(scale),
		get hovered() {
			return chartHover.hovered;
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

		setParallelColumns: (markId, columns) => scales?.setParallelColumns(markId, columns),
		reorderParallelAxis: (from, to) => scales?.reorderParallelAxis(from, to),
		get parallelReorderState() {
			return { dataIdx: scales?.reorderDataIdx ?? null, currentX: scales?.reorderCurrentX ?? null };
		},
		get animatedAxisXPositions() {
			return scales?.animatedAxisXPositions ?? [];
		},

		get parallelScales() {
			return scales?.parallelScales ?? null;
		},

		get binStepMultiplier() {
			return scales?.binStepMultiplier;
		},

		get tooltipManager() {
			return null;
		},

		fx,
		fxDomain,
		get isFaceted() {
			return isFaceted;
		},
		get facetChartIds() {
			return facetChartIds;
		},
		get facetBandScale() {
			return facetBandScale;
		},

		config: chartConfig,

		onChartClick: null,
		onInteractorPointerDown: null,
		onInteractorPointerMove: null,
		onInteractorPointerUp: null,
		onInteractorDragEnd: null,
		// Presses belong to the chart cells, whose context the brushes get.
		reroutePress: () => {},
		activators: new Set()
	};

	setContext('chart', marksContext);
	setContext('legend-position', () => legendPosition);
</script>

<div class="figure-container" bind:clientWidth={layout.width} data-fjader-tooltip={tooltipScheme}>
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

		{#if facetRefusal}
			<!-- Shown, not logged. A blank area plus a console line is the failure
			     mode the dim's refusals were written to avoid. -->
			<div class="facet-refusal" role="alert">{facetRefusal}</div>
		{:else if facetCategories}
			{#if facetCheck?.message}
				<div class="facet-warning">{facetCheck.message}</div>
			{/if}
			<div class="facet-grid" style:grid-template-columns="repeat({effectiveColumns}, 1fr)">
				{#each facetCategories as cat, i (cat)}
					<ChartCell
						cellChartId={facetChartIds[i]}
						facetIndex={i}
						facetLabel={String(categoryLabel(cat))}
						margin={{ top: 20, right: 10, bottom: 35, left: 55 }}
						{scales}
						{scaleGeneration}
						{chartVisibility}
						{chartHover}
						{chartConfig}
						{facetingProps}
						{gpuCoordinator}
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
			{clipPadding}
			{scales}
			{scaleGeneration}
			{chartVisibility}
			{chartHover}
			{chartConfig}
			{facetingProps}
			{gpuCoordinator}
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

	.facet-refusal,
	.facet-warning {
		flex: 0 0 auto;
		padding: 10px 12px;
		border-radius: 4px;
		font-size: 12px;
		line-height: 1.45;
	}

	.facet-refusal {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		text-align: center;
		color: var(--fjader-error-text, #b00020);
		background: var(--fjader-error-bg, rgba(176, 0, 32, 0.06));
	}

	.facet-warning {
		color: var(--fjader-text-muted, #6b7280);
	}

	.facet-loading {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--fjader-text-muted, #d1d5db);
		font-size: 13px;
	}
</style>
