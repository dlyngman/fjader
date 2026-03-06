// src/lib/components/marks/MarkLifecycle.svelte.ts

import { untrack } from 'svelte';
import { DataClient } from '$lib/data-clients/DataClient.svelte';
import type {
	DataClientConfig,
	DataClientOptions
} from '$lib/data-clients/DataClient.svelte';
import { Query, isNode, sql } from '@uwdata/mosaic-sql';
import type { ExprValue, FilterExpr } from '@uwdata/mosaic-sql';
import type { Selection, Coordinator, FieldInfoRequest } from '@uwdata/mosaic-core';
import type { ScaleRequirement } from '$lib/scales/ScalePriorities';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { ArrowDataAccessor } from '$lib/data/DataAccessor';
import type { DataAccessor } from '$lib/data/DataAccessor';
import { viewManager } from '$lib/data/ViewManager.svelte';
import { tableSchemaService } from '$lib/data/TableSchemaService.svelte';
import type {
	FieldRef,
	NormalizedSortConfig,
	Transform,
	ChartContext,
	ScaleStateInstance,
	ContinuousScaleState,
	MosaicClient
} from '$lib/types';
import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import type { TimeScaleState } from '$lib/scales/TimeScaleState.svelte';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
import type { SizeScaleState } from '$lib/scales/SizeScaleState.svelte';
import { type AutoBinNode, isBinExpression } from '$lib/sql/bin';
import { isContinuousScale } from '$lib/scales/scale-categories';
import { generateMarkId, buildChannelFieldMap } from '../utils';
import { isWindowExpression } from '$lib/sql/expression-utils';
import {
	computeExtentFromData,
	detectChannelsNeedingDataDomain,
	type ExtentFilterOptions
} from './domain-computation';
import {
	buildFieldInfoRequests,
	buildQueryParts,
	assembleQuery,
	type QueryParts
} from './query-builder';
import {
	setScalesReady,
	markDeferredScalesReady,
	setInitialContinuousDomains,
	registerDataDerivedDomains
} from './domain-registration';
import { fetchCategoricalDomains, fetchGlobalAggregates } from './domain-queries';

// ---------------------------------------------------------------------------
// LIFECYCLE: 10-Effect State Machine
//
//  constructor
//    ├─ detectChannelsNeedingDataDomain()       [domain-computation.ts]
//    └─ registerScaleRequirements()             → #scaleRequirementsRegistered
//
//  Effect 1:  scaleRequirementsRegistered        → #scaleStatesReady
//  Effect 2:  scaleStatesReady                   → #scaleMappingsReady
//  Effect 3:  scaleMappingsReady                 → categoricalDataFetched  [async]
//             Calls: fetchCategoricalDomains()     [domain-queries.ts]
//                    fetchGlobalAggregates()       [domain-queries.ts]
//                    setScalesReady()              [domain-registration.ts]
//  Effect 4:  categoricalDataFetched + view      → #clientCreated
//             Calls: buildFieldInfoRequests()      [query-builder.ts]
//  Effect 5:  clientCreated + fieldInfo           → #continuousDomainsSet
//             Calls: setInitialContinuousDomains() [domain-registration.ts]
//  Effect 6:  client.dataVersion + data          → #dataDerivedDomainsSet
//             Calls: registerDataDerivedDomains()  [domain-registration.ts]
//  Effect 7:  dataDerivedDomainsSet              → scales.setReady()
//             Calls: markDeferredScalesReady()     [domain-registration.ts]
//  Effect 8:  domain.target + autoBins           → re-bin cycle (→ Effect 6)
//  Effect 9:  client.dataVersion                 → tooltip table [side effect]
//  Effect 10: domain.target + data               → viewport-local domain
//
//  gpuReady = scalesReady && categoricalDataFetched && xReady && yReady
//
//  Extracted modules:
//    domain-computation.ts   — pure extent/category/channel detection
//    query-builder.ts        — SQL query construction
//    domain-registration.ts  — scale domain registration
//    domain-queries.ts       — async coordinator queries
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Local interfaces
// ---------------------------------------------------------------------------

interface ConnectedConfig {
	seriesChannel: string | null;
	dimensionChannel: string;
}

export interface MarkLifecycleConfig {
	markType: string;
	supportedScaleTypes: { x: string[]; y: string[] };
	scaleRequirements: {
		x: ScaleRequirement | null;
		y: ScaleRequirement | null;
	};
	inferredScaleColumns?: { x?: FieldRef; y?: FieldRef };
	table: string;
	selection?: Selection;
	transforms: Transform[];
	select: Record<string, unknown>;
	clientOptions?: { limit?: number; filterNulls?: unknown[] | null };
	sort?: NormalizedSortConfig;
	tooltip?: boolean | { sortTable?: boolean };
	constants?: Record<string, number>;
	colorChannel?: string; // Key in select for color data ('fill' or 'stroke')
	sizeChannel?: string; // Key in select for size data ('r')
	_connectedConfig?: ConnectedConfig;
	_filterNulls?: unknown[];
	viewportLocalDomain?: boolean;
	zeroBaseline?: { x?: boolean; y?: boolean };
}

export class MarkLifecycle {
	// --- Reactive State ---
	client = $state<DataClient | null>(null);
	categoricalDataFetched = $state(false);

	// --- Setup Progress ---
	#scaleRequirementsRegistered = $state(false);
	#scaleStatesReady = $state(false);
	#scaleMappingsReady = $state(false);
	#clientCreated = $state(false);
	#continuousDomainsSet = $state(false);
	#categoricalFetchStarted = $state(false);
	#colorDomainFetched = $state(false);

	// --- Private Properties ---
	#config: MarkLifecycleConfig;
	#coordinator: Coordinator;
	#chartContext: ChartContext;
	#markId: string;
	#scaleMap: Record<string, ScaleStateInstance | null> = {};
	#colorScaleState = $state<ColorScaleState | null>(null);
	#seriesScaleState = $state<ColorScaleState | null>(null);
	#sizeScaleState = $state<SizeScaleState | null>(null);
	#currentClientTable = $state<string | null>(null);

	// --- Transform Support ---
	#transformCompiler: TransformCompiler;
	#autoBinNodes: Map<string, AutoBinNode> = new Map();

	// --- Tooltip Write-Back ---
	#tooltipWanted: boolean;
	#tooltipTableReady = $state(false);
	#tooltipSortTable: boolean;
	#tooltipTableName: string;
	#tooltipWriteTimeout: ReturnType<typeof setTimeout> | null = null;

	// --- Adaptive Binning Support ---
	#lastBinningDomain: { x: number[] | null; y: number[] | null } = { x: null, y: null };
	#rebinTimeout: ReturnType<typeof setTimeout> | null = null;
	#binningThreshold: number = 1.25;
	#skipDomainUpdateForAxis: string | null = null;
	#rebinPendingDataVersion: number | null = null;
	#prevBinMultiplier: number = 1.0;

	// --- Query Build Cache ---
	// Caches all filter-independent query state (resolved select, classification,
	// transforms, ordering) so repeated buildQuery calls during interaction
	// only apply the WHERE clause. Invalidated on re-bin or multiplier change.
	#cachedQueryParts: QueryParts | null = null;

	// --- Viewport-Local Domain Support ---
	#viewportDomainUpdateTimeout: ReturnType<typeof setTimeout> | null = null;

	// --- Data-Derived Domain Support ---
	#channelsNeedingDataDomain: Set<string> = new Set();
	#dataDerivedDomainsSet = $state(false);
	#globalAggregatesSet = $state(false);
	#lastBandDomainDataVersion: number | null = null;

	// --- Client Registration ---
	#unregisterClient: (() => void) | null = null;

	/**
	 * Ensure shared services (ViewManager, TableSchemaService) have the coordinator.
	 * Call this before inference so schema lookups can proceed.
	 * Idempotent — safe to call multiple times.
	 */
	static ensureServices(coordinator: Coordinator): void {
		if (coordinator) {
			viewManager.setCoordinator(coordinator);
			tableSchemaService.setCoordinator(coordinator);
		}
	}

	constructor(
		config: MarkLifecycleConfig,
		coordinator: Coordinator,
		chartContext: ChartContext,
		stableId: string | null = null
	) {
		console.log('🔧 MarkLifecycle constructor:', {
			markType: config.markType,
			transforms: config.transforms,
			transformCount: config.transforms?.length || 0
		});

		this.#config = config;
		this.#coordinator = coordinator;
		this.#chartContext = chartContext;
		this.#markId = stableId || generateMarkId(config.markType);

		// Tooltip write-back
		this.#tooltipWanted = config.tooltip !== false;
		this.#tooltipSortTable =
			typeof config.tooltip === 'object' ? config.tooltip.sortTable !== false : true;
		this.#tooltipTableName = `_tt_${this.#markId.replace(/-/g, '_')}`;

		// Ensure services have coordinator (idempotent)
		MarkLifecycle.ensureServices(coordinator);

		// NEW: Create transform compiler
		this.#transformCompiler = new TransformCompiler(config.transforms || []);

		console.log('🔧 TransformCompiler created:', {
			sqlTransforms: this.#transformCompiler.sqlTransforms.length,
			jsTransforms: this.#transformCompiler.jsTransforms.length
		});

		// NEW: Detect auto bins in select
		this.#detectAutoBins();

		// Detect which channels need data-derived domains (aggregates)
		this.#channelsNeedingDataDomain = detectChannelsNeedingDataDomain(
			config.select,
			config.scaleRequirements,
			this.#transformCompiler
		);
		if (this.#channelsNeedingDataDomain.size > 0) {
			console.log(
				`🔧 ${this.#markId} channels needing data-derived domain:`,
				Array.from(this.#channelsNeedingDataDomain)
			);
		}

		this.#registerScaleRequirements();
		this.#setupReactiveEffects();
	}

	// NEW: Detect AutoBinNodes in config
	#detectAutoBins(): void {
		for (const [channel, value] of Object.entries(this.#config.select)) {
			if (isBinExpression(value)) {
				this.#autoBinNodes.set(channel, value);
			}
		}
	}

	#setupReactiveEffects(): void {
		// Effect 1: Wait for scale objects
		// Gated on #scaleRequirementsRegistered — when inference is pending (null types),
		// the entire effect chain is blocked until the mark is recreated with resolved types.
		$effect(() => {
			if (!this.#scaleRequirementsRegistered) return;
			const { scaleTypes, xScaleState, yScaleState } = this.#chartContext;
			if (!!(scaleTypes && xScaleState && yScaleState) && !this.#scaleStatesReady) {
				this.#scaleStatesReady = true;
			}
		});

		// Effect 2: Setup scale mappings
		$effect(() => {
			if (this.#scaleStatesReady && !this.#scaleMappingsReady) {
				this.#setupScaleMappings();
				this.#scaleMappingsReady = true;
			}
		});

		// Effect 3: Fetch categorical domains FIRST (before client creation)
		// This populates scale domains which triggers ViewManager view creation
		// Band/time domains are fetched immediately; color/series domains are fetched
		// when their scale states become available (they may resolve asynchronously).
		$effect(() => {
			// Wait for scale mappings
			if (!this.#scaleMappingsReady) return;

			// Track color/series scale states for reactive re-entry
			const colorKey = this.#config.colorChannel || 'fill';
			const seriesKey = this.#config._connectedConfig?.seriesChannel;
			const colorReady = !this.#config.select?.[colorKey] || !!this.#colorScaleState;
			const seriesReady =
				!seriesKey || !this.#config.select?.[seriesKey] || !!this.#seriesScaleState;

			if (!this.#categoricalFetchStarted || (colorReady && !this.#colorDomainFetched)) {
				this.#categoricalFetchStarted = true;

				// Fetch both categorical and aggregated domains in parallel
				const seriesKey2 = this.#config._connectedConfig?.seriesChannel ?? null;
				const catPromise = fetchCategoricalDomains(
					this.#coordinator!,
					this.#config.table,
					this.#config.select,
					this.#config.sort,
					this.actualXScaleType,
					this.actualYScaleType,
					this.#chartContext.xScaleState as BandScaleState | null,
					this.#chartContext.yScaleState as BandScaleState | null,
					this.#chartContext.facetBandScale,
					this.#chartContext.fx,
					this.#config.colorChannel || 'fill',
					this.#colorScaleState,
					this.#config.sizeChannel || 'r',
					this.#sizeScaleState,
					this.#seriesScaleState,
					seriesKey2,
					this.#transformCompiler.hasCategoryReducingTransforms(),
					this.#markId
				);
				const aggPromise = fetchGlobalAggregates(
					this.#coordinator!,
					this.#config.table,
					this.#config.select,
					this.#channelsNeedingDataDomain,
					this.#autoBinNodes.size,
					this.buildQuery.bind(this),
					this.#config as unknown as DataClientConfig,
					this.#chartContext.xScaleState as ContinuousScaleState | null,
					this.#chartContext.yScaleState as ContinuousScaleState | null,
					this.#colorScaleState,
					this.#markId
				);
				Promise.all([catPromise, aggPromise])
					.then(([fetchCount, aggResult]) => {
						this.categoricalDataFetched = true;
						if (colorReady) this.#colorDomainFetched = true;
						if (aggResult.globalAggregatesSet) this.#globalAggregatesSet = true;
						setScalesReady(
							this.#scaleMap,
							this.#channelsNeedingDataDomain,
							this.actualXScaleType,
							this.actualYScaleType,
							this.#globalAggregatesSet,
							this.#dataDerivedDomainsSet
						);
						if (fetchCount > 0) {
							console.log(`✅ Mark ${this.#markId} scale domains ready (${fetchCount} fetches)`);
						}
					})
					.catch((error) => {
						console.error(`❌ Domain fetch failed for ${this.#markId}:`, error);
					});
			}
		});

		// Effect 4: Create client - waits for view to be ready before creating
		// This prevents creating a throwaway client against the source table
		$effect(() => {
			// Prerequisites
			if (!this.categoricalDataFetched) return;

			// Wait until ViewManager is ready (no pending view creation)
			if (!viewManager.isReadyForClient(this.#config.table)) {
				console.log(`[Mark ${this.#markId}] Waiting for view to be ready...`);
				return;
			}

			// REACTIVITY: Track effectiveTable
			const tableToQuery = this.effectiveTable;

			// Check if table changed (using tracked state)
			if (this.#currentClientTable !== tableToQuery) {
				// Action (untracked to prevent loops)
				untrack(() => {
					if (this.client) {
						console.log(
							`[Mark ${this.#markId}] Switching source: ${this.#currentClientTable} → ${tableToQuery}`
						);
						this.client.destroy();
						this.client = null;
					}

					const fieldRequests = buildFieldInfoRequests(this.#config.select, tableToQuery, this.actualXScaleType, this.actualYScaleType);
					console.log(`[Mark ${this.#markId}] Creating DataClient for ${tableToQuery}`);
					this.#createClient(tableToQuery, fieldRequests);
					this.#currentClientTable = tableToQuery;
					this.#clientCreated = true;
				});
			}
		});

		// Effect 5: Set initial continuous domains when fieldInfo arrives (merged 5+6)
		$effect(() => {
			if (this.#clientCreated && this.client?.fieldInfo && !this.#continuousDomainsSet) {
				setInitialContinuousDomains(
					this.client.fieldInfo,
					this.#scaleMap,
					this.#config.select,
					this.actualXScaleType,
					this.actualYScaleType,
					this.#markId
				);
				this.#continuousDomainsSet = true;
			}
		});

		// Effect 6: Register data-derived domains when data arrives
		// This handles aggregates and transforms that need domain computed from query results
		$effect(() => {
			// Watch dataVersion to ensure we only process NEW data
			const dataVersion = this.client?.dataVersion;
			if (dataVersion === undefined) return;

			const data = this.data;
			if (!data || data.length === 0) return;
			if (this.#dataDerivedDomainsSet) {
				// For topN marks, re-derive band domain when new data arrives (selection change).
				// dataVersion only increments on DB query results, not on scale mutations,
				// so this naturally breaks the effect→domain→effect loop.
				if (
					this.#transformCompiler.hasCategoryReducingTransforms() &&
					dataVersion !== this.#lastBandDomainDataVersion
				) {
					this.#lastBandDomainDataVersion = dataVersion;
				} else {
					return;
				}
			}

			// If we're waiting for new data from a re-bin, skip until dataVersion increments
			if (this.#rebinPendingDataVersion !== null && dataVersion <= this.#rebinPendingDataVersion) {
				console.log(
					`⏳ [${this.#markId}] Waiting for new data (current: ${dataVersion}, pending: ${this.#rebinPendingDataVersion})`
				);
				return;
			}

			// Check if this is a rebinning update before clearing the flag
			const isRebinning = this.#rebinPendingDataVersion !== null;

			// Clear pending state - we have new data
			this.#rebinPendingDataVersion = null;

			// Get additional channels from transforms (if any)
			const additionalChannels = this.#transformCompiler.getAdditionalChannels();
			const xState = this.#chartContext.xScaleState as ContinuousScaleState | null;
			const yState = this.#chartContext.yScaleState as ContinuousScaleState | null;
			const result = registerDataDerivedDomains(
				data,
				this.#channelsNeedingDataDomain,
				additionalChannels,
				this.#skipDomainUpdateForAxis,
				this.#config.viewportLocalDomain,
				this.#config.zeroBaseline,
				this.actualXScaleType,
				this.actualYScaleType,
				xState,
				yState,
				(xState as ContinuousScaleState | null)?.hasDomain ?? false,
				(yState as ContinuousScaleState | null)?.hasDomain ?? false,
				this.#transformCompiler.hasCategoryReducingTransforms(),
				this.#chartContext.xScaleState as BandScaleState | null,
				this.#chartContext.yScaleState as BandScaleState | null,
				this.#markId,
				isRebinning
			);
			this.#dataDerivedDomainsSet = result.dataDerivedDomainsSet;
			this.#skipDomainUpdateForAxis = result.skipDomainUpdateForAxis;
		});

		// Effect 7: Mark deferred scales ready when data-derived domains are set
		// This handles linear scales with aggregates/transforms that couldn't be marked
		// ready in setScalesReady() because their domain wasn't known yet
		$effect(() => {
			if (this.#dataDerivedDomainsSet && this.#scaleMappingsReady) {
				markDeferredScalesReady(
					this.#scaleMap,
					this.#channelsNeedingDataDomain,
					this.actualXScaleType,
					this.actualYScaleType
				);
			}
		});

		// Effect 8: Adaptive Binning & User Resolution Control
		$effect(() => {
			// IMPORTANT: Read reactive values FIRST to establish dependencies
			// Even if we early-return, Svelte needs to track these for reactivity
			const multiplier: number = this.#chartContext.binStepMultiplier ?? 1.0;
			const xState = this.#chartContext.xScaleState;
			const yState = this.#chartContext.yScaleState;
			const xDomain: number[] | undefined =
				xState && xState.scaleType !== 'band' ? xState.domain?.target : undefined;
			const yDomain: number[] | undefined =
				yState && yState.scaleType !== 'band' ? yState.domain?.target : undefined;

			if (this.#autoBinNodes.size === 0 || !this.client) {
				// Early return, but reactive values were already read above
				return;
			}

			// --- A. User Resolution Control (Shift+Scroll) ---
			if (this.#prevBinMultiplier === undefined) {
				this.#prevBinMultiplier = multiplier;
			}

			if (multiplier !== this.#prevBinMultiplier) {
				console.log(
					`🎛️ [${this.#markId}] Re-binning: Multiplier ${this.#prevBinMultiplier.toFixed(1)}x → ${multiplier.toFixed(1)}x`
				);
				this.#prevBinMultiplier = multiplier;

				// Determine which axis has bins (should preserve user zoom on that axis)
				const xHasBin = this.#autoBinNodes.has('x1') || this.#autoBinNodes.has('x2');
				const yHasBin = this.#autoBinNodes.has('y1') || this.#autoBinNodes.has('y2');

				// Skip domain update for binned axis (user zoomed there intentionally)
				// But DO update the aggregate axis domain (counts changed)
				if (xHasBin) this.#skipDomainUpdateForAxis = 'x';
				if (yHasBin) this.#skipDomainUpdateForAxis = 'y';

				// Track current dataVersion - we'll wait for it to increment before updating domains
				this.#rebinPendingDataVersion = this.client?.dataVersion ?? null;

				// Reset data-derived domain flag so aggregate extent updates from new data
				this.#dataDerivedDomainsSet = false;

				// Invalidate resolved select cache so next buildQuery re-resolves bins
				this.#cachedQueryParts = null;

				// Immediate update. Since this changes the query definition via
				// resolveAutoBins -> buildQuery, requestUpdate will re-run the pipeline.
				this.client.requestUpdate();

				// Return early - skip adaptive check this frame
				return;
			}

			// --- B. Adaptive Binning (Viewport changes) ---
			const xHasBin = this.#autoBinNodes.has('x1') || this.#autoBinNodes.has('x2');
			if (xHasBin && xDomain && this.#shouldReBin(xDomain, 'x')) {
				this.#scheduleReBin('x', xDomain);
			}

			const yHasBin = this.#autoBinNodes.has('y1') || this.#autoBinNodes.has('y2');
			if (yHasBin && yDomain && this.#shouldReBin(yDomain, 'y')) {
				this.#scheduleReBin('y', yDomain);
			}
		});

		// Effect 9: Write tooltip table when data updates (debounced).
		// Trigger on dataVersion (increments only on DB query results) rather than
		// this.data directly — the data derivation recomputes on every scale change
		// (xScale/yScale) which would reset the debounce timer indefinitely.
		$effect(() => {
			if (!this.#tooltipWanted) return;
			const dataVersion = this.client?.dataVersion;
			if (dataVersion === undefined) return;

			untrack(() => {
				clearTimeout(this.#tooltipWriteTimeout!);
				this.#tooltipWriteTimeout = setTimeout(() => {
					const data = this.data;
					if (data && data.length > 0) this.#writeTooltipTable(data);
				}, 300);
			});
		});

		// Effect 10: Viewport-local domain - update aggregate axis when viewport pans
		$effect(() => {
			if (!this.#config.viewportLocalDomain) return;
			if (!this.data || !this.#dataDerivedDomainsSet) return;

			// Determine which axis has bins (vs aggregates)
			const xHasBins = this.#autoBinNodes.has('x1') || this.#autoBinNodes.has('x2');
			const yHasBins = this.#autoBinNodes.has('y1') || this.#autoBinNodes.has('y2');

			// For RectYMark: X has bins, Y has aggregate → watch X TARGET, update Y
			if (xHasBins && !yHasBins) {
				const xSS = this.#chartContext.xScaleState;
				const xDomain = xSS && xSS.scaleType !== 'band' ? xSS.domain?.target : undefined;
				if (xDomain && this.actualXScaleType !== 'band') {
					// Skip viewport update if we're about to re-bin anyway
					if (this.#shouldReBin(xDomain, 'x')) {
						return; // Re-binning will update Y with new data
					}
					this.#updateViewportLocalDomain('y', xDomain);
				}
			}

			// For RectXMark: Y has bins, X has aggregate → watch Y TARGET, update X
			if (yHasBins && !xHasBins) {
				const ySS = this.#chartContext.yScaleState;
				const yDomain = ySS && ySS.scaleType !== 'band' ? ySS.domain?.target : undefined;
				if (yDomain && this.actualYScaleType !== 'band') {
					// Skip viewport update if we're about to re-bin anyway
					if (this.#shouldReBin(yDomain, 'y')) {
						return; // Re-binning will update X with new data
					}
					this.#updateViewportLocalDomain('x', yDomain);
				}
			}
		});
	}

	#registerScaleRequirements(): void {
		const { scaleRequirements, inferredScaleColumns } = this.#config;
		const hasCatReducing = this.#transformCompiler.hasCategoryReducingTransforms();

		const table = this.#config.table;
		if (scaleRequirements?.x) {
			let config = scaleRequirements.x.config || {};
			if (scaleRequirements.x.type === 'band' && hasCatReducing) {
				const key = this.#transformCompiler.getCategoryTransformKey();
				if (key) config = { ...config, transformKey: `${table}:${key}` };
			}
			this.#chartContext.registerScaleType(
				'x',
				scaleRequirements.x.type,
				scaleRequirements.x.priority,
				this.#markId,
				config,
				inferredScaleColumns?.x
			);
		}

		if (scaleRequirements?.y) {
			let config = scaleRequirements.y.config || {};
			if (scaleRequirements.y.type === 'band' && hasCatReducing) {
				const key = this.#transformCompiler.getCategoryTransformKey();
				if (key) config = { ...config, transformKey: `${table}:${key}` };
			}
			this.#chartContext.registerScaleType(
				'y',
				scaleRequirements.y.type,
				scaleRequirements.y.priority,
				this.#markId,
				config,
				inferredScaleColumns?.y
			);
		}

		// Gate: both axes must have resolved types before the effect chain proceeds.
		// When inference is pending (null scaleRequirements), this stays false,
		// preventing premature DataClient creation and domain queries.
		this.#scaleRequirementsRegistered = !!(
			scaleRequirements?.x?.type && scaleRequirements?.y?.type
		);
	}

	get actualXScaleType(): string {
		return this.#chartContext.scaleTypes?.x || 'linear';
	}

	get actualYScaleType(): string {
		return this.#chartContext.scaleTypes?.y || 'linear';
	}

	get hasCategoryReducingTransforms(): boolean {
		return this.#transformCompiler.hasCategoryReducingTransforms();
	}

	get markId(): string {
		return this.#markId;
	}

	/**
	 * Reactive effective table name.
	 * Automatically updates when ViewManager creates the derived view.
	 */
	effectiveTable: string = $derived.by(() =>
		viewManager.getEffectiveTable(this.#config?.table ?? '')
	);

	/**
	 * Get the source table name (without ViewManager transformation).
	 */
	get sourceTable(): string {
		return this.#config.table;
	}

	/**
	 * Set the color scale state for ViewManager integration.
	 * Must be called before categorical domain fetch completes.
	 */
	setColorScale(colorScaleState: ColorScaleState): void {
		this.#colorScaleState = colorScaleState;
		// Register table with color scale
		if (colorScaleState && this.#config.table) {
			colorScaleState.registerTable(this.#config.table);
		}
	}

	/**
	 * Register a series scale for connected topology marks (Lines, Areas).
	 * Enables domain discovery for the stroke/series field.
	 */
	setSeriesScale(seriesScaleState: ColorScaleState): void {
		this.#seriesScaleState = seriesScaleState;
		if (seriesScaleState && this.#config.table) {
			seriesScaleState.registerTable(this.#config.table);
		}
	}

	/**
	 * Set the size scale state for radius domain discovery.
	 */
	setSizeScale(sizeScaleState: SizeScaleState): void {
		this.#sizeScaleState = sizeScaleState;
	}

	scaleCompatibilityError: string | null = $derived.by(() => {
		const { supportedScaleTypes, markType } = this.#config;
		if (!this.actualXScaleType || !this.actualYScaleType) return null;

		const incompatibleX = !supportedScaleTypes.x.includes(this.actualXScaleType);
		const incompatibleY = !supportedScaleTypes.y.includes(this.actualYScaleType);

		if (incompatibleX)
			return `${markType} cannot use scale type '${this.actualXScaleType}' for the x-axis.`;
		if (incompatibleY)
			return `${markType} cannot use scale type '${this.actualYScaleType}' for the y-axis.`;

		return null;
	});

	gpuReady: boolean = $derived.by(() => {
		if (!this.#chartContext.scalesReady || !this.categoricalDataFetched) return false;

		const xSS = this.#chartContext.xScaleState;
		const xReady =
			this.actualXScaleType === 'band' || this.actualXScaleType === 'point'
				? (xSS as BandScaleState | null | undefined)?.isReadyForGPU
				: xSS?.ready;

		const ySS = this.#chartContext.yScaleState;
		const yReady =
			this.actualYScaleType === 'band' || this.actualYScaleType === 'point'
				? (ySS as BandScaleState | null | undefined)?.isReadyForGPU
				: ySS?.ready;

		return xReady && yReady;
	});

	// Processed data with JS transforms applied
	data: DataAccessor | null = $derived.by(() => {
		if (!this.client?.arrowTable) return null;

		let accessor: DataAccessor = new ArrowDataAccessor(
			this.client.arrowTable,
			this.#cachedQueryParts?.aliasMap
		);

		// Fast path: No JS transforms - return Arrow accessor (zero-copy)
		if (!this.#transformCompiler.hasJSTransforms()) {
			return accessor;
		}

		// Inject constant channel values as overlays (numeric values excluded from SQL)
		const constants = this.#config.constants;
		if (constants) {
			const overlays: Record<string, Float32Array> = {};
			for (const key in constants) {
				if (accessor.getColumn(key) === null) {
					const arr = new Float32Array(accessor.length);
					arr.fill(constants[key]);
					overlays[key] = arr;
				}
			}
			if (Object.keys(overlays).length > 0) {
				accessor = accessor.withOverlays(overlays);
			}
		}

		const transformConfig = {
			markType: this.#config.markType,
			table: this.#config.table,
			x: this.#getFieldName('x'),
			y: this.#getFieldName('y'),
			fill: this.#getFieldName('fill')
		};

		const result = this.#transformCompiler.applyToData(accessor, transformConfig, {
			x: this.#chartContext.xScale,
			y: this.#chartContext.yScale
		});

		return result;
	});

	/** Facet index data (Float32Array) for GPU upload. Null when not faceted. */
	facetData: Float32Array | null = $derived.by(() => {
		if (!this.#chartContext.fx || !this.data) return null;
		const raw = this.data.getColumn('__facet');
		if (!raw) return null;
		return raw instanceof Float32Array ? raw : new Float32Array(raw as ArrayLike<number>);
	});

	/**
	 * Get the COLUMN NAME (alias) for a channel.
	 * The data uses aliases as column names, not the original field expressions.
	 * For transforms, we need the alias that appears in the data.
	 */
	#getFieldName(channel: string): string {
		// First check if the channel exists directly in select
		if (this.#config.select[channel] != null) {
			// The column name in the data is the ALIAS (the key), not the value
			return channel;
		}

		// Check constants (numeric values excluded from SQL but injected into data objects)
		const constants = this.#config.constants;
		if (constants && constants[channel] != null) {
			return channel;
		}

		// Handle x1/x2 pattern for bar marks (horizontal stacking)
		if (channel === 'x') {
			// Try x2 first (the value field for horizontal bars), then x1
			if (this.#config.select.x2 != null) return 'x2';
			if (this.#config.select.x1 != null) return 'x1';
			if (constants?.x2 != null) return 'x2';
			if (constants?.x1 != null) return 'x1';
		}

		// Handle y0/y1 pattern for bar marks (vertical stacking)
		if (channel === 'y') {
			if (this.#config.select.y2 != null) return 'y2';
			if (this.#config.select.y1 != null) return 'y1';
			if (constants?.y2 != null) return 'y2';
			if (constants?.y1 != null) return 'y1';
		}

		return channel; // fallback
	}

	getSelectConfig(): Record<string, unknown> {
		// Return select with AutoBinNodes unresolved
		// They'll be resolved in buildQuery()
		// Also swap categorical fields for indexed column names if views are ready
		const select: Record<string, unknown> = { ...this.#config.select };
		const hasView = viewManager.hasView(this.#config.table);

		// For band/point scales, use the indexed column name from ViewManager
		// Skip for marks with category-reducing transforms — they query raw strings
		const skipIndexSwap = this.#transformCompiler.hasCategoryReducingTransforms();
		if ((this.actualXScaleType === 'band' || this.actualXScaleType === 'point') && !skipIndexSwap) {
			const xScale = this.#chartContext.xScaleState as BandScaleState | null | undefined;
			if (xScale?.indexColumnName && hasView) {
				const originalField = select.x;
				select.x = xScale.indexColumnName;
				console.log(`[MarkLifecycle] Swapping x: ${originalField} → ${select.x}`);
			}
		}
		if ((this.actualYScaleType === 'band' || this.actualYScaleType === 'point') && !skipIndexSwap) {
			const yScale = this.#chartContext.yScaleState as BandScaleState | null | undefined;
			if (yScale?.indexColumnName && hasView) {
				const originalField = select.y;
				select.y = yScale.indexColumnName;
				console.log(`[MarkLifecycle] Swapping y: ${originalField} → ${select.y}`);
			}
		}

		// Time scale offset wrapping is handled in buildQuery() after bin resolution.
		// Raw column strings get swapped to ViewManager offset column there.
		// Expression nodes get inline epoch offset wrapping there.

		// For ordinal color scales, use the indexed column name
		// Sequential/continuous color scales pass raw numeric values directly
		const colorKey = this.#config.colorChannel || 'fill';
		if (
			this.#colorScaleState?.isOrdinal &&
			this.#colorScaleState?.indexColumnName &&
			hasView &&
			select[colorKey]
		) {
			const originalField = select[colorKey];
			select[colorKey] = this.#colorScaleState.indexColumnName;
			console.log(`[MarkLifecycle] Swapping ${colorKey}: ${originalField} → ${select[colorKey]}`);
		}

		// For faceting, include the facet index column
		const facetBandScale = this.#chartContext.facetBandScale;
		if (facetBandScale?.indexColumnName && hasView) {
			select.__facet = facetBandScale.indexColumnName;
			console.log(`[MarkLifecycle] Adding facet column: ${select.__facet}`);
		}

		return select;
	}

	buildQuery(
		sourceTable: string,
		config: DataClientConfig,
		filter: unknown[],
		forMosaic = true
	): Query {
		// Build and cache all filter-independent query parts on first call.
		// Subsequent calls (e.g. during brush interaction) reuse the cache.
		if (!this.#cachedQueryParts) {
			let select: Record<string, unknown> = config.select;

			// Resolve auto bins if we have field info
			if (this.#autoBinNodes.size > 0 && this.client?.fieldInfo) {
				select = this.#resolveAutoBins(config.select);
			}

			// Convert temporal values to float offsets from t0.
			const hasView = viewManager.hasView(this.#config.table);
			select = this.#applyTimeOffsets(select, hasView);

			this.#cachedQueryParts = buildQueryParts(
				select,
				this.#config._connectedConfig,
				this.#transformCompiler.hasSQLTransforms()
			);
		}

		return assembleQuery(
			sourceTable,
			this.#cachedQueryParts,
			filter,
			config._filterNulls as unknown[] | null | undefined,
			this.#transformCompiler,
			forMosaic
		);
	}

	#resolveAutoBins(select: Record<string, unknown>): Record<string, unknown> {
		const resolved: Record<string, unknown> = {};

		const binStepMultiplier: number = this.#chartContext.binStepMultiplier || 1.0;

		for (const [channel, value] of Object.entries(select)) {
			if (isBinExpression(value)) {
				const autoBin = value;
				const axis = channel.startsWith('x') ? 'x' : 'y';
				const scaleType = axis === 'x' ? this.actualXScaleType : this.actualYScaleType;
				const scaleState = this.#chartContext[`${axis}ScaleState`];

				let currentDomain: [number, number] | null = null;

				// Get frozen binning domain for adaptive bin count
				if (isContinuousScale(scaleType)) {
					currentDomain = this.#lastBinningDomain[axis as 'x' | 'y'] as [number, number] | null;

					if (!currentDomain) {
						currentDomain = (scaleState as ContinuousScaleState | null | undefined)?.domain
							?.current as unknown as [number, number] | null;
						if (currentDomain) {
							this.#lastBinningDomain[axis as 'x' | 'y'] = [...currentDomain];
						}
					}
				}

				// Resolve bin to SQL expression (temporal bins return DATE/TIMESTAMP;
				// offset conversion is handled by the time-scale swap section downstream)
				resolved[channel] = autoBin.resolve(
					this.client!.fieldInfo! as Record<string, { min?: number; max?: number; type?: string }>,
					scaleType,
					null, // t0 no longer needed here — offset wrapping is centralized
					currentDomain,
					binStepMultiplier
				);
			} else {
				resolved[channel] = value;
			}
		}

		return resolved;
	}

	#applyTimeOffsets(select: Record<string, unknown>, hasView: boolean): Record<string, unknown> {
		const result: Record<string, unknown> = { ...select };

		for (const [axis, channels] of [
			['x', ['x', 'x1', 'x2']],
			['y', ['y', 'y1', 'y2']]
		] as const) {
			const scaleType = axis === 'x' ? this.actualXScaleType : this.actualYScaleType;
			if (scaleType !== 'time') continue;

			const scaleState = this.#chartContext[`${axis}ScaleState`] as
				| TimeScaleState
				| null
				| undefined;
			if (!scaleState?.t0) continue;

			const t0Epoch = Math.floor(scaleState.t0.getTime() / 1000);

			for (const ch of channels) {
				if (!(ch in result)) continue;
				const val = result[ch];
				if (typeof val === 'string' && scaleState.offsetColumnName && hasView) {
					console.log(
						`[MarkLifecycle] Swapping ${ch} (time): ${val} → ${scaleState.offsetColumnName}`
					);
					result[ch] = scaleState.offsetColumnName;
				} else if (isNode(val)) {
					console.log(`[MarkLifecycle] Wrapping ${ch} (time expr) with epoch offset`);
					result[ch] = sql`CAST((epoch(${val}) - ${t0Epoch}) AS REAL)`;
				}
			}
		}

		return result;
	}

	#createClient(tableName: string, fieldRequests: FieldInfoRequest[]): void {
		this.#cachedQueryParts = null;
		if (this.client) this.client.destroy();

		// Detect window expressions — Mosaic's preagg incorrectly walks into
		// WINDOW nodes (collectAggregates finds inner aggregate) but doesn't
		// add dimension columns to GROUP BY, causing CREATE TABLE to fail silently.
		const selectConfig = this.getSelectConfig();
		const hasWindows = Object.values(selectConfig).some((v) => isWindowExpression(v));

		this.client = new DataClient(
			tableName,
			this.#config.selection ?? null,
			{
				select: selectConfig,
				queryBuilder: (table: string, config: DataClientConfig, filter: FilterExpr) => {
					return this.buildQuery(table, config, filter as unknown as unknown[]);
				},
				dataFormat: 'arrow',
				name: this.#markId,
				filterStable: !hasWindows,
				...(this.#config.clientOptions as DataClientOptions | undefined)
			},
			fieldRequests
		);
		this.#coordinator.connect(this.client as unknown as MosaicClient);

		// Register with chart context for crossfilter
		if (this.#chartContext?.registerClient) {
			// Unregister previous client if any
			this.#unregisterClient?.();
			this.#unregisterClient = this.#chartContext.registerClient(
				this.client as unknown as MosaicClient
			);
		}
	}

	#setupScaleMappings(): void {
		this.#scaleMap = {
			x: this.#chartContext.xScaleState,
			y: this.#chartContext.yScaleState
		};

		// Register table with band/time scales for ViewManager integration
		// This must happen BEFORE categorical domain fetch so views can be created
		// Skip for marks with category-reducing transforms (topN) — they populate
		// band domain post-transform and don't need ViewManager index columns
		const table = this.#config.table;
		const skipBandView = this.#transformCompiler.hasCategoryReducingTransforms();
		if ((this.actualXScaleType === 'band' || this.actualXScaleType === 'point') && !skipBandView) {
			(this.#chartContext.xScaleState as BandScaleState | null)?.registerTable?.(table);
		}
		if ((this.actualYScaleType === 'band' || this.actualYScaleType === 'point') && !skipBandView) {
			(this.#chartContext.yScaleState as BandScaleState | null)?.registerTable?.(table);
		}
		// Only register time scale tables for view column creation when the field
		// is a raw column name (string). Expression nodes (dateMonthDay, etc.) are
		// handled inline by #applyTimeOffsets and don't need a ViewManager column.
		if (this.actualXScaleType === 'time' && typeof this.#config.select.x === 'string') {
			(this.#chartContext.xScaleState as TimeScaleState | null)?.registerTable?.(table);
		}
		if (this.actualYScaleType === 'time' && typeof this.#config.select.y === 'string') {
			(this.#chartContext.yScaleState as TimeScaleState | null)?.registerTable?.(table);
		}
		// Register table with facet band scale for ViewManager index column
		if (this.#chartContext.facetBandScale) {
			this.#chartContext.facetBandScale.registerTable(table);
		}

		console.log(`📊 ${this.#markId} Scale mappings setup:`, {
			x: this.actualXScaleType,
			y: this.actualYScaleType
		});
	}

	// ===========================================================================
	// VIEWPORT-LOCAL DOMAIN
	// ===========================================================================

	/**
	 * Update the aggregate axis domain based on current viewport.
	 * Called when panning (without re-querying data).
	 * Debounced to avoid excessive updates during active pan/zoom.
	 */
	#updateViewportLocalDomain(aggregateAxis: string, viewportDomain: number[]): void {
		clearTimeout(this.#viewportDomainUpdateTimeout!);
		this.#viewportDomainUpdateTimeout = setTimeout(() => {
			if (!this.data) return;

			const scaleType = aggregateAxis === 'x' ? this.actualXScaleType : this.actualYScaleType;
			if (
				scaleType !== 'linear' &&
				scaleType !== 'log' &&
				scaleType !== 'symlog' &&
				scaleType !== 'time'
			)
				return;

			// Determine which axis is binned (opposite of aggregate)
			const binnedAxis = aggregateAxis === 'x' ? 'y' : 'x';

			// Build channel list for aggregate axis
			const channels = aggregateAxis === 'x' ? ['x', 'x1', 'x2'] : ['y', 'y1', 'y2'];

			// Compute extent with viewport filtering
			const filterOptions: ExtentFilterOptions = {
				filterAxis: binnedAxis,
				filterDomain: viewportDomain as [number, number]
			};

			let extent = computeExtentFromData(this.data, channels, filterOptions);
			if (!extent) return;

			// Apply zero baseline if configured
			if (this.#config.zeroBaseline?.[aggregateAxis as 'x' | 'y']) {
				extent = [Math.min(0, extent[0]), Math.max(0, extent[1])];
			}

			const scaleState = this.#chartContext[`${aggregateAxis}ScaleState`];
			if (scaleType === 'time' && scaleState?.addOffsetExtent) {
				scaleState.addOffsetExtent(extent, this.#markId);
			} else if (scaleState?.addMark) {
				scaleState.addMark(extent, this.#markId);
			}
		}, 16); // One frame (~60fps) - very responsive for in-memory computation
	}

	// ===========================================================================
	// ADAPTIVE BINNING
	// ===========================================================================

	/**
	 * Check if domain change is significant enough to trigger re-binning.
	 */
	#shouldReBin(currentDomain: number[], axis: string): boolean {
		const lastDomain = this.#lastBinningDomain[axis as 'x' | 'y'];
		if (!lastDomain) return false; // First run, no baseline
		if (!currentDomain || currentDomain.length !== 2) return false;

		const lastWidth = lastDomain[1] - lastDomain[0];
		const currentWidth = currentDomain[1] - currentDomain[0];

		if (lastWidth <= 0 || currentWidth <= 0) return false;

		const ratio = lastWidth / currentWidth;

		// Re-bin if zoomed in/out beyond threshold
		return ratio > this.#binningThreshold || ratio < 1 / this.#binningThreshold;
	}

	/**
	 * Schedule a re-bin operation (debounced).
	 */
	#scheduleReBin(axis: string, domain: number[]): void {
		clearTimeout(this.#rebinTimeout!);
		this.#rebinTimeout = setTimeout(() => {
			console.log(`🔄 [${this.#markId}] Re-binning ${axis} axis with domain:`, domain);
			this.#lastBinningDomain[axis as 'x' | 'y'] = [...domain];

			// Skip updating the binned axis domain (user zoomed there intentionally)
			// But DO update the aggregate axis domain (counts changed)
			this.#skipDomainUpdateForAxis = axis;

			// Track current dataVersion - we'll wait for it to increment before updating domains
			this.#rebinPendingDataVersion = this.client?.dataVersion ?? null;

			// Reset data-derived domain flag so aggregate extent updates from new data
			this.#dataDerivedDomainsSet = false;

			// Invalidate resolved select cache so next buildQuery re-resolves bins
			this.#cachedQueryParts = null;

			// Trigger re-query using Mosaic's requestUpdate (throttled)
			// This will cause buildQuery to be called again with new domain context
			if (this.client) {
				this.client.requestUpdate();
			}
		}, 16); // Snappy re-query (Mosaic has its own throttling)
	}

	// ===========================================================================
	// TOOLTIP WRITE-BACK
	// ===========================================================================

	get tooltipTableName(): string {
		return this.#tooltipTableName;
	}

	get tooltipEnabled(): boolean {
		return this.#tooltipWanted && this.#tooltipTableReady;
	}

	/** Channel → original field name mapping (single source of truth for display). */
	get channelFieldMap(): Record<string, string> {
		return buildChannelFieldMap(this.#config.select);
	}

	async #writeTooltipTable(data: DataAccessor): Promise<void> {
		const tableName = this.#tooltipTableName;
		try {
			if (!this.#transformCompiler.hasJSTransforms()) {
				// Path A: Build a fresh query from the original select config.
				// We cannot reuse a captured query object because Mosaic's pre-aggregation
				// mutates it in-place (setSelect), replacing x/y aliases with pre_* hashes.
				// Instead, rebuild from getSelectConfig() which is never mutated.
				const selectConfig = this.getSelectConfig();

				// Get current crossfilter predicate (original column names, not preagg).
				// selection.predicate(client) returns an array of SQL expression nodes,
				// or undefined if client is the active cross-filter source (skip self).
				let filter: unknown[] = [];
				const selection = this.#config.selection;
				if (selection && this.client) {
					const predicate = selection.predicate(this.client);
					if (Array.isArray(predicate)) filter = predicate;
				}

				// Build with channel-named aliases (forMosaic=false) so the tooltip
				// temp table columns match what the tooltip query system expects.
				const tooltipQuery = this.buildQuery(
					this.effectiveTable,
					{
						select: selectConfig,
						_filterNulls: this.#config._filterNulls as ExprValue[] | undefined
					} as DataClientConfig,
					filter,
					false
				);

				// Pre-cast numeric axis columns to DOUBLE (avoids DECIMAL overflow in distance math).
				// Build REPLACE clause dynamically — bar marks have x1/x2 or y1/y2 instead of x/y.
				const castCols = ['x', 'x1', 'x2', 'y', 'y1', 'y2'].filter((c) => c in selectConfig);
				const replaceClause =
					castCols.length > 0
						? ` REPLACE (${castCols.map((c) => `CAST(${c} AS DOUBLE) AS ${c}`).join(', ')})`
						: '';

				// Optional ORDER BY for zone-map skipping in bounding-box queries.
				// Use the first available continuous-axis column.
				let orderClause = '';
				if (this.#tooltipSortTable) {
					const orderCol = ['x', 'x1', 'x2'].find((c) => c in selectConfig);
					if (orderCol) orderClause = ` ORDER BY ${orderCol}`;
				}

				await this.#coordinator.exec([
					`DROP TABLE IF EXISTS "${tableName}"`,
					`CREATE TEMP TABLE "${tableName}" AS SELECT *${replaceClause} FROM (${tooltipQuery.toString()})${orderClause}`
				]);
				this.#tooltipTableReady = true;
			} else {
				// Path B: Serialize transformed data via SQL VALUES.
				// JS transforms produce small datasets (tens of rows).
				const columns = data.columnNames.filter((c) => !c.startsWith('__dplot_'));
				if (columns.length === 0) return;

				const columnArrays: Record<string, ArrayLike<unknown>> = {};
				for (const col of columns) {
					const colData = data.getColumn(col);
					if (colData) columnArrays[col] = colData;
				}

				// Band axis columns from category-reducing transforms (e.g. topN) contain
				// strings instead of ViewManager integer indices. Use the scale's index map
				// to convert them so the tooltip query pipeline works unchanged.
				const bandIndexMaps: Record<string, ReadonlyMap<string, number>> = {};
				const xss = this.#chartContext.xScaleState;
				if (this.actualXScaleType === 'band' && xss && 'categoryIndexMap' in xss) {
					bandIndexMaps['x'] = xss.categoryIndexMap;
				}
				const yss = this.#chartContext.yScaleState;
				if (this.actualYScaleType === 'band' && yss && 'categoryIndexMap' in yss) {
					bandIndexMaps['y'] = yss.categoryIndexMap;
				}

				// Infer schema from first row
				const schemaDef = columns
					.map((col) => {
						if (bandIndexMaps[col]) return `"${col}" INTEGER`;
						const sample = columnArrays[col]?.[0];
						const sqlType = typeof sample === 'number' ? 'DOUBLE' : 'VARCHAR';
						return `"${col}" ${sqlType}`;
					})
					.join(', ');

				// Build VALUES rows
				const valueRows: string[] = [];
				for (let i = 0; i < data.length; i++) {
					const vals = columns.map((col) => {
						const v = columnArrays[col]?.[i];
						if (v == null || (typeof v === 'number' && isNaN(v))) return 'NULL';
						const bandMap = bandIndexMaps[col];
						if (bandMap && typeof v === 'string') {
							const idx = bandMap.get(v);
							return idx != null ? idx.toString() : 'NULL';
						}
						if (typeof v === 'number') return v.toString();
						return `'${String(v).replace(/'/g, "''")}'`;
					});
					valueRows.push(`(${vals.join(', ')})`);
				}

				await this.#coordinator.exec([
					`DROP TABLE IF EXISTS "${tableName}"`,
					`CREATE TEMP TABLE "${tableName}" (${schemaDef})`,
					`INSERT INTO "${tableName}" VALUES ${valueRows.join(', ')}`
				]);
				this.#tooltipTableReady = true;
			}
		} catch (error) {
			console.error(`Failed to write tooltip table "${tableName}":`, error);
		}
	}

	destroy(): void {
		console.log(`💥 MarkLifecycle destroying for ${this.#markId}`);

		clearTimeout(this.#rebinTimeout!);
		clearTimeout(this.#viewportDomainUpdateTimeout!);
		clearTimeout(this.#tooltipWriteTimeout!);

		// Drop tooltip temp table
		this.#tooltipTableReady = false;
		if (this.#tooltipWanted && this.#coordinator) {
			this.#coordinator.exec(`DROP TABLE IF EXISTS "${this.#tooltipTableName}"`).catch(() => {});
		}

		// Unregister client from chart context
		this.#unregisterClient?.();
		this.#unregisterClient = null;

		this.#chartContext.unregisterScaleType('x', this.#markId);
		this.#chartContext.unregisterScaleType('y', this.#markId);

		Object.values(this.#scaleMap).forEach((scale) => scale?.removeMark(this.#markId));

		if (this.client) {
			this.client.destroy();
			this.client = null;
		}
	}
}
