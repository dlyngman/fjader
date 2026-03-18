// src/lib/components/marks/MarkLifecycle.svelte.ts

import { untrack } from 'svelte';
import { DataClient } from '$lib/data/DataClient.svelte';
import type { DataClientConfig, DataClientOptions } from '$lib/data/DataClient.svelte';
import { Query, isNode, isAggregateExpression, sql, column as sqlColumn, min as sqlMin, max as sqlMax } from '@uwdata/mosaic-sql';
import type { ExprValue, FilterExpr } from '@uwdata/mosaic-sql';
import type { Selection, Coordinator, FieldInfoRequest } from '@uwdata/mosaic-core';
import { Priority } from '@uwdata/mosaic-core';
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
import { type RollingAvgNode, isRollingAvgExpression } from '$lib/sql/rolling-avg';
import { isContinuousScale } from '$lib/scales/scale-categories';
import { generateMarkId, buildChannelFieldMap } from '../utils';
import { buildExpressionLabel } from '../utils/channel-field-map';
import { isWindowExpression } from '$lib/sql/expression-utils';
import { computeExtentFromData, detectChannelsNeedingDataDomain } from './domain-computation';
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
import { LODController } from '$lib/lod';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';

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
//  Effect 8:  LODController + tooltipManager      → register LODController with tooltip
//  Effect 9:  client.dataVersion                 → tooltip table [side effect]
//  Effect 10: domain.target + fitDomain           → DuckDB MIN/MAX sidecar query
//  (Cross-filter fitDomain updates: #onTooltipTableWritten after tooltip table write)
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
	domain?: { x?: string[]; y?: string[] } | null;
	tooltip?: boolean | { sortTable?: boolean };
	constants?: Record<string, number>;
	colorChannel?: string; // Key in select for color data ('fill' or 'stroke')
	sizeChannel?: string; // Key in select for size data ('r')
	_connectedConfig?: ConnectedConfig;
	_filterNulls?: unknown[];
	fitDomain?: 'x' | 'y' | boolean;
	zeroBaseline?: { x?: boolean; y?: boolean };
	/** Skip scale registration and domain contribution. The mark renders into
	 *  the chart's existing scales without affecting them (LOD overlays). */
	passiveScales?: boolean;
	/** Raw resolved tip array — expression entries are injected lazily into the
	 *  tooltip temp table query (not into the main rendering query). */
	tip?: (unknown | '*')[] | false;
}

export interface MarkLifecycleOptions {
	gpuCoordinator?: GPUCoordinator | null;
	onLodController?: ((ctrl: LODController | null) => void) | null;
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
	#rollingAvgNodes: Map<string, RollingAvgNode> = new Map();

	// --- Tooltip Write-Back ---
	#tooltipWanted: boolean;
	#tooltipTableReady = $state(false);
	#tooltipSortTable: boolean;
	#tooltipTableName: string;
	#tooltipWriteTimeout: ReturnType<typeof setTimeout> | null = null;

	// --- Adaptive Binning / LOD Support ---
	#lastBinningDomain: { x: number[] | null; y: number[] | null } = { x: null, y: null };
	#binningThreshold: number = 1.25;
	#skipDomainUpdateForAxis: string | null = null;
	#rebinPendingDataVersion: number | null = null;
	#gpuCoordinator: GPUCoordinator | null = null;
	#lodController: LODController | null = null;

	// --- Query Build Cache ---
	// Caches all filter-independent query state (resolved select, classification,
	// transforms, ordering) so repeated buildQuery calls during interaction
	// only apply the WHERE clause. Invalidated on re-bin or multiplier change.
	#cachedQueryParts: QueryParts | null = null;

	// --- fitDomain Support ---
	#fitDomainTimeout: ReturnType<typeof setTimeout> | null = null;
	#fitDomainLastTarget: [number, number] = [0, 0];
	#fitDomainQuerySequence = 0;
	#fitDomainSuppressed = false;

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

	#onLodController: ((ctrl: LODController | null) => void) | null = null;

	constructor(
		config: MarkLifecycleConfig,
		coordinator: Coordinator,
		chartContext: ChartContext,
		stableId: string | null = null,
		options?: MarkLifecycleOptions
	) {
		this.#config = config;
		this.#coordinator = coordinator;
		this.#chartContext = chartContext;
		this.#markId = stableId || generateMarkId(config.markType);

		// Tooltip write-back
		// Write tooltip table if tooltips are enabled OR fitDomain needs it for Path B
		this.#tooltipWanted = config.tooltip !== false || !!config.fitDomain;
		this.#tooltipSortTable =
			typeof config.tooltip === 'object' ? config.tooltip.sortTable !== false : true;
		this.#tooltipTableName = `_tt_${this.#markId.replace(/-/g, '_')}`;

		// Ensure services have coordinator (idempotent)
		MarkLifecycle.ensureServices(coordinator);

		// Store options for LODController creation
		this.#gpuCoordinator = options?.gpuCoordinator ?? null;
		this.#onLodController = options?.onLodController ?? null;

		// Create transform compiler
		this.#transformCompiler = new TransformCompiler(config.transforms || []);

		// Detect auto bins in select
		this.#detectAutoBins();

		// Create LODController for binned marks (owns adaptive re-binning + shift+scroll)
		if (this.#autoBinNodes.size > 0 && this.#gpuCoordinator) {
			const xHasBin = this.#autoBinNodes.has('x1') || this.#autoBinNodes.has('x2');
			const yHasBin = this.#autoBinNodes.has('y1') || this.#autoBinNodes.has('y2');
			const binAxes: ('x' | 'y')[] = [];
			if (xHasBin) binAxes.push('x');
			if (yHasBin) binAxes.push('y');
			this.#lodController = new LODController(coordinator, this.#gpuCoordinator, chartContext, {
				mode: 'binned',
				markLifecycle: this,
				binAxes,
				binningThreshold: this.#binningThreshold,
				onTunableChange: (_key, value) => {
					// Persist multiplier change to entry.lod for spec export
					const entry = chartContext.config.entries.get(this.#markId);
					if (!entry) return;
					const current = entry.lod;
					const cfg = typeof current === 'object' && current ? current : {};
					chartContext.config.setMarkProp(this.#markId, 'lod', { ...cfg, multiplier: value });
				}
			});
			this.#onLodController?.(this.#lodController);

			// Apply initial multiplier from entry's lod config (spec roundtrip)
			const entry = chartContext.config.entries.get(this.#markId);
			if (entry) {
				const lodCfg = entry.lod;
				if (typeof lodCfg === 'object' && lodCfg && typeof lodCfg.multiplier === 'number') {
					this.#lodController.setBinMultiplier(lodCfg.multiplier);
				}
			}
		}

		// Detect which channels need data-derived domains (aggregates)
		this.#channelsNeedingDataDomain = detectChannelsNeedingDataDomain(
			config.select,
			config.scaleRequirements,
			this.#transformCompiler
		);
		this.#registerScaleRequirements();
		this.#setupReactiveEffects();
	}

	// Detect AutoBinNodes and RollingAvgNodes in config
	#detectAutoBins(): void {
		for (const [channel, value] of Object.entries(this.#config.select)) {
			if (isBinExpression(value)) {
				this.#autoBinNodes.set(channel, value);
			} else if (isRollingAvgExpression(value)) {
				this.#rollingAvgNodes.set(channel, value);
				// Register invalidation callback: when windowSize changes,
				// clear query cache and re-query (same pattern as triggerReBin).
				value.registerInvalidation(() => {
					this.#cachedQueryParts = null;
					this.client?.requestUpdate();
				});
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

				// Passive scales: skip domain fetching, just advance the chain
				if (this.#config.passiveScales) {
					this.categoricalDataFetched = true;
					this.#colorDomainFetched = true;
					setScalesReady(
						this.#scaleMap,
						this.#channelsNeedingDataDomain,
						this.actualXScaleType,
						this.actualYScaleType,
						false,
						false
					);
					return;
				}

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
					this.#markId,
					this.#config.domain
				);
				const aggPromise = fetchGlobalAggregates(
					this.#coordinator!,
					this.effectiveTable,
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
						if (colorReady) this.#colorDomainFetched = true;
						if (aggResult.globalAggregatesSet) this.#globalAggregatesSet = true;

						// Ordinal color scales need a __dplot_*_color_idx column
						// in the view. Don't advance to client creation until the
						// color domain is fetched and that column is registered.
						// Sequential/continuous scales don't use index columns.
						const ordinalColorPending =
							!!this.#config.select?.[colorKey] &&
							(!this.#colorScaleState || this.#colorScaleState.isOrdinal) &&
							!this.#colorDomainFetched;
						if (!ordinalColorPending) {
							this.categoricalDataFetched = true;
						}
						setScalesReady(
							this.#scaleMap,
							this.#channelsNeedingDataDomain,
							this.actualXScaleType,
							this.actualYScaleType,
							this.#globalAggregatesSet,
							this.#dataDerivedDomainsSet
						);
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
			if (!viewManager.isReadyForClient(this.#config.table)) return;

			// REACTIVITY: Track effectiveTable
			const tableToQuery = this.effectiveTable;

			// Check if table changed (using tracked state)
			if (this.#currentClientTable !== tableToQuery) {
				// Action (untracked to prevent loops)
				untrack(() => {
					if (this.client) {
						this.client.destroy();
						this.client = null;
					}

					const fieldRequests = buildFieldInfoRequests(
						this.#config.select,
						tableToQuery,
						this.actualXScaleType,
						this.actualYScaleType
					);
					this.#createClient(tableToQuery, fieldRequests);
					this.#currentClientTable = tableToQuery;
					this.#clientCreated = true;
				});
			}
		});

		// Effect 5: Set initial continuous domains when fieldInfo arrives (merged 5+6)
		$effect(() => {
			if (this.#clientCreated && this.client?.fieldInfo && !this.#continuousDomainsSet) {
				if (!this.#config.passiveScales) {
					setInitialContinuousDomains(
						this.client.fieldInfo,
						this.#scaleMap,
						this.#config.select,
						this.actualXScaleType,
						this.actualYScaleType,
						this.#markId
					);
				}
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
			if (this.#config.passiveScales) {
				// Skip domain registration — overlay renders in parent's scale space
				this.#dataDerivedDomainsSet = true;
			} else {
				const result = registerDataDerivedDomains(
					data,
					this.#channelsNeedingDataDomain,
					additionalChannels,
					this.#skipDomainUpdateForAxis,
					this.#config.zeroBaseline,
					this.actualXScaleType,
					this.actualYScaleType,
					xState,
					yState,
					this.#transformCompiler.hasCategoryReducingTransforms(),
					this.#chartContext.xScaleState as BandScaleState | null,
					this.#chartContext.yScaleState as BandScaleState | null,
					this.#markId,
					isRebinning
				);
				this.#dataDerivedDomainsSet = result.dataDerivedDomainsSet;
				this.#skipDomainUpdateForAxis = result.skipDomainUpdateForAxis;

			}
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

		// Effect 8: Register binned LODController with ChartConfig
		// (palette access + shift+scroll routing via TooltipManager delegation)
		$effect(() => {
			if (!this.#lodController) return;
			this.#chartContext.config.registerLodController(this.#markId, this.#lodController);
			return () => this.#chartContext.config.unregisterLodController(this.#markId);
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

		// Effect 10: fitDomain - query DuckDB for fitted axis extent on driving axis change.
		// Suppressed when the user directly interacts with the fitted axis (zoom/pan).
		// Re-enabled when the driving axis changes from a non-user source (e.g., overview brush).
		// NOTE: Cross-filter domain updates (data changes without driving axis change) are
		// handled by the normal data-derived domain flow (registerDataDerivedDomains in Effect 6),
		// not here. This effect only handles viewport-driven domain fitting.
		$effect(() => {
			const fitDomain = this.#config.fitDomain;
			if (!fitDomain) return;
			if (!this.#dataDerivedDomainsSet) return;

			const fittedAxis = this.#resolveFittedAxis(fitDomain);
			if (!fittedAxis) return;

			const drivingAxis = fittedAxis === 'y' ? 'x' : 'y';
			const drivingSS =
				drivingAxis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;
			if (!drivingSS || drivingSS.scaleType === 'band') return;

			const target = drivingSS.domain?.target;
			if (!target) return;

			// Read userDriven on both axes (reactive — re-runs when interaction state changes)
			const fittedSS =
				fittedAxis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;
			const fittedUserDriven = (fittedSS as ContinuousScaleState | null)?.userDriven ?? false;
			const drivingUserDriven = (drivingSS as ContinuousScaleState).userDriven;

			// Tell the fitted scale to skip disjoint-domain instant snap — fitDomain
			// intentionally produces large domain jumps that should animate smoothly.
			if (fittedSS) {
				(fittedSS as ContinuousScaleState).fitDomainActive = true;
			}

			untrack(() => {
				// User interacted with the fitted axis → suppress
				if (fittedUserDriven) {
					this.#fitDomainSuppressed = true;
				}

				// Driving axis changed from non-user source (brush/external) → re-enable
				if (this.#fitDomainSuppressed && !drivingUserDriven) {
					this.#fitDomainSuppressed = false;
				}

				if (this.#fitDomainSuppressed) return;

				clearTimeout(this.#fitDomainTimeout!);
				this.#fitDomainTimeout = setTimeout(() => {
					this.#issueFitDomainQuery(fittedAxis, target as [number, number]);
				}, 200);
			});
		});

		// Cross-filter fitDomain updates are triggered from #writeTooltipTable
		// completion via #onTooltipTableWritten — no separate effect needed.
	}

	#registerScaleRequirements(): void {
		const { scaleRequirements, inferredScaleColumns } = this.#config;

		// Passive scales: skip registration but still gate the effect chain.
		// The mark reads the parent chart's scales without contributing to them.
		if (this.#config.passiveScales) {
			this.#scaleRequirementsRegistered = !!(
				scaleRequirements?.x?.type && scaleRequirements?.y?.type
			);
			return;
		}

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
	 * Trigger a re-bin operation. Called by LODController when domain change
	 * exceeds threshold or when the user adjusts resolution via shift+scroll.
	 * Performs the query cache invalidation and requests a Mosaic re-query.
	 */
	triggerReBin(axis: string, domain: number[]): void {
		this.#lastBinningDomain[axis as 'x' | 'y'] = [...domain];
		this.#skipDomainUpdateForAxis = axis;
		this.#rebinPendingDataVersion = this.client?.dataVersion ?? null;
		this.#dataDerivedDomainsSet = false;
		this.#cachedQueryParts = null;
		if (this.client) {
			this.client.requestUpdate();
		}
	}

	/**
	 * Get the LODController (if active). Used by mark components for line-mode
	 * LODController to check if binned LOD is already active.
	 */
	get lodController(): LODController | null {
		return this.#lodController;
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
			}
		}
		if ((this.actualYScaleType === 'band' || this.actualYScaleType === 'point') && !skipIndexSwap) {
			const yScale = this.#chartContext.yScaleState as BandScaleState | null | undefined;
			if (yScale?.indexColumnName && hasView) {
				const originalField = select.y;
				select.y = yScale.indexColumnName;
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
			select[colorKey] = this.#colorScaleState.indexColumnName;
		}

		// For faceting, include the facet index column
		const facetBandScale = this.#chartContext.facetBandScale;
		if (facetBandScale?.indexColumnName && hasView) {
			select.__facet = facetBandScale.indexColumnName;
		}

		return select;
	}

	buildQuery(
		sourceTable: string,
		config: DataClientConfig,
		filter: unknown[],
		forMosaic = true
	): Query | null {
		// Build and cache all filter-independent query parts on first call.
		// Subsequent calls (e.g. during brush interaction) reuse the cache.
		if (!this.#cachedQueryParts) {
			let select: Record<string, unknown> = config.select;

			// Resolve auto bins if we have field info.
			// If autobins exist but fieldInfo isn't available yet, defer —
			// unresolved AutoBinNodes would stringify to "[object Object]" in SQL.
			if (this.#autoBinNodes.size > 0) {
				if (!this.client?.fieldInfo) return null;
				select = this.#resolveAutoBins(config.select);
			}

			// Resolve RollingAvgNodes to window expressions
			if (this.#rollingAvgNodes.size > 0) {
				select = this.#resolveRollingAvgNodes(select);
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
						// Only seed from scale domain if the scale has real data.
						// Before data arrives, domain.current is a default (e.g., [0,100])
						// that would produce wrong bin boundaries.
						const ss = scaleState as ContinuousScaleState | null | undefined;
						if (ss?.ready) {
							currentDomain = ss.domain?.current as unknown as [number, number] | null;
							if (currentDomain) {
								this.#lastBinningDomain[axis as 'x' | 'y'] = [...currentDomain];
							}
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

	#resolveRollingAvgNodes(select: Record<string, unknown>): Record<string, unknown> {
		const resolved: Record<string, unknown> = {};
		for (const [channel, value] of Object.entries(select)) {
			if (isRollingAvgExpression(value)) {
				resolved[channel] = value.resolve();
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
					result[ch] = scaleState.offsetColumnName;
				} else if (isNode(val)) {
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
	}

	// ===========================================================================
	// FIT DOMAIN (viewport-local domain via DuckDB queries)
	// ===========================================================================

	/**
	 * Build a sidecar query by wrapping this mark's assembled query as a derived table.
	 * Shared primitive used by LODController (COUNT), fitDomain (MIN/MAX), etc.
	 * The inner query reuses #cachedQueryParts — only the filter varies per call.
	 */
	buildSidecarQuery(
		outerSelect: Record<string, unknown>,
		where?: unknown
	): Query | null {
		if (!this.client) return null;
		const innerQuery = this.buildQuery(
			this.effectiveTable,
			this.client.config,
			this.currentFilter,
			false
		);
		if (!innerQuery) return null;
		const q = Query.from({ mark_data: innerQuery }).select(outerSelect as Record<string, ExprValue>);
		if (where) q.where(where as FilterExpr);
		return q;
	}

	/**
	 * Resolve the fitted axis from the fitDomain prop.
	 * 'x' | 'y' pass through. true: infer from mark structure (bins → aggregate axis, else 'y').
	 */
	#resolveFittedAxis(fitDomain: 'x' | 'y' | boolean): 'x' | 'y' | null {
		if (fitDomain === 'x') return 'x';
		if (fitDomain === 'y') return 'y';
		// Boolean true: infer from mark structure
		const xHasBins = this.#autoBinNodes.has('x1') || this.#autoBinNodes.has('x2');
		const yHasBins = this.#autoBinNodes.has('y1') || this.#autoBinNodes.has('y2');
		if (xHasBins && !yHasBins) return 'y';
		if (yHasBins && !xHasBins) return 'x';
		return 'y'; // Default: fit Y based on X viewport
	}

	/**
	 * Get the channel names for a given axis from the mark's select config
	 * and transform output channels. Includes stack outputs (y0/y1, x0/x1)
	 * which hold the actual rendered extent for stacked marks.
	 */
	#getFitDomainChannels(axis: 'x' | 'y', includeTransformChannels: boolean): string[] {
		const select = this.#config.select;
		const candidates = [axis, `${axis}1`, `${axis}2`];
		const channels = candidates.filter((c) => c in select);

		// Stack transforms output y0/y1 (or x0/x1) which hold the cumulative
		// extent. Only include when querying the tooltip temp table (Path B)
		// which has these columns. Path A queries DuckDB directly where they
		// don't exist.
		if (includeTransformChannels) {
			const additionalChannels = this.#transformCompiler.getAdditionalChannels();
			const stackCandidates = [`${axis}0`, `${axis}1`];
			for (const ch of stackCandidates) {
				if (additionalChannels.includes(ch) && !channels.includes(ch)) {
					channels.push(ch);
				}
			}
		}

		return channels;
	}

	/**
	 * Issue a low-priority DuckDB query to compute the fitted axis extent
	 * within the current driving axis viewport.
	 */
	async #issueFitDomainQuery(
		fittedAxis: 'x' | 'y',
		drivingDomain: [number, number] | null,
		force: boolean = false
	): Promise<void> {
		// Skip if driving domain hasn't changed significantly (unless forced by
		// cross-filter data change where the domain is the same but the data differs)
		if (!force && drivingDomain) {
			const [lastLo, lastHi] = this.#fitDomainLastTarget;
			const lastWidth = lastHi - lastLo;
			const curWidth = drivingDomain[1] - drivingDomain[0];
			if (lastWidth > 0 && curWidth > 0) {
				const ratio = lastWidth / curWidth;
				const shift = Math.abs(drivingDomain[0] - lastLo) / curWidth;
				if (ratio > 0.95 && ratio < 1.05 && shift < 0.02) return; // negligible change
			}
		}

		const seq = ++this.#fitDomainQuerySequence;

		try {
			const q = this.#buildFitDomainQuery(fittedAxis, drivingDomain);
			if (!q) return;

			// cache: false — the sidecar queries a temp table that gets DROP'd and
			// recreated with new data between calls. The SQL string is identical but
			// the underlying data differs, so cached results would be stale.
			// TODO: Use versioned tooltip table names (e.g., _tt_mark_v3) so each
			// query string is unique and Mosaic's LRU cache works naturally. Would
			// need to drop the old table after creating the new one (atomic swap).
			const result = await this.#coordinator.query(q, { priority: Priority.Low, cache: false });
			if (seq !== this.#fitDomainQuerySequence) return; // stale

			const row = Array.from(result)[0] as Record<string, number> | undefined;
			if (!row) return;

			// Collect extent from all MIN/MAX columns
			let lo = Infinity;
			let hi = -Infinity;
			for (const [key, val] of Object.entries(row)) {
				if (val == null || !isFinite(val as number)) continue;
				if (key.startsWith('min_') && (val as number) < lo) lo = val as number;
				if (key.startsWith('max_') && (val as number) > hi) hi = val as number;
			}
			if (lo >= hi) return;

			// Apply zero baseline if configured
			if (this.#config.zeroBaseline?.[fittedAxis]) {
				lo = Math.min(0, lo);
				hi = Math.max(0, hi);
			}

			// Update the fitted axis scale.
			const scaleState =
				fittedAxis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;
			const scaleType = fittedAxis === 'x' ? this.actualXScaleType : this.actualYScaleType;
			if (scaleType === 'time' && scaleState && 'addOffsetExtent' in scaleState) {
				(scaleState as TimeScaleState).addOffsetExtent([lo, hi], this.#markId);
			} else if (scaleState && 'addMark' in scaleState) {
				(scaleState as ContinuousScaleState).addMark([lo, hi], this.#markId);
			}

			if (drivingDomain) this.#fitDomainLastTarget = [...drivingDomain];
		} catch (e) {
			// Silently ignore — query may fail during teardown or table recreation
		}
	}

	/**
	 * Build the fitDomain MIN/MAX query.
	 * Path A (no JS transforms): sidecar CTE wrapping the mark's base query.
	 * Path B (JS transforms): query the tooltip temp table directly.
	 */
	#buildFitDomainQuery(
		fittedAxis: 'x' | 'y',
		drivingDomain: [number, number] | null
	): Query | null {
		// Determine path: Path B uses tooltip table (has transform columns),
		// Path A uses raw DB (no transform columns like y0/y1).
		const useTooltipTable = this.#transformCompiler.hasJSTransforms() && this.#tooltipTableReady;

		const fittedChannels = this.#getFitDomainChannels(fittedAxis, useTooltipTable);
		if (fittedChannels.length === 0) return null;

		// Build outer SELECT: MIN/MAX for each fitted channel
		const outerSelect: Record<string, unknown> = {};
		for (const ch of fittedChannels) {
			outerSelect[`min_${ch}`] = sqlMin(sqlColumn(ch));
			outerSelect[`max_${ch}`] = sqlMax(sqlColumn(ch));
		}

		// Build WHERE clause on the driving axis (null for band driving axes —
		// crossfilter already filtered the data, no viewport constraint needed)
		let whereClause: unknown = undefined;
		if (drivingDomain) {
			const drivingAxis = fittedAxis === 'y' ? 'x' : 'y';
			const drivingChannels = this.#getFitDomainChannels(drivingAxis, useTooltipTable);
			whereClause = this.#buildFitDomainWhere(drivingChannels, drivingDomain);
		}

		// Path B: JS transforms exist and tooltip table is ready → query the tooltip table
		if (useTooltipTable) {
			const q = Query.from(this.#tooltipTableName)
				.select(outerSelect as Record<string, ExprValue>);
			if (whereClause) q.where(whereClause as FilterExpr);
			return q;
		}

		// Path A: CTE-wrap the mark's base query
		return this.buildSidecarQuery(outerSelect, whereClause);
	}

	/**
	 * Build WHERE clause for fitDomain viewport filtering.
	 * Point channels (x): x BETWEEN lo AND hi
	 * Range channels (x1, x2): x2 >= lo AND x1 <= hi (intersection)
	 */
	#buildFitDomainWhere(
		drivingChannels: string[],
		domain: [number, number]
	): unknown {
		const [lo, hi] = domain;

		// Range channels: intersection check
		const ch1 = drivingChannels.find((c) => c.endsWith('1'));
		const ch2 = drivingChannels.find((c) => c.endsWith('2'));
		if (ch1 && ch2) {
			return sql`${sqlColumn(ch2)} >= ${lo} AND ${sqlColumn(ch1)} <= ${hi}`;
		}

		// Point channel
		const ch = drivingChannels[0];
		if (ch) {
			return sql`${sqlColumn(ch)} BETWEEN ${lo} AND ${hi}`;
		}

		return undefined;
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

	// ===========================================================================
	// TOOLTIP WRITE-BACK
	// ===========================================================================

	get tooltipTableName(): string {
		return this.#tooltipTableName;
	}

	get tooltipEnabled(): boolean {
		return this.#config.tooltip !== false && this.#tooltipTableReady;
	}

	/** Channel → original field name mapping (single source of truth for display). */
	get channelFieldMap(): Record<string, string> {
		return buildChannelFieldMap(this.#config.select);
	}

	/**
	 * Live getter — returns the current crossfilter predicate array from the Selection.
	 * Recomputes each call via Mosaic's selection.predicate() API (no stored mutable state).
	 * Returns [] when no selection is active or this client is the crossfilter source
	 * (predicate() returns undefined when the client should skip its own filter).
	 */
	get currentFilter(): unknown[] {
		const selection = this.#config.selection;
		if (!selection || !this.client) return [];
		const predicate = (selection as Selection).predicate(this.client as MosaicClient);
		if (predicate == null) return [];
		// Mosaic returns an array for intersect/single mode (DivePlot's default),
		// but a single OR-combined node for union mode. Normalize to array.
		return Array.isArray(predicate) ? predicate : [predicate];
	}

	/**
	 * Build a viewport count query by wrapping this mark's assembled query as a
	 * derived table. Used by LODController for all viewport counting — the inner
	 * query handles type coercion (time scales), aggregates, bins, and view columns.
	 *
	 * Uses forMosaic=false so the inner query's SELECT aliases are channel names.
	 * The outer query counts rows where the given channel falls within [lo, hi].
	 */
	buildViewportCountQuery(
		xChannel: string,
		xLo: number,
		xHi: number,
		yChannel: string | null,
		yLo: number,
		yHi: number
	): Query | null {
		const xCol = sqlColumn(xChannel);
		let whereClause = sql`${xCol} BETWEEN ${xLo} AND ${xHi}`;

		if (yChannel != null && isFinite(yLo) && isFinite(yHi)) {
			const yCol = sqlColumn(yChannel);
			whereClause = sql`${xCol} BETWEEN ${xLo} AND ${xHi} AND ${yCol} BETWEEN ${yLo} AND ${yHi}`;
		}

		return this.buildSidecarQuery({ cnt: sql`COUNT(*)` }, whereClause);
	}

	/**
	 * Called after the tooltip table is written. If fitDomain is active, issue
	 * a sidecar query against the fresh tooltip table to update the fitted axis
	 * domain. This handles cross-filter data changes where the driving axis
	 * doesn't move but the data (and thus the Y extent) changes.
	 */
	/**
	 * Called after the tooltip table is written with fresh data.
	 * If fitDomain is active, issue a sidecar MIN/MAX query against the
	 * now-guaranteed-fresh tooltip table.
	 */
	#onTooltipTableWritten(): void {
		const fitDomain = this.#config.fitDomain;
		if (!fitDomain) return;
		if (this.#fitDomainSuppressed) return;

		const fittedAxis = this.#resolveFittedAxis(fitDomain);
		if (!fittedAxis) return;

		const drivingAxis = fittedAxis === 'y' ? 'x' : 'y';
		const drivingSS =
			drivingAxis === 'x' ? this.#chartContext.xScaleState : this.#chartContext.yScaleState;
		if (!drivingSS) return;

		// Band driving axes (e.g. bar charts): no continuous domain to filter by,
		// but crossfilter already filtered the data — just query MIN/MAX directly.
		if (drivingSS.scaleType === 'band') {
			this.#issueFitDomainQuery(fittedAxis, null, true);
			return;
		}

		const target = drivingSS.domain?.target;
		if (!target) return;

		this.#issueFitDomainQuery(fittedAxis, target as [number, number], true);
	}

	/** Extract expression nodes from the tip prop as { label: exprNode } pairs. */
	#getTipExtras(): Record<string, unknown> {
		const extras: Record<string, unknown> = {};
		const tipEntries = this.#config.tip;
		if (!tipEntries || tipEntries === false) return extras;
		for (const entry of tipEntries) {
			if (entry === '*' || typeof entry === 'string') continue;
			if (!isNode(entry)) continue;
			const label = buildExpressionLabel(entry);
			if (label) extras[label] = entry;
		}
		return extras;
	}

	/**
	 * Merge tip expression extras into an existing tooltip temp table via a
	 * sidecar DB query. Computes the aggregates against the source table using
	 * the same GROUP BY as the main query, then ALTER+UPDATE the temp table.
	 * Works uniformly for both Path A and Path B.
	 */
	async #mergeTipExtras(
		tableName: string,
		tipExtras: Record<string, unknown>
	): Promise<void> {
		if (!this.#cachedQueryParts) return;

		// Identify non-aggregate channel columns — these are the GROUP BY / join keys
		const joinCols: string[] = [];
		for (const [ch, expr] of Object.entries(this.#cachedQueryParts.selectDef)) {
			if (!isAggregateExpression(expr) && !isWindowExpression(expr)) {
				joinCols.push(ch);
			}
		}

		// Build sidecar select: group-by columns + tip extras
		const sidecarSelect: Record<string, unknown> = {};
		for (const ch of joinCols) {
			sidecarSelect[ch] = this.#cachedQueryParts.selectDef[ch];
		}
		Object.assign(sidecarSelect, tipExtras);

		const sidecarParts = buildQueryParts(
			sidecarSelect,
			undefined,
			this.#transformCompiler.hasSQLTransforms()
		);

		let filter: unknown[] = [];
		const selection = this.#config.selection;
		if (selection && this.client) {
			const pred = selection.predicate(this.client);
			if (Array.isArray(pred)) filter = pred;
		}

		const sidecarQuery = assembleQuery(
			this.effectiveTable,
			sidecarParts,
			filter,
			this.#config._filterNulls as unknown[] | null | undefined,
			this.#transformCompiler,
			false
		);

		// ALTER TABLE to add columns, then UPDATE from sidecar query
		const alterStmts = Object.keys(tipExtras).map(
			(col) => `ALTER TABLE "${tableName}" ADD COLUMN "${col}" DOUBLE`
		);
		const setClauses = Object.keys(tipExtras)
			.map((col) => `"${col}" = _s."${col}"`)
			.join(', ');
		const joinCondition = joinCols
			.map((ch) => `"${tableName}"."${ch}" = _s."${ch}"`)
			.join(' AND ');
		const updateStmt = `UPDATE "${tableName}" SET ${setClauses} FROM (${sidecarQuery.toString()}) _s WHERE ${joinCondition}`;

		await this.#coordinator.exec([...alterStmts, updateStmt]);
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
				if (!tooltipQuery) return;

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
			}

			// Merge tip expression extras (aggregates/windows) via sidecar query.
			// Runs after either path creates the base temp table.
			const tipExtras = this.#getTipExtras();
			if (Object.keys(tipExtras).length > 0) {
				try {
					await this.#mergeTipExtras(tableName, tipExtras);
				} catch (err) {
					console.warn('Failed to merge tip extras into tooltip table:', err);
				}
			}

			this.#tooltipTableReady = true;
			this.#onTooltipTableWritten();
		} catch (error) {
			console.error(`Failed to write tooltip table "${tableName}":`, error);
		}
	}

	destroy(): void {
		// Destroy LODController (binned mode)
		if (this.#lodController) {
			this.#onLodController?.(null);
			this.#lodController.destroy();
			this.#lodController = null;
		}

		// Clear RollingAvgNode invalidation callbacks
		for (const node of this.#rollingAvgNodes.values()) {
			node.clearInvalidation();
		}

		clearTimeout(this.#fitDomainTimeout!);
		clearTimeout(this.#tooltipWriteTimeout!);

		// Drop tooltip temp table
		this.#tooltipTableReady = false;
		if (this.#tooltipWanted && this.#coordinator) {
			this.#coordinator.exec(`DROP TABLE IF EXISTS "${this.#tooltipTableName}"`).catch(() => {});
		}

		// Unregister client from chart context
		this.#unregisterClient?.();
		this.#unregisterClient = null;

		if (!this.#config.passiveScales) {
			this.#chartContext.unregisterScaleType('x', this.#markId);
			this.#chartContext.unregisterScaleType('y', this.#markId);
			Object.values(this.#scaleMap).forEach((scale) => scale?.removeMark(this.#markId));
		}

		if (this.client) {
			this.client.destroy();
			this.client = null;
		}
	}
}
