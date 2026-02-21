// src/lib/components/marks/BaseMarkSetup.svelte.ts

import { untrack } from 'svelte';
import { DataClient } from '$lib/data-clients/DataClient.svelte';
import type { DataClientConfig, FieldInfoEntry } from '$lib/data-clients/DataClient.svelte';
import {
	Query,
	isNode,
	sql,
	column as sqlColumn,
	isAggregateExpression,
	isNotNull,
	and,
	min,
	max
} from '@uwdata/mosaic-sql';
import type { ExprNode } from '@uwdata/mosaic-sql';
import type { Selection, Coordinator } from '@uwdata/mosaic-core';
import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
import type { ScaleRequirement } from '$lib/scales/ScalePriorities';
import { TransformCompiler } from '$lib/transforms/TransformCompiler';
import { ArrowDataAccessor, ObjectDataAccessor } from '$lib/data/DataAccessor';
import type { DataAccessor } from '$lib/data/DataAccessor';
import { viewManager } from '$lib/data/ViewManager.svelte';
import { tableSchemaService } from '$lib/data/TableSchemaService.svelte';
import type {
	FieldRef,
	NormalizedSortConfig,
	Transform,
	ChartContext,
	ScaleStateInstance
} from '$lib/types';
import type { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';
import type { Table } from '@uwdata/flechette';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
import type { SizeScaleState } from '$lib/scales/SizeScaleState.svelte';
import { type AutoBinNode, isBinExpression } from '$lib/sql/bin';
import { generateMarkId } from './utils';

// ---------------------------------------------------------------------------
// Local interfaces
// ---------------------------------------------------------------------------

interface ConnectedConfig {
	seriesChannel: string | null;
	dimensionChannel: string;
}

export interface BaseMarkSetupConfig {
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

interface ExtentFilterOptions {
	filterAxis?: string;
	filterDomain?: [number, number];
}

export class BaseMarkSetup {
	// --- Reactive State ---
	client = $state<DataClient | null>(null);
	categoricalDataFetched = $state(false);

	// --- Setup Progress ---
	#scaleRequirementsRegistered = $state(false);
	#scaleStatesReady = $state(false);
	#scaleMappingsReady = $state(false);
	#clientCreated = $state(false);
	#clientDataReady = $state(false);
	#continuousDomainsSet = $state(false);
	#categoricalFetchStarted = $state(false);
	#colorDomainFetched = $state(false);

	// --- Private Properties ---
	#config: BaseMarkSetupConfig;
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
	#tooltipEnabled: boolean;
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

	// --- Viewport-Local Domain Support ---
	#viewportDomainUpdateTimeout: ReturnType<typeof setTimeout> | null = null;

	// --- Data-Derived Domain Support ---
	#channelsNeedingDataDomain: Set<string> = new Set();
	#dataDerivedDomainsSet = $state(false);
	#globalAggregatesSet = $state(false);

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
		config: BaseMarkSetupConfig,
		coordinator: Coordinator,
		chartContext: ChartContext,
		stableId: string | null = null
	) {
		console.log('🔧 BaseMarkSetup constructor:', {
			markType: config.markType,
			transforms: config.transforms,
			transformCount: config.transforms?.length || 0
		});

		this.#config = config;
		this.#coordinator = coordinator;
		this.#chartContext = chartContext;
		this.#markId = stableId || generateMarkId(config.markType);

		// Tooltip write-back
		this.#tooltipEnabled = config.tooltip !== false;
		this.#tooltipSortTable =
			typeof config.tooltip === 'object' ? config.tooltip.sortTable !== false : true;
		this.#tooltipTableName = `_tt_${this.#markId.replace(/-/g, '_')}`;

		// Ensure services have coordinator (idempotent)
		BaseMarkSetup.ensureServices(coordinator);

		// NEW: Create transform compiler
		this.#transformCompiler = new TransformCompiler(config.transforms || []);

		console.log('🔧 TransformCompiler created:', {
			sqlTransforms: this.#transformCompiler.sqlTransforms.length,
			jsTransforms: this.#transformCompiler.jsTransforms.length
		});

		// NEW: Detect auto bins in select
		this.#detectAutoBins();

		// Detect which channels need data-derived domains (aggregates)
		this.#detectChannelsNeedingDataDomain();

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

	/**
	 * Detect which channels need their domain computed from query results.
	 * This includes:
	 * - Aggregate expressions (count, sum, etc.) on linear scales
	 * - Aggregate expressions for continuous color scales
	 * - Channels that will be generated by transforms (x0/x1, y0/y1)
	 */
	#detectChannelsNeedingDataDomain(): void {
		const { select, scaleRequirements } = this.#config;

		// Check each channel in select for aggregates and bins
		for (const [channel, value] of Object.entries(select)) {
			if (value == null) continue;

			// AutoBinNodes need data-derived domains: bin boundaries depend on
			// nice rounding and can't be known until the query results arrive.
			// The sidecar query can't run before fieldInfo resolves bins to SQL.
			if (isBinExpression(value)) {
				if (channel === 'x' || channel === 'x1' || channel === 'x2') {
					this.#channelsNeedingDataDomain.add('x');
				} else if (channel === 'y' || channel === 'y1' || channel === 'y2') {
					this.#channelsNeedingDataDomain.add('y');
				}
				continue;
			}

			// Check if it's an aggregate expression
			const exprNode = isNode(value) ? value : null;
			if (!exprNode || !isAggregateExpression(exprNode)) continue;

			// Determine channel type and whether it needs data-derived domain
			if (channel === 'x' || channel === 'x1' || channel === 'x2') {
				const scaleType = scaleRequirements?.x?.type;
				if (scaleType === 'linear' || scaleType === 'log' || scaleType === 'time') {
					this.#channelsNeedingDataDomain.add('x');
				}
			} else if (channel === 'y' || channel === 'y1' || channel === 'y2') {
				const scaleType = scaleRequirements?.y?.type;
				if (scaleType === 'linear' || scaleType === 'log' || scaleType === 'time') {
					this.#channelsNeedingDataDomain.add('y');
				}
			} else if (channel === 'fill' || channel === 'stroke') {
				// Aggregated color fields produce continuous (numeric) values
				// These need domain discovery for continuous color scales
				this.#channelsNeedingDataDomain.add(channel);
			}
		}

		// Also add channels that transforms will generate
		if (this.#transformCompiler.hasJSTransforms()) {
			const additionalChannels = this.#transformCompiler.getAdditionalChannels();
			for (const channel of additionalChannels) {
				const baseChannel = channel.startsWith('x') ? 'x' : channel.startsWith('y') ? 'y' : null;
				if (baseChannel) {
					this.#channelsNeedingDataDomain.add(baseChannel);
				}
			}
		}

		if (this.#channelsNeedingDataDomain.size > 0) {
			console.log(
				`🔧 ${this.#markId} channels needing data-derived domain:`,
				Array.from(this.#channelsNeedingDataDomain)
			);
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
				Promise.all([this.#fetchCategoricalDomains(), this.#fetchGlobalAggregates()])
					.then(([fetchCount]) => {
						this.categoricalDataFetched = true;
						if (colorReady) this.#colorDomainFetched = true;
						this.#setScalesReady();
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

					const fieldRequests = this.#buildFieldInfoRequests();
					console.log(`[Mark ${this.#markId}] Creating DataClient for ${tableToQuery}`);
					this.#createClient(tableToQuery, fieldRequests);
					this.#currentClientTable = tableToQuery;
					this.#clientCreated = true;
				});
			}
		});

		// Effect 5: Monitor client data readiness
		$effect(() => {
			if (this.#clientCreated && this.client?.fieldInfo && !this.#clientDataReady) {
				this.#clientDataReady = true;
			}
		});

		// Effect 6: Set initial continuous domains (from fieldInfo for non-aggregated fields)
		$effect(() => {
			if (this.#clientDataReady && !this.#continuousDomainsSet) {
				this.#setInitialContinuousDomains(this.client!.fieldInfo);
				this.#continuousDomainsSet = true;
			}
		});

		// Effect 7: Register data-derived domains when data arrives
		// This handles aggregates and transforms that need domain computed from query results
		$effect(() => {
			// Watch dataVersion to ensure we only process NEW data
			const dataVersion = this.client?.dataVersion;
			if (dataVersion === undefined) return;

			const data = this.data;
			if (!data || data.length === 0) return;
			if (this.#dataDerivedDomainsSet) return; // Already done

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
			this.#registerDataDerivedDomains(data, additionalChannels, isRebinning);
		});

		// Effect 8: Mark deferred scales ready when data-derived domains are set
		// This handles linear scales with aggregates/transforms that couldn't be marked
		// ready in #setScalesReady() because their domain wasn't known yet
		$effect(() => {
			if (this.#dataDerivedDomainsSet && this.#scaleMappingsReady) {
				this.#markDeferredScalesReady();
			}
		});

		// Effect 9: Adaptive Binning & User Resolution Control
		$effect(() => {
			// IMPORTANT: Read reactive values FIRST to establish dependencies
			// Even if we early-return, Svelte needs to track these for reactivity
			const multiplier: number = this.#chartContext.binStepMultiplier ?? 1.0;
			const xDomain: number[] | undefined = this.#chartContext.xScaleState?.domain?.target;
			const yDomain: number[] | undefined = this.#chartContext.yScaleState?.domain?.target;

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

		// Effect 10: Write tooltip table when data updates (debounced)
		$effect(() => {
			if (!this.#tooltipEnabled) return;
			const data = this.data;
			if (!data || data.length === 0) return;

			untrack(() => {
				clearTimeout(this.#tooltipWriteTimeout!);
				this.#tooltipWriteTimeout = setTimeout(() => this.#writeTooltipTable(data), 300);
			});
		});

		// Effect 11: Viewport-local domain - update aggregate axis when viewport pans
		$effect(() => {
			if (!this.#config.viewportLocalDomain) return;
			if (!this.data || !this.#dataDerivedDomainsSet) return;

			// Determine which axis has bins (vs aggregates)
			const xHasBins = this.#autoBinNodes.has('x1') || this.#autoBinNodes.has('x2');
			const yHasBins = this.#autoBinNodes.has('y1') || this.#autoBinNodes.has('y2');

			// For RectYMark: X has bins, Y has aggregate → watch X TARGET, update Y
			if (xHasBins && !yHasBins) {
				const xDomain = this.#chartContext.xScaleState?.domain?.target;
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
				const yDomain = this.#chartContext.yScaleState?.domain?.target;
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

		if (scaleRequirements?.x) {
			this.#chartContext.registerScaleType(
				'x',
				scaleRequirements.x.type,
				scaleRequirements.x.priority,
				this.#markId,
				scaleRequirements.x.config || {},
				inferredScaleColumns?.x
			);
		}

		if (scaleRequirements?.y) {
			this.#chartContext.registerScaleType(
				'y',
				scaleRequirements.y.type,
				scaleRequirements.y.priority,
				this.#markId,
				scaleRequirements.y.config || {},
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

	get markId(): string {
		return this.#markId;
	}

	/**
	 * Reactive effective table name.
	 * Automatically updates when ViewManager creates the derived view.
	 */
	effectiveTable: string = $derived(viewManager.getEffectiveTable(this.#config.table));

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

		const xReady =
			this.actualXScaleType === 'band' || this.actualXScaleType === 'point'
				? this.#chartContext.xScaleState?.isReadyForGPU
				: this.#chartContext.xScaleState?.ready;

		const yReady =
			this.actualYScaleType === 'band' || this.actualYScaleType === 'point'
				? this.#chartContext.yScaleState?.isReadyForGPU
				: this.#chartContext.yScaleState?.ready;

		return xReady && yReady;
	});

	// Processed data with JS transforms applied
	data: DataAccessor | null = $derived.by(() => {
		if (!this.client?.arrowTable) return null;

		// Fast path: No JS transforms - return Arrow accessor (zero-copy)
		if (!this.#transformCompiler.hasJSTransforms()) {
			return new ArrowDataAccessor(this.client.arrowTable);
		}

		// Transform path: Arrow → Objects → Inject constants → Transform → Object accessor
		const objects = this.#arrowToObjects(this.client.arrowTable);

		// Inject constant channel values that were excluded from SQL
		const constants = this.#config.constants;
		if (constants) {
			for (const obj of objects) {
				for (const key in constants) {
					if (obj[key] === undefined) obj[key] = constants[key];
				}
			}
		}

		const transformConfig = {
			x: this.#getFieldName('x'),
			y: this.#getFieldName('y'),
			fill: this.#getFieldName('fill')
		};

		const transformed = this.#transformCompiler.applyToData(objects, transformConfig, {
			x: this.#chartContext.xScale,
			y: this.#chartContext.yScale
		});

		return new ObjectDataAccessor(transformed);
	});

	/** Facet index data (Float32Array) for GPU upload. Null when not faceted. */
	facetData: Float32Array | null = $derived.by(() => {
		if (!this.#chartContext.fx || !this.data) return null;
		const raw = this.data.getColumn('__facet');
		if (!raw) return null;
		return raw instanceof Float32Array ? raw : new Float32Array(raw as ArrayLike<number>);
	});

	#arrowToObjects(arrowTable: Table): Record<string, unknown>[] {
		const rows: Record<string, unknown>[] = [];
		const numRows: number = arrowTable.numRows;

		for (let i = 0; i < numRows; i++) {
			const row: Record<string, unknown> = {};
			for (const field of arrowTable.schema.fields) {
				const column = arrowTable.getChild(field.name);
				row[field.name] = column.get(i);
			}
			rows.push(row);
		}

		return rows;
	}

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
		if (this.actualXScaleType === 'band' || this.actualXScaleType === 'point') {
			const xScale = this.#chartContext.xScaleState;
			if (xScale?.indexColumnName && hasView) {
				const originalField = select.x;
				select.x = xScale.indexColumnName;
				console.log(`[BaseMarkSetup] Swapping x: ${originalField} → ${select.x}`);
			}
		}
		if (this.actualYScaleType === 'band' || this.actualYScaleType === 'point') {
			const yScale = this.#chartContext.yScaleState;
			if (yScale?.indexColumnName && hasView) {
				const originalField = select.y;
				select.y = yScale.indexColumnName;
				console.log(`[BaseMarkSetup] Swapping y: ${originalField} → ${select.y}`);
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
			console.log(`[BaseMarkSetup] Swapping ${colorKey}: ${originalField} → ${select[colorKey]}`);
		}

		// For faceting, include the facet index column
		const facetBandScale = this.#chartContext.facetBandScale;
		if (facetBandScale?.indexColumnName && hasView) {
			select.__facet = facetBandScale.indexColumnName;
			console.log(`[BaseMarkSetup] Adding facet column: ${select.__facet}`);
		}

		return select;
	}

	buildQuery(sourceTable: string, config: DataClientConfig, filter: unknown[]): Query {
		let select: Record<string, unknown> = config.select;

		// Resolve auto bins if we have field info
		if (this.#autoBinNodes.size > 0 && this.client?.fieldInfo) {
			select = this.#resolveAutoBins(config.select);
		}

		// Convert temporal values to float offsets from t0.
		// Must run AFTER bin resolution so expression nodes are available.
		// Raw column strings → swap to ViewManager offset column.
		// Expression nodes (bins, dateMonthDay, etc.) → inline epoch offset.
		const hasView = viewManager.hasView(this.#config.table);
		select = this.#applyTimeOffsets(select, hasView);

		const q = Query.from(sourceTable);
		const selectDef: Record<string, unknown> = {};
		const nonAggregateGroupBy: unknown[] = [];
		let hasAggregates = false;

		// Build select clause
		for (const alias in select) {
			const expr = select[alias];
			if (expr == null) continue;

			const exprNode = isNode(expr) ? expr : sqlColumn(String(expr));
			selectDef[alias] = exprNode;

			if (isAggregateExpression(exprNode)) {
				hasAggregates = true;
			} else {
				nonAggregateGroupBy.push(exprNode);
			}
		}
		q.select(selectDef);

		// Add GROUP BY if needed
		if (hasAggregates && nonAggregateGroupBy.length > 0) {
			q.groupby(nonAggregateGroupBy);
		}

		// NEW: Apply SQL transforms
		let queryWithTransforms = q;
		if (this.#transformCompiler.hasSQLTransforms()) {
			console.log('🔨 Applying SQL transforms...');
			console.log('🔨 Query BEFORE transforms:', q.toString());
			queryWithTransforms = this.#transformCompiler.applyToQuery(q);

			console.log('🔨 Query AFTER transforms:', queryWithTransforms.toString());

			// Validate query is still flat
			this.#transformCompiler.validateQuery(queryWithTransforms);
		}

		// Add filters
		const allFilters = [...filter];
		if (config._filterNulls && Array.isArray(config._filterNulls)) {
			allFilters.push(...config._filterNulls.map((col: unknown) => isNotNull(col)));
		}
		if (allFilters.length > 0) {
			queryWithTransforms = queryWithTransforms.where(and(allFilters));
		}

		// Connected topology marks (lines, areas) require strict ordering
		// Order by facet first (if faceted), then series, then dimension to ensure buffer contiguity
		if (this.#config._connectedConfig) {
			const { seriesChannel, dimensionChannel } = this.#config._connectedConfig;

			// Get column expressions for ordering
			const orderCols: unknown[] = [];

			// Facet column first — ensures all points per facet cell are contiguous
			if (select.__facet) {
				orderCols.push(isNode(select.__facet) ? select.__facet : sqlColumn(String(select.__facet)));
			}

			// Series column (optional - single-series lines don't have this)
			if (seriesChannel && select[seriesChannel]) {
				const seriesExpr = select[seriesChannel];
				orderCols.push(isNode(seriesExpr) ? seriesExpr : sqlColumn(String(seriesExpr)));
			}

			// Dimension column (required - typically x for time series)
			if (dimensionChannel && select[dimensionChannel]) {
				const dimExpr = select[dimensionChannel];
				orderCols.push(isNode(dimExpr) ? dimExpr : sqlColumn(String(dimExpr)));
			}

			if (orderCols.length > 0) {
				console.log(
					`🔗 [${this.#markId}] Connected mark ordering by:`,
					orderCols.map((c: ExprNode) => c.toString())
				);
				queryWithTransforms = queryWithTransforms.orderby(...orderCols);
			}
		}

		return queryWithTransforms;
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

				let currentDomain: number[] | null = null;

				// Get frozen binning domain for adaptive bin count
				if (scaleType === 'time' || scaleType === 'utc' || scaleType === 'linear') {
					currentDomain = this.#lastBinningDomain[axis as 'x' | 'y'];

					if (!currentDomain) {
						currentDomain = scaleState?.domain?.current;
						if (currentDomain) {
							this.#lastBinningDomain[axis as 'x' | 'y'] = [...currentDomain];
						}
					}
				}

				// Resolve bin to SQL expression (temporal bins return DATE/TIMESTAMP;
				// offset conversion is handled by the time-scale swap section downstream)
				resolved[channel] = autoBin.resolve(
					this.client!.fieldInfo!,
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

			const scaleState = this.#chartContext[`${axis}ScaleState`];
			if (!scaleState?.t0) continue;

			const t0Epoch = Math.floor(scaleState.t0.getTime() / 1000);

			for (const ch of channels) {
				if (!(ch in result)) continue;
				const val = result[ch];
				if (typeof val === 'string' && scaleState.offsetColumnName && hasView) {
					console.log(
						`[BaseMarkSetup] Swapping ${ch} (time): ${val} → ${scaleState.offsetColumnName}`
					);
					result[ch] = scaleState.offsetColumnName;
				} else if (isNode(val)) {
					console.log(`[BaseMarkSetup] Wrapping ${ch} (time expr) with epoch offset`);
					result[ch] = sql`CAST((epoch(${val}) - ${t0Epoch}) AS REAL)`;
				}
			}
		}

		return result;
	}

	#createClient(tableName: string, fieldRequests: unknown[]): void {
		if (this.client) this.client.destroy();

		this.client = new DataClient(
			tableName,
			this.#config.selection ?? null,
			{
				select: this.getSelectConfig(),
				queryBuilder: (table: string, config: DataClientConfig, filter: unknown[]) => {
					return this.buildQuery(table, config, filter);
				},
				dataFormat: 'arrow',
				name: this.#markId,
				...this.#config.clientOptions
			},
			fieldRequests
		);
		this.#coordinator.connect(this.client);

		// Register with chart context for crossfilter
		if (this.#chartContext?.registerClient) {
			// Unregister previous client if any
			this.#unregisterClient?.();
			this.#unregisterClient = this.#chartContext.registerClient(this.client);
		}
	}

	#setupScaleMappings(): void {
		this.#scaleMap = {
			x: this.#chartContext.xScaleState,
			y: this.#chartContext.yScaleState
		};

		// Register table with band/time scales for ViewManager integration
		// This must happen BEFORE categorical domain fetch so views can be created
		const table = this.#config.table;
		if (this.actualXScaleType === 'band' || this.actualXScaleType === 'point') {
			this.#chartContext.xScaleState?.registerTable?.(table);
		}
		if (this.actualYScaleType === 'band' || this.actualYScaleType === 'point') {
			this.#chartContext.yScaleState?.registerTable?.(table);
		}
		// Only register time scale tables for view column creation when the field
		// is a raw column name (string). Expression nodes (dateMonthDay, etc.) are
		// handled inline by #applyTimeOffsets and don't need a ViewManager column.
		if (this.actualXScaleType === 'time' && typeof this.#config.select.x === 'string') {
			this.#chartContext.xScaleState?.registerTable?.(table);
		}
		if (this.actualYScaleType === 'time' && typeof this.#config.select.y === 'string') {
			this.#chartContext.yScaleState?.registerTable?.(table);
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

	#buildFieldInfoRequests(): unknown[] {
		const { select, table } = this.#config;
		const requests: unknown[] = [];
		const processedFields = new Set<string>();

		for (const alias in select) {
			const fieldValue = select[alias];
			if (fieldValue == null) continue;

			// NEW: Handle AutoBinNodes
			if (isBinExpression(fieldValue)) {
				const stats = fieldValue.stats;
				if (!processedFields.has(stats.column)) {
					requests.push({ table, column: stats.column, stats: stats.stats });
					processedFields.add(stats.column);
				}
				continue;
			}

			// Handle regular fields
			if (processedFields.has(String(fieldValue))) continue;

			const exprNode = isNode(fieldValue) ? fieldValue : sqlColumn(String(fieldValue));
			if (isAggregateExpression(exprNode)) continue;

			const scaleType =
				alias === 'x' || alias === 'x1' || alias === 'x2'
					? this.actualXScaleType
					: alias === 'y' || alias === 'y1' || alias === 'y2'
						? this.actualYScaleType
						: null;

			// Time scales get their domain from sidecar query in #fetchCategoricalDomains,
			// not from fieldInfo (which would return values from the offset column)
			if (scaleType === 'linear' || scaleType === 'log') {
				requests.push({ table, column: exprNode, stats: ['min', 'max'] });
				processedFields.add(String(fieldValue));
			}
		}

		return requests;
	}

	#setInitialContinuousDomains(fieldInfo: Record<string, FieldInfoEntry> | null): void {
		if (!fieldInfo) return;

		for (const alias in this.#scaleMap) {
			const scaleState = this.#scaleMap[alias];
			if (!scaleState) continue;

			const scaleType = alias === 'x' ? this.actualXScaleType : this.actualYScaleType;

			// Time scales get their domain from sidecar query, skip fieldInfo path
			if (scaleType === 'linear' || scaleType === 'log') {
				const select = this.#config.select;
				// Try direct alias first, then extent variants (x1/x2, y1/y2)
				const candidates = [select[alias], select[`${alias}1`], select[`${alias}2`]].filter(
					(f) => f != null && !isBinExpression(f)
				);

				if (candidates.length === 0) continue;

				// Compute combined min/max across all extent fields for this axis
				let combinedMin = Infinity;
				let combinedMax = -Infinity;
				let found = false;

				for (const fieldValue of candidates) {
					const infoKey = String(fieldValue).replace(/^["']|["']$/g, '');
					const info = fieldInfo[infoKey];
					if (info && info.min != null && info.max != null) {
						combinedMin = Math.min(combinedMin, info.min);
						combinedMax = Math.max(combinedMax, info.max);
						found = true;
					}
				}

				if (found) {
					console.log(
						`📐 [${this.#markId}] Domain ${alias}: fieldInfo path → [${combinedMin}, ${combinedMax}]`
					);
					(scaleState as LinearScaleState).addMark([combinedMin, combinedMax], this.#markId);
				}
			}
		}
	}

	/**
	 * Register domains from query result data for channels that need data-derived domains.
	 * This handles both:
	 * - Regular aggregate channels (count, sum, etc.)
	 * - Transform-generated channels (x0/x1, y0/y1 from stack)
	 */
	#registerDataDerivedDomains(
		data: DataAccessor,
		additionalChannels: string[] = [],
		isRebinning: boolean = false
	): void {
		if (!data || data.length === 0) return;

		// Skip if no channels need data-derived domains
		if (this.#channelsNeedingDataDomain.size === 0 && additionalChannels.length === 0) {
			this.#dataDerivedDomainsSet = true;
			return;
		}

		// Build list of channels to examine for each axis
		const xChannelsToCheck: string[] = [];
		const yChannelsToCheck: string[] = [];

		// Add base channels that need data-derived domains
		if (this.#channelsNeedingDataDomain.has('x')) {
			// Check for x, x1, x2 variants in the data
			xChannelsToCheck.push('x', 'x1', 'x2');
		}
		if (this.#channelsNeedingDataDomain.has('y')) {
			yChannelsToCheck.push('y', 'y1', 'y2');
		}

		// Add transform-generated channels
		for (const channel of additionalChannels) {
			if (channel.startsWith('x')) {
				xChannelsToCheck.push(channel);
			} else if (channel.startsWith('y')) {
				yChannelsToCheck.push(channel);
			}
		}

		// Compute and register X domain
		// Skip if this axis triggered the re-bin (user zoomed here, don't override)
		if (
			this.#skipDomainUpdateForAxis !== 'x' &&
			xChannelsToCheck.length > 0 &&
			(this.actualXScaleType === 'linear' || this.actualXScaleType === 'time')
		) {
			// For viewport-local domains, filter to visible Y range
			let filterOptions: ExtentFilterOptions = {};
			if (this.#config.viewportLocalDomain && this.actualYScaleType !== 'band') {
				const yDomain = this.#chartContext.yScaleState?.domain?.current;
				if (yDomain) {
					filterOptions = { filterAxis: 'y', filterDomain: yDomain };
					console.log(
						`🔍 [${this.#markId}] Computing X domain from viewport-local data (Y: [${yDomain[0].toFixed(1)}, ${yDomain[1].toFixed(1)}])`
					);
				}
			}

			let extent = this.#computeExtentFromData(data, xChannelsToCheck, filterOptions);
			if (extent) {
				// Apply zero baseline if mark requests it
				if (this.#config.zeroBaseline?.x) {
					extent = [Math.min(0, extent[0]), Math.max(0, extent[1])];
				}

				const scaleState = this.#chartContext.xScaleState;

				// Use instant domain update when rebinning to avoid confusing grow/shrink effect
				// Keep spring animation for viewport panning (smooth bin entry/exit)
				if (this.actualXScaleType === 'time' && scaleState?.addOffsetExtent) {
					// Time scale: data is in offset form, use addOffsetExtent
					console.log(
						`📊 [${this.#markId}] Registering X domain from data (time offsets):`,
						extent
					);
					scaleState.addOffsetExtent(extent, this.#markId);
				} else if (scaleState?.addMark) {
					// Linear scale: use addMark with instant flag when rebinning
					if (isRebinning) {
						console.log(`⚡ [${this.#markId}] Instant X domain update (rebinning):`, extent);
					} else {
						console.log(`📊 [${this.#markId}] Registering X domain from data:`, extent);
					}
					scaleState.addMark(extent, this.#markId, { instant: isRebinning });
				}
			}
		}

		// Compute and register Y domain
		// Skip if this axis triggered the re-bin (user zoomed here, don't override)
		if (
			this.#skipDomainUpdateForAxis !== 'y' &&
			yChannelsToCheck.length > 0 &&
			(this.actualYScaleType === 'linear' || this.actualYScaleType === 'time')
		) {
			// For viewport-local domains, filter to visible X range
			let filterOptions: ExtentFilterOptions = {};
			if (this.#config.viewportLocalDomain && this.actualXScaleType !== 'band') {
				const xDomain = this.#chartContext.xScaleState?.domain?.current;
				if (xDomain) {
					filterOptions = { filterAxis: 'x', filterDomain: xDomain };
					console.log(
						`🔍 [${this.#markId}] Computing Y domain from viewport-local data (X: [${xDomain[0].toFixed(1)}, ${xDomain[1].toFixed(1)}])`
					);
				}
			}

			let extent = this.#computeExtentFromData(data, yChannelsToCheck, filterOptions);
			if (extent) {
				// Apply zero baseline if mark requests it
				if (this.#config.zeroBaseline?.y) {
					extent = [Math.min(0, extent[0]), Math.max(0, extent[1])];
				}

				const scaleState = this.#chartContext.yScaleState;

				// Use instant domain update when rebinning to avoid confusing grow/shrink effect
				// Keep spring animation for viewport panning (smooth bin entry/exit)
				if (this.actualYScaleType === 'time' && scaleState?.addOffsetExtent) {
					// Time scale: data is in offset form, use addOffsetExtent
					console.log(
						`📊 [${this.#markId}] Registering Y domain from data (time offsets):`,
						extent
					);
					scaleState.addOffsetExtent(extent, this.#markId);
				} else if (scaleState?.addMark) {
					// Linear scale: use addMark with instant flag when rebinning
					if (isRebinning) {
						console.log(`⚡ [${this.#markId}] Instant Y domain update (rebinning):`, extent);
					} else {
						console.log(`📊 [${this.#markId}] Registering Y domain from data:`, extent);
					}
					scaleState.addMark(extent, this.#markId, { instant: isRebinning });
				}
			}
		}

		// Clear the skip flag after processing
		this.#skipDomainUpdateForAxis = null;

		this.#dataDerivedDomainsSet = true;
	}

	/**
	 * Compute min/max extent from data for given channels.
	 * Works with both DataAccessor (Arrow) and plain object arrays.
	 */
	#computeExtentFromData(
		data: DataAccessor | Record<string, unknown>[],
		channels: string[],
		options: ExtentFilterOptions = {}
	): [number, number] | null {
		const { filterAxis, filterDomain } = options;

		let min = Infinity;
		let max = -Infinity;

		const isAccessor = typeof (data as DataAccessor).getColumn === 'function';

		// Performance guard: skip viewport filtering for large datasets
		const dataLength = (data as DataAccessor).length;
		const shouldFilter = filterAxis && filterDomain && dataLength < 10000;

		if (isAccessor) {
			const accessor = data as DataAccessor;
			// DataAccessor path - use getColumn for efficiency
			// Get filter columns if needed
			let filterCol1: ArrayLike<unknown> | null = null;
			let filterCol2: ArrayLike<unknown> | null = null;
			if (shouldFilter) {
				filterCol1 = accessor.getColumn(`${filterAxis}1`);
				filterCol2 = accessor.getColumn(`${filterAxis}2`);
			}

			for (const channel of channels) {
				const column = accessor.getColumn(channel);
				if (!column) continue;

				for (let i = 0; i < column.length; i++) {
					// Viewport filtering: skip rows outside viewport
					if (shouldFilter && filterCol1 && filterCol2) {
						const v1 = filterCol1[i] as number;
						const v2 = filterCol2[i] as number;
						// Check if bin [v1, v2] intersects viewport [filterDomain[0], filterDomain[1]]
						if (v2 < filterDomain![0] || v1 > filterDomain![1]) {
							continue; // Outside viewport
						}
					}

					const value = column[i];
					if (typeof value === 'number' && !isNaN(value)) {
						if (value < min) min = value;
						if (value > max) max = value;
					}
				}
			}
		} else {
			// Plain array path
			for (const row of data as Record<string, unknown>[]) {
				// Viewport filtering: skip rows outside viewport
				if (shouldFilter) {
					const v1 = row[`${filterAxis}1`] as number;
					const v2 = row[`${filterAxis}2`] as number;
					// Check if bin [v1, v2] intersects viewport
					if (v2 < filterDomain![0] || v1 > filterDomain![1]) {
						continue; // Outside viewport
					}
				}

				for (const channel of channels) {
					const value = row[channel];
					if (typeof value === 'number' && !isNaN(value)) {
						if (value < min) min = value;
						if (value > max) max = value;
					}
				}
			}
		}

		if (min === Infinity || max === -Infinity) return null;
		return [min, max];
	}

	async #fetchCategoricalDomains(): Promise<number> {
		const { table, selection, sort } = this.#config;
		if (!this.#coordinator || !table) return 0;

		const fetches: Promise<void>[] = [];

		const setupFetch = (axis: string, field: unknown): void => {
			if (!field) return;
			const scaleState = this.#chartContext[`${axis}ScaleState`];
			let q = Query.from(table).select({ [axis]: sqlColumn(String(field)) });

			const sortConfig = sort;
			// Resolve the sort channel to a select key. Point-based marks (Dots, Lines)
			// have direct 'x'/'y' keys, but extent-based marks (Bars, Rects, Areas) use
			// 'x1'/'x2'/'y1'/'y2'. Fall back to channel+'2' then channel+'1' for those.
			const sortField = sortConfig
				? this.#config.select[sortConfig.channel] ||
					this.#config.select[sortConfig.channel + '2'] ||
					this.#config.select[sortConfig.channel + '1']
				: null;
			if (sortField) {
				if (isAggregateExpression(sortField)) {
					// Aggregate: GROUP BY band field, SELECT aggregate, ORDER BY it
					q = q.groupby(field).select({ _sort: sortField });
					if (sortConfig!.direction === 'desc') {
						q.orderby(sql`${sqlColumn('_sort')} DESC`);
					} else {
						q.orderby(sqlColumn('_sort'));
					}
				} else {
					// Raw field or expression: ORDER BY directly
					const sortExpr = isNode(sortField) ? sortField : sqlColumn(String(sortField));
					if (sortConfig!.direction === 'desc') {
						q.orderby(sql`${sortExpr} DESC`);
					} else {
						q.orderby(sortExpr);
					}
				}
			} else {
				q.distinct();
			}

			fetches.push(
				this.#coordinator.query(q).then((result) => {
					const categories = Array.from(result).map((row) => row[axis]);
					// Y band scale maps index 0 → bottom, index N → top (bottom-to-top),
					// but users read top-to-bottom. Reverse so SQL sort order matches
					// the visual reading direction (e.g. 'desc' → largest at top).
					if (axis === 'y' && sortField) {
						categories.reverse();
					}
					if (categories.length > 0) {
						scaleState.addMark(categories, this.#markId, { sorted: !!sortField });
					}
				})
			);
		};

		if (this.actualXScaleType === 'band' || this.actualXScaleType === 'point') {
			setupFetch('x', this.#config.select.x);
		}
		if (this.actualYScaleType === 'band' || this.actualYScaleType === 'point') {
			setupFetch('y', this.#config.select.y);
		}

		// Facet: register categories with the facet BandScaleState
		const facetBandScale = this.#chartContext.facetBandScale;
		const fxField = this.#chartContext.fx;
		if (facetBandScale && fxField) {
			const fxExpr = isNode(fxField) ? fxField : sqlColumn(String(fxField));
			const q = Query.from(table).select({ fx: fxExpr }).distinct();
			fetches.push(
				this.#coordinator.query(q).then((result) => {
					const categories = Array.from(result).map((row) => row.fx);
					if (categories.length > 0) {
						facetBandScale.addMark(categories, this.#markId);
					}
				})
			);
		}

		// Time scale sidecar queries: fetch MIN/MAX datetime for t0 computation
		const setupTimeFetch = (axis: string, field: unknown): void => {
			if (!field) return;
			const scaleState = this.#chartContext[`${axis}ScaleState`];
			if (!scaleState?.addDatetimeExtent) return;

			// Unwrap AutoBinNode to get the underlying column name
			// For bins: fetch raw column min/max to establish t0, then actual bin
			// boundaries from query results will update the extent later
			const rawField = isBinExpression(field) ? field.field : field;

			// Ensure we have a valid string or SQL node
			const colExpr = isNode(rawField) ? rawField : sqlColumn(String(rawField));

			const q = Query.from(table).select({
				min_time: min(colExpr),
				max_time: max(colExpr)
			});

			fetches.push(
				this.#coordinator.query(q).then((result) => {
					const row = Array.from(result)[0];
					if (row && row.min_time != null && row.max_time != null) {
						console.log(`[BaseMarkSetup] Time extent for ${axis}:`, [row.min_time, row.max_time]);
						scaleState.addDatetimeExtent([row.min_time, row.max_time], this.#markId);
					}
				})
			);
		};

		if (this.actualXScaleType === 'time') {
			// Check x1 if x is missing (standard pattern for Rect/Rule marks)
			setupTimeFetch('x', this.#config.select.x || this.#config.select.x1);
		}
		if (this.actualYScaleType === 'time') {
			setupTimeFetch('y', this.#config.select.y || this.#config.select.y1);
		}

		// Fetch color domain if color scale is set and there's a color field
		const colorKey = this.#config.colorChannel || 'fill';
		if (this.#colorScaleState && this.#config.select[colorKey]) {
			// Extract field from color config (handles object format { field: "x", scheme: "y" })
			const colorValue = this.#config.select[colorKey];
			const colorField =
				typeof colorValue === 'object' && 'field' in colorValue && !isNode(colorValue)
					? (colorValue as { field: string }).field
					: colorValue;

			// Skip if color is an aggregate expression (handled by sidecar query)
			const isAggregate = isNode(colorField) && isAggregateExpression(colorField);

			if (!isAggregate) {
				if (this.#colorScaleState.isOrdinal) {
					// Ordinal: fetch distinct categories
					const colExpr = isNode(colorField) ? colorField : sqlColumn(String(colorField));
					const q = Query.from(table).select({ color: colExpr }).distinct();

					fetches.push(
						this.#coordinator.query(q).then((result) => {
							const categories = Array.from(result).map((row) => row.color);
							if (categories.length > 0) {
								console.log(`[BaseMarkSetup] Color domain (ordinal):`, categories);
								this.#colorScaleState!.setDomain(categories as (string | number)[]);
							}
						})
					);
				} else {
					// Sequential: fetch min/max extent
					const colExpr = isNode(colorField) ? colorField : sqlColumn(String(colorField));
					const q = Query.from(table).select({
						min_color: min(colExpr),
						max_color: max(colExpr)
					});

					fetches.push(
						this.#coordinator.query(q).then((result) => {
							const row = Array.from(result)[0];
							if (row && row.min_color != null && row.max_color != null) {
								console.log(`[BaseMarkSetup] Color domain (sequential):`, [
									row.min_color,
									row.max_color
								]);
								this.#colorScaleState!.setDomain([row.min_color, row.max_color] as (
									| string
									| number
								)[]);
							}
						})
					);
				}
			}
		}

		// Fetch size domain if size scale is set and there's a size field
		const sizeKey = this.#config.sizeChannel || 'r';
		if (this.#sizeScaleState && this.#config.select[sizeKey]) {
			const sizeField = this.#config.select[sizeKey];
			const q = Query.from(table).select({
				min_radius: min(sqlColumn(String(sizeField))),
				max_radius: max(sqlColumn(String(sizeField)))
			});

			fetches.push(
				this.#coordinator.query(q).then((result) => {
					const row = Array.from(result)[0];
					if (row && row.min_radius != null && row.max_radius != null) {
						this.#sizeScaleState!.setDomain([row.min_radius as number, row.max_radius as number]);
					}
				})
			);
		}

		// Fetch series domain if series scale is set and there's a series field
		const seriesKey = this.#config._connectedConfig?.seriesChannel;
		if (this.#seriesScaleState && seriesKey && this.#config.select[seriesKey]) {
			const seriesField = this.#config.select[seriesKey];
			const q = Query.from(table)
				.select({ series: sqlColumn(String(seriesField)) })
				.distinct();

			fetches.push(
				this.#coordinator.query(q).then((result) => {
					const categories = Array.from(result).map((row) => row.series);
					if (categories.length > 0) {
						this.#seriesScaleState!.setDomain(categories as (string | number)[]);
					}
				})
			);
		}

		if (fetches.length > 0) await Promise.all(fetches);
		return fetches.length; // Return count for logging
	}

	/**
	 * Fetch global min/max extents for aggregated fields using a "sidecar" query.
	 * This runs the same aggregation logic as the main query but without filters,
	 * wrapped in an outer aggregation to get min/max of the results.
	 */
	async #fetchGlobalAggregates(): Promise<void> {
		const { table } = this.#config;
		if (!this.#coordinator || !table) return;

		// Only proceed if we have channels needing data-derived domains
		if (this.#channelsNeedingDataDomain.size === 0) {
			console.log(`[${this.#markId}] No aggregated channels, skipping sidecar query`);
			return;
		}

		// Skip sidecar when AutoBinNodes exist — they can't be resolved to SQL
		// until fieldInfo is available (which requires the DataClient created later).
		// Domains will be set from query results via #registerDataDerivedDomains.
		if (this.#autoBinNodes.size > 0) {
			console.log(`[${this.#markId}] Skipping sidecar: bin domains derived from query results`);
			return;
		}

		console.log(
			`🔍 [${this.#markId}] Building sidecar query for channels:`,
			Array.from(this.#channelsNeedingDataDomain)
		);

		try {
			// Step 1: Build the inner query using the same query builder (no filter)
			const innerQuery = this.buildQuery(table, this.#config, []);

			console.log(`📊 [${this.#markId}] Inner query SQL:`, innerQuery.toString());

			// Step 2: Build outer aggregation to get min/max of each channel
			const outerSelect: Record<string, unknown> = {};

			if (this.#channelsNeedingDataDomain.has('x')) {
				const select = this.#config.select;
				if ('x' in select) {
					outerSelect.min_x = min('x');
					outerSelect.max_x = max('x');
				} else {
					// Extent channels: use x1 for min, x2 for max
					if ('x1' in select) outerSelect.min_x = min('x1');
					if ('x2' in select) outerSelect.max_x = max('x2');
				}
			}

			if (this.#channelsNeedingDataDomain.has('y')) {
				const select = this.#config.select;
				if ('y' in select) {
					outerSelect.min_y = min('y');
					outerSelect.max_y = max('y');
				} else {
					// Extent channels: use y1 for min, y2 for max
					if ('y1' in select) outerSelect.min_y = min('y1');
					if ('y2' in select) outerSelect.max_y = max('y2');
				}
			}

			// Color channel domain discovery (fill or stroke key)
			const colorChannel = this.#channelsNeedingDataDomain.has('fill')
				? 'fill'
				: this.#channelsNeedingDataDomain.has('stroke')
					? 'stroke'
					: null;
			if (colorChannel) {
				outerSelect.min_color = min(colorChannel);
				outerSelect.max_color = max(colorChannel);
			}

			// Skip if no aggregation expressions were generated (e.g., all channels are constants)
			if (Object.keys(outerSelect).length === 0) {
				console.log(`📊 [${this.#markId}] Skipping sidecar: no SQL channels to aggregate`);
				return;
			}

			const sidecarQuery = Query.from(innerQuery).select(outerSelect);

			console.log(`📊 [${this.#markId}] Sidecar query SQL:`, sidecarQuery.toString());

			// Step 3: Execute the query
			const result = await this.#coordinator.query(sidecarQuery);
			const extents: Record<string, unknown> = Array.from(result)[0]; // Should be single row

			console.log(`✅ [${this.#markId}] Sidecar results:`, extents);

			// Step 4: Apply extents to scales
			if (
				this.#channelsNeedingDataDomain.has('x') &&
				extents.min_x != null &&
				extents.max_x != null
			) {
				const xExtent = [extents.min_x, extents.max_x];
				console.log(`📊 [${this.#markId}] Applying X extent from sidecar:`, xExtent);
				this.#chartContext.xScaleState?.addMark(xExtent, this.#markId);
			}

			if (
				this.#channelsNeedingDataDomain.has('y') &&
				extents.min_y != null &&
				extents.max_y != null
			) {
				const yExtent = [extents.min_y, extents.max_y];
				console.log(`📊 [${this.#markId}] Applying Y extent from sidecar:`, yExtent);
				this.#chartContext.yScaleState?.addMark(yExtent, this.#markId);
			}

			if (
				(this.#channelsNeedingDataDomain.has('fill') ||
					this.#channelsNeedingDataDomain.has('stroke')) &&
				extents.min_color != null &&
				extents.max_color != null
			) {
				const colorExtent = [extents.min_color, extents.max_color];
				console.log(`📊 [${this.#markId}] Applying color extent from sidecar:`, colorExtent);
				this.#colorScaleState?.setDomain(colorExtent as (string | number)[]);
			}

			// Mark that global aggregates have been set
			this.#globalAggregatesSet = true;
		} catch (error) {
			console.error(`❌ [${this.#markId}] Sidecar query failed:`, error);
			// Don't set flag on failure - will fall back to data-derived domains
		}
	}

	/**
	 * Mark scales as ready, but be selective:
	 * - Band/categorical scales: mark ready immediately (domain from categorical fetch)
	 * - Linear scales without data-derived domains: mark ready immediately (domain from fieldInfo)
	 * - Linear scales WITH data-derived domains: mark ready if sidecar OR data-scan has set domain
	 */
	#setScalesReady(): void {
		for (const [axis, scale] of Object.entries(this.#scaleMap)) {
			if (!scale) continue;

			const scaleType = axis === 'x' ? this.actualXScaleType : this.actualYScaleType;
			const needsDataDomain = this.#channelsNeedingDataDomain.has(axis);

			// For categorical scales (band/point) and time scales, mark ready immediately
			// (their domains are set by sidecar queries in #fetchCategoricalDomains)
			if (scaleType === 'band' || scaleType === 'point' || scaleType === 'time') {
				scale.setReady();
				continue;
			}

			// For linear scales, only mark ready if they don't need data-derived domain
			// OR if domains have been set (either via sidecar query OR data-scan fallback)
			const domainsReady = this.#globalAggregatesSet || this.#dataDerivedDomainsSet;
			if (!needsDataDomain || domainsReady) {
				scale.setReady();
			} else {
				console.log(`⏳ [${this.#markId}] Deferring ${axis} scale ready - waiting for domain`);
			}
		}
	}

	/**
	 * Mark linear scales ready after data-derived domains have been set.
	 * Called from an effect that watches #dataDerivedDomainsSet.
	 */
	#markDeferredScalesReady(): void {
		for (const [axis, scale] of Object.entries(this.#scaleMap)) {
			if (!scale) continue;

			const scaleType = axis === 'x' ? this.actualXScaleType : this.actualYScaleType;
			const needsDataDomain = this.#channelsNeedingDataDomain.has(axis);

			// Only mark linear scales that were waiting for data-derived domains
			if (
				needsDataDomain &&
				(scaleType === 'linear' || scaleType === 'log' || scaleType === 'time')
			) {
				if (!scale.ready) {
					console.log(`✅ [${this.#markId}] Marking ${axis} scale ready (data-derived domain set)`);
					scale.setReady();
				}
			}
		}
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
			if (scaleType !== 'linear' && scaleType !== 'time') return;

			// Determine which axis is binned (opposite of aggregate)
			const binnedAxis = aggregateAxis === 'x' ? 'y' : 'x';

			// Build channel list for aggregate axis
			const channels = aggregateAxis === 'x' ? ['x', 'x1', 'x2'] : ['y', 'y1', 'y2'];

			// Compute extent with viewport filtering
			const filterOptions: ExtentFilterOptions = {
				filterAxis: binnedAxis,
				filterDomain: viewportDomain as [number, number]
			};

			let extent = this.#computeExtentFromData(this.data, channels, filterOptions);
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
		return this.#tooltipEnabled;
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

				const tooltipQuery = this.buildQuery(
					this.effectiveTable,
					{ select: selectConfig, _filterNulls: this.#config._filterNulls },
					filter
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

				// Infer schema from first row
				const schemaDef = columns
					.map((col) => {
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
		} catch (error) {
			console.error(`Failed to write tooltip table "${tableName}":`, error);
		}
	}

	destroy(): void {
		console.log(`💥 BaseMarkSetup destroying for ${this.#markId}`);

		clearTimeout(this.#rebinTimeout!);
		clearTimeout(this.#viewportDomainUpdateTimeout!);
		clearTimeout(this.#tooltipWriteTimeout!);

		// Drop tooltip temp table
		if (this.#tooltipEnabled && this.#coordinator) {
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
