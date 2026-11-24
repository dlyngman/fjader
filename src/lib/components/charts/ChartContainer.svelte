<script lang="ts">
	import { ScaleGeneration } from '$lib/scales/ScaleGeneration.svelte';
	import { ChartVisibility } from './ChartVisibility.svelte';
	import { ChartHover } from './ChartHover.svelte';
	import { setContext, getContext, onDestroy, untrack } from 'svelte';
	import type { Snippet } from 'svelte';
	import { ChartLayout } from '$lib/layout/ChartLayout.svelte';
	import type { Margin } from '$lib/types';
	import { ChartScales } from '$lib/scales/ChartScales.svelte';
	import { MarkContributions } from './MarkContributions';
	import { ChartConfig } from '$lib/config';
	import { getGPUContext } from '$lib/gpu';
	import type { ScaleRegistry, AnyScaleState } from '$lib/scales/ScaleRegistry.svelte';
	import type { ChartContext, EntranceMode, FieldRef } from '$lib/types';
	import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
	import type { DimValue } from '$lib/query-engine/categorical-identity';
	import { identityKeyFor } from '$lib/query-engine/identity-key';
	import { checkFacetCells } from './facet-limits';
	import { FACET_LABEL_HEIGHT, hasTopYTitle } from './facet-margin';
	import ChartCell from './ChartCell.svelte';
	import {
		DECLARATION_CHART,
		DECLARATION_REGISTRY,
		DeclarationRegistry,
		type DeclarationChart
	} from './declarations.svelte';
	import WebGPUCanvas from '../rendering/WebGPUCanvas.svelte';
	import { CHART_TEXT_ATLAS, TextAtlas } from '$lib/gpu/text/TextAtlas.svelte';
	import { categoryLabel } from '$lib/query-engine/categorical-identity';

	interface Props {
		xLabel?: string | null;
		yLabel?: string | null;
		/**
		 * Which charts share the x axis (domain, zoom and pan). By default axes
		 * with the same label share, else the same column, across tables; an
		 * aggregate without a label is this chart's own. A name shares with the
		 * charts naming it (different columns that are one measurement) on numeric
		 * and time axes (start and end dates, say); band and point ignore it with a
		 * warning, and share only the same column. False keeps the axis to this
		 * chart.
		 */
		xScale?: string | false;
		/** As `xScale`, for the y axis. */
		yScale?: string | false;
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
		/**
		 * The chart's components: marks, `Grid`, `Frame`, the axes, overlays
		 * (`Crosshair`, `MarginLabel`, `SvgLayer`), brushes, `Toggle` and
		 * `Legend`. Each draws where it belongs, in every cell of a facet grid (a
		 * legend once, above the plot or to its right); the chart makes its own
		 * canvas for them.
		 */
		children?: Snippet;
		/**
		 * Removed in 0.3.0, with `canvas`, `foreground`, `interactors` and
		 * `overlay`: place the components as the chart's children. Typed never so
		 * an upgrade fails to type-check rather than render a blank chart.
		 */
		background?: never;
		canvas?: never;
		foreground?: never;
		interactors?: never;
		overlay?: never;
		wheelInteraction?: { dwellTimeMs?: number; momentumThreshold?: number; enabled?: boolean };
		xZoomLimit?: number;
		yZoomLimit?: number;
		xPanLimit?: number;
		yPanLimit?: number;
		xDisableZoom?: boolean;
		yDisableZoom?: boolean;
		margin?: Partial<Margin>;
		clipPadding?: number;
		/**
		 * The x domain follows an IntervalX brush (a linked detail chart) on an
		 * axis with the same label, else the same column, of the same scale type,
		 * whatever either chart's `xScale`. Interval2D and ParallelBrushes only
		 * filter: they can't be followed. Fixed at mount.
		 */
		useXSelection?: boolean;
		/** As `useXSelection`, for y: follows an IntervalY brush. Fixed at mount. */
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
		xScale = undefined,
		yScale = undefined,
		fx = null,
		fxDomain = null,
		columns: facetColumns = null,
		children = undefined,
		background: removedBackground,
		canvas: removedCanvas,
		foreground: removedForeground,
		interactors: removedInteractors,
		overlay: removedOverlay,
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

	// The chart snippets removed in 0.3.0. Svelte ignores an unknown prop, so a
	// chart upgraded as is would render blank with nothing said: say it, once.
	{
		const removed = Object.entries({
			background: removedBackground,
			canvas: removedCanvas,
			foreground: removedForeground,
			interactors: removedInteractors,
			overlay: removedOverlay
		})
			.filter(([, v]) => v !== undefined)
			.map(([k]) => k);
		const verb =
			removed.length > 1
				? 'props were removed in 0.3.0 and draw'
				: 'prop was removed in 0.3.0 and draws';
		if (removed.length > 0)
			console.warn(
				`fjader: <ChartContainer>'s ${removed.map((k) => `\`${k}\``).join(', ')} snippet ` +
					`${verb} ` +
					'nothing: place the components directly inside the chart, as its children ' +
					'(a canvas snippet: the contents of its canvasComponents).'
			);
	}

	const defaultMargin = { top: 30, right: 50, bottom: 35, left: 75 };
	const baseMargin = { ...defaultMargin, ...marginOverride };

	// The chart's declarations (axes, parallel axes, the plot border), read by
	// every cell (charts/declarations).
	const declarationRegistry = new DeclarationRegistry();
	setContext(DECLARATION_REGISTRY, declarationRegistry);

	/**
	 * The cells' margins. A facet grid whose y axis puts its title on top needs
	 * two rows above each plot: the cell's facet label, at the top of the cell,
	 * and the title, just above the plot. Both sit in the top margin, so it
	 * grows by the label's height, unless `margin.top` was given.
	 */
	const cellMargin = $derived(
		fx && marginOverride.top === undefined && hasTopYTitle(declarationRegistry.axes)
			? { ...baseMargin, top: baseMargin.top + FACET_LABEL_HEIGHT }
			: baseMargin
	);

	// Layout — used for chartId (stable UUID) and legend positioning
	const layout = new ChartLayout({
		margin: baseMargin,
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
	// Counts scale id swaps on the chart (a relabel): see ScaleGeneration.
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

	// What the chart's marks contributed, by mark id: the chart owns it because
	// it outlives the lifecycles a mark rebuilds (see MarkContributions).
	const markContributions = new MarkContributions();

	/**
	 * Register a mark's scale requirement, or queue it until ChartScales exists.
	 * The one entry point for every context a mark can get (this container's,
	 * the cells'): a mark that registers from its constructor mounts before the
	 * scales are created, and a dropped registration leaves its chart with no
	 * scales at all.
	 */
	const registerScaleType: ChartContext['registerScaleType'] = (
		dimension,
		type,
		priority,
		markId,
		config,
		columnName
	) => {
		// A lifecycle's registration landing after its mark left.
		if (markContributions.departed(markId)) return;
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
	};
	/** Unregister, or drop the queued registration of a mark gone before the scales came. */
	const unregisterScaleType: ChartContext['unregisterScaleType'] = (dimension, markId) => {
		if (scales) scales.unregisterScaleType(dimension, markId);
		else
			pendingScaleRegistrations = pendingScaleRegistrations.filter(
				(r) => r.dimension !== dimension || r.markId !== markId
			);
	};
	/** A parallel mark's columns; refused for a mark that has left. */
	const setParallelColumns: ChartContext['setParallelColumns'] = (markId, columns) => {
		if (markContributions.departed(markId)) return;
		scales?.setParallelColumns(markId, columns);
	};
	const placeExtent: ChartContext['placeExtent'] = (markId, axis, state) =>
		markContributions.place(markId, axis, state);
	const placeColumnExtent: ChartContext['placeColumnExtent'] = (markId, column, state) =>
		markContributions.placeColumn(markId, column, state);
	/**
	 * A mark leaves the chart (its unmount): its extents, scale-type
	 * requirements, parallel columns and entrance hold go, and its later writes
	 * are refused. Not on a lifecycle rebuild, whose successor holds the same id
	 * and takes them over. A mark whose table is unset while it stays mounted
	 * keeps its contributions until it unmounts.
	 */
	const unregisterMark: ChartContext['unregisterMark'] = (markId) => {
		markContributions.release(markId);
		unregisterScaleType('x', markId);
		unregisterScaleType('y', markId);
		scales?.setParallelColumns(markId, []);
		chartConfig.unregisterMark(markId);
	};

	// The chart's scales, built once. The props reach them as getters, which
	// ChartScales' own effect tracks: a changed label re-keys the axis scale in
	// place (#resolveScaleInstances). Read here, they would rebuild the scales
	// from empty, and until every mark registered again the chart would resolve
	// to (linear, linear): its renderers recompiled for that, and a legend lost
	// its color use.
	$effect(() => {
		const newScales = new ChartScales({
			get xLabel() {
				return xLabel;
			},
			get yLabel() {
				return yLabel;
			},
			get xScale() {
				return xScale;
			},
			get yScale() {
				return yScale;
			},
			layout,
			gpuCoordinator,
			scaleRegistry: scaleRegistry,
			getFacetChartIds: () => facetChartIds,
			get xZoomLimit() {
				return xZoomLimit;
			},
			get yZoomLimit() {
				return yZoomLimit;
			},
			get xPanLimit() {
				return xPanLimit;
			},
			get yPanLimit() {
				return yPanLimit;
			},
			get xDisableZoom() {
				return xDisableZoom;
			},
			get yDisableZoom() {
				return yDisableZoom;
			},
			// Fixed when the chart mounts: ChartScales sets up the selection link in
			// its constructor, so a getter would subscribe this effect and a toggle
			// would rebuild the scales from empty.
			useXSelection: untrack(() => useXSelection),
			useYSelection: untrack(() => useYSelection),
			entranceGate: chartConfig.entrance
		});

		// Replay any scale registrations that were queued before scales existed.
		// Untracked: they run inside the effect that creates the scales, and
		// whatever a registration reads must not become a reason to rebuild the
		// chart's scales from empty.
		untrack(() => {
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
		});
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
		get xTitle() {
			return scales?.xTitle ?? null;
		},
		get yTitle() {
			return scales?.yTitle ?? null;
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

		registerScaleType,
		unregisterScaleType,
		placeExtent,
		placeColumnExtent,
		unregisterMark,

		// Not queued, unlike registerScaleType: a facet pass-through mark that sets
		// columns before the scales exist loses them (no page facets parallel coordinates).
		setParallelColumns,
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
	// The legends declared in the chart, by where it places them.
	const topLegends = $derived(declarationRegistry.legends('top'));
	const rightLegends = $derived(declarationRegistry.legends('right'));
	// What a declaration may read of the chart: what every cell shares.
	const declarationChart: DeclarationChart = {
		chartId: layout.chartId,
		config: chartConfig,
		get xScaleState() {
			return scales?.xScaleState;
		},
		get yScaleState() {
			return scales?.yScaleState;
		},
		get xColumnName() {
			return scales?.xColumnName ?? null;
		},
		get yColumnName() {
			return scales?.yColumnName ?? null;
		},
		get xLabel() {
			return scales?.xLabel;
		},
		get yLabel() {
			return scales?.yLabel;
		},
		get parallelScales() {
			return scales?.parallelScales ?? null;
		},
		registerBrushTarget: (axis) => scales?.registerBrushTarget(axis),
		get colorScales() {
			return scaleRegistry.colorScalesOf(layout.chartId);
		}
	};
	setContext(DECLARATION_CHART, declarationChart);
	// The chart's text atlas: its strings and slots, painted by each of its
	// canvases (one, or a facet grid's cells), so text layers in a facet grid's
	// pass-through canvas (<Labels>, TextMark) draw in every cell.
	setContext(CHART_TEXT_ATLAS, new TextAtlas());

	// The chart's canvas, with its children as its components: the unfaceted
	// cell renders it, or a facet grid renders it once, in the hidden marks
	// container (the pass-through), whose marks every cell's canvas draws.
</script>

{#snippet chartCanvas()}
	<WebGPUCanvas components={children} />
{/snippet}

<div class="figure-container" bind:clientWidth={layout.width} data-fjader-tooltip={tooltipScheme}>
	{#if topLegends.length > 0}
		<div
			class="legend-container legend-top"
			style:padding-left="{cellMargin.left}px"
			style:padding-right="{cellMargin.right}px"
		>
			{#each topLegends as declared (declared)}
				{@render declared.snippet()}
			{/each}
		</div>
	{/if}

	{#if fx}
		<!-- Faceted mode -->
		<div class="facet-marks-container">
			{@render chartCanvas()}
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
						{registerScaleType}
						{unregisterScaleType}
						{placeExtent}
						{placeColumnExtent}
						{unregisterMark}
						{setParallelColumns}
						{scaleGeneration}
						{chartVisibility}
						{chartHover}
						{chartConfig}
						{facetingProps}
						{gpuCoordinator}
						{wheelInteraction}
						canvas={null}
					/>
				{/each}
			</div>
		{:else}
			<div class="facet-loading">Discovering facet categories...</div>
		{/if}
	{:else if scales}
		<!-- Normal (non-faceted) mode. Once the chart's scales exist (the effect
		     above, right after the first render): the cell's marks mount without
		     waiting for WebGPU, and everything they hand the chart's scales
		     (requirements, parallel columns) needs them there. Replaced, never
		     unset, so this does not remount the cell. -->
		<ChartCell
			cellChartId={layout.chartId}
			margin={cellMargin}
			{clipPadding}
			{scales}
			{registerScaleType}
			{unregisterScaleType}
			{placeExtent}
			{placeColumnExtent}
			{unregisterMark}
			{setParallelColumns}
			{scaleGeneration}
			{chartVisibility}
			{chartHover}
			{chartConfig}
			{facetingProps}
			{gpuCoordinator}
			{wheelInteraction}
			canvas={chartCanvas}
		/>
	{/if}

	{#if rightLegends.length > 0}
		<div
			class="legend-container legend-right"
			style:top="{cellMargin.top}px"
			style:left="{cellMargin.left + layout.innerWidth + 8}px"
		>
			{#each rightLegends as declared (declared)}
				{@render declared.snippet()}
			{/each}
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
