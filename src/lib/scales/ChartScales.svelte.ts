// src/lib/scales/ChartScales.svelte.ts
import { untrack } from 'svelte';
import type { EntranceGate } from '$lib/animation/EntranceGate';
import { resolveScaleConfiguration, SCALE_PRIORITIES } from './ScalePriorities';
import type { RegisteredScaleRequirement, ResolvedScaleConfiguration } from './ScalePriorities';
import type { ScaleRegistry } from './ScaleRegistry.svelte';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import { ParallelAxisReorder } from './ParallelAxisReorder.svelte';
import type { ChartLayout } from '$lib/layout/ChartLayout.svelte';
import type {
	ScaleStateInstance,
	ContinuousScaleState,
	D3Scale,
	D3BandScale,
	FieldRef
} from '$lib/types';
import { isBinExpression } from '$lib/sql/bin';
import { isContinuousScale } from '$lib/scales/scale-categories';
import { LinearScaleState } from '$lib/scales/LinearScaleState.svelte';

/** Type guard: narrows ScaleStateInstance to ContinuousScaleState via supportsPanZoom. */
function isPanZoomScale(inst: ScaleStateInstance | null): inst is ContinuousScaleState {
	return !!inst?.supportsPanZoom;
}

interface PanContext {
	initialScreenPos: number;
	initialDomain: number[];
	screenToDataRatio: number;
	domainWidth: number;
	screenDimension: number;
	axis: 'x' | 'y';
	lastScreenPos: number;
}

/**
 * Adapter that registers axis position springs with GPUCoordinator's animation loop.
 * Implements the ScaleInstance interface so the existing 360Hz physics step drives the springs.
 */
interface ChartScalesConfig {
	gpuCoordinator: GPUCoordinator;
	scaleRegistry: ScaleRegistry;
	layout: ChartLayout;
	xLabel?: string | null;
	yLabel?: string | null;
	getFacetChartIds?: (() => string[]) | null;
	xZoomLimit?: number;
	yZoomLimit?: number;
	xPanLimit?: number;
	yPanLimit?: number;
	xDisableZoom?: boolean;
	yDisableZoom?: boolean;
	useXSelection?: boolean;
	useYSelection?: boolean;
	/** The chart's entrance gate: its scales snap, and show no ticks, until it opens. */
	entranceGate?: EntranceGate | null;
}

export class ChartScales {
	#scaleRegistry: ScaleRegistry;
	scaleRequirements = $state<{ x: RegisteredScaleRequirement[]; y: RegisteredScaleRequirement[] }>({
		x: [],
		y: []
	});

	#xScaleInstance = $state<ScaleStateInstance | null>(null);
	#yScaleInstance = $state<ScaleStateInstance | null>(null);

	// --- PARALLEL COORDINATES SCALES ---
	// Each parallel mark's columns, in its order. The axes are their union.
	#parallelColumnsByMark = new Map<string, string[]>();
	#parallelScaleInstances = $state(new Map<string, LinearScaleState>());
	#parallelAxisOrder = $state<number[]>([]);

	// Lazily instantiated when parallel columns are registered
	#reorder: ParallelAxisReorder | null = null;

	active = $state(false);

	// --- MEMORY POOLS ---
	_xPanContext: PanContext = {
		initialScreenPos: 0,
		initialDomain: [0, 0],
		screenToDataRatio: 0,
		domainWidth: 0,
		screenDimension: 0,
		axis: 'x',
		lastScreenPos: 0
	};

	_yPanContext: PanContext = {
		initialScreenPos: 0,
		initialDomain: [0, 0],
		screenToDataRatio: 0,
		domainWidth: 0,
		screenDimension: 0,
		axis: 'y',
		lastScreenPos: 0
	};

	binStepMultiplier = $state(1.0);

	config: ChartScalesConfig;
	gpuCoordinator: GPUCoordinator;
	activePanX = false;
	activePanY = false;

	#getFacetChartIds: (() => string[]) | null;

	constructor(config: ChartScalesConfig) {
		this.config = config;
		this.gpuCoordinator = config.gpuCoordinator;
		this.#scaleRegistry = config.scaleRegistry;
		this.#getFacetChartIds = config.getFacetChartIds ?? null;
		this.#entranceGateOff = config.entranceGate?.onOpen(() => this.#markScalesEntered()) ?? null;

		if (!this.#scaleRegistry) {
			console.error('ChartScales initialized without scaleRegistry!');
		}

		// Effect: Update scale instances when requirements or labels change.
		// Scale resolution also runs eagerly from registerScaleType() so that
		// MarkLifecycle effects always see the correct scale instances.
		$effect(() => {
			// Read reactive inputs to establish dependency tracking
			this.xLabel;
			this.yLabel;
			this.scaleConfigurations;

			this.#resolveScaleInstances();

			// Register facets — reuses the same scale instances resolved above
			const facetIds = this.#getFacetChartIds?.();
			if (facetIds && this.#xScaleInstance && this.#yScaleInstance) {
				const xConfig = this.scaleConfigurations.x;
				const yConfig = this.scaleConfigurations.y;
				if (xConfig && yConfig) {
					const xKey = this.xLabel || xConfig.columnName || 'x';
					const yKey = this.yLabel || yConfig.columnName || 'y';
					const xScaleConfig = this.#buildAxisScaleConfig(xConfig);
					const yScaleConfig = this.#buildAxisScaleConfig(yConfig);
					if (this.config.useXSelection) xScaleConfig.__selectionConsumer = this.chartId;
					if (this.config.useYSelection) yScaleConfig.__selectionConsumer = this.chartId;
					for (const cellId of facetIds) {
						this.#scaleRegistry.getOrCreateScale(xKey, xConfig.type, xScaleConfig, cellId);
						this.#scaleRegistry.getOrCreateScale(yKey, yConfig.type, yScaleConfig, cellId);
					}
				}
			}

			// Apply zoom/pan limits and disable flags
			{
				const xInst = this.#xScaleInstance;
				const yInst = this.#yScaleInstance;
				if (this.config.xZoomLimit !== undefined && isPanZoomScale(xInst)) {
					xInst.setZoomLimit(this.config.xZoomLimit);
				}
				if (this.config.yZoomLimit !== undefined && isPanZoomScale(yInst)) {
					yInst.setZoomLimit(this.config.yZoomLimit);
				}
				if (this.config.xPanLimit !== undefined && isPanZoomScale(xInst)) {
					xInst.setPanLimit(this.config.xPanLimit);
				}
				if (this.config.yPanLimit !== undefined && isPanZoomScale(yInst)) {
					yInst.setPanLimit(this.config.yPanLimit);
				}
				if (this.config.xDisableZoom && isPanZoomScale(xInst)) {
					xInst.disableZoom = true;
				}
				if (this.config.yDisableZoom && isPanZoomScale(yInst)) {
					yInst.disableZoom = true;
				}
			}
		});

		// Effect: Notify GPU coordinator of scale mapping changes
		$effect(() => {
			const xScale = this.#xScaleInstance;
			const yScale = this.#yScaleInstance;

			if (xScale?.id && yScale?.id && this.gpuCoordinator) {
				const mapping = { xScaleId: xScale.id, yScaleId: yScale.id };
				const trySetMapping = () => {
					try {
						this.gpuCoordinator.setChartScaleMapping(this.chartId, mapping);
						const facetIds = this.#getFacetChartIds?.();
						if (facetIds) {
							for (const cellId of facetIds) {
								this.gpuCoordinator.setChartScaleMapping(cellId, mapping);
							}
						}
					} catch (_error) {
						setTimeout(trySetMapping, 10);
					}
				};
				trySetMapping();
			}
		});

		// Effect: Drive rendering scale domain from source scale's selectionExtent
		// (forward direction: brush on overview → detail domain)
		this.#setupSelectionLink('x');
		this.#setupSelectionLink('y');
	}

	/**
	 * Set up bidirectional selection-linking for one axis.
	 * - Effect A (forward): source.selectionExtent → render.setExternalDomain()
	 * - Effect B (backward): render.domain.target → source.setSelectionExtent('external')
	 *
	 * Critical: each effect must only track its *input* signal reactively.
	 * The comparison value (used for loop-prevention guards) is read inside
	 * untrack() so it doesn't create a spurious dependency that would cause
	 * the effects to fight each other during detail pan/zoom.
	 */
	#setupSelectionLink(axis: 'x' | 'y'): void {
		const useSelection = axis === 'x' ? this.config.useXSelection : this.config.useYSelection;
		if (!useSelection) return;

		// Helper: find the source (overview) scale by direct key lookup.
		// The source scale's config is #buildAxisScaleConfig() WITHOUT the
		// __selectionConsumer / __fitDomain discriminators that consumer
		// charts add. Direct lookup is O(1) and immune to bucket iteration
		// order (which caused bugs when multiple consumers shared a name).
		const findSourceScale = (): LinearScaleState | null => {
			const config = axis === 'x' ? this.scaleConfigurations?.x : this.scaleConfigurations?.y;
			if (!config) return null;
			const label = axis === 'x' ? this.xLabel : this.yLabel;
			const name = label || config.columnName || axis;
			const sourceConfig = this.#buildAxisScaleConfig(config);
			const scale = this.#scaleRegistry.findScale(name, config.type, sourceConfig);
			if (scale instanceof LinearScaleState) return scale;
			return null;
		};

		// Effect A (forward): source.selectionExtent → render scale domain
		// Tracks: sourceScale.selectionExtent (the input signal)
		// Untracks: renderInst.domain.target (comparison-only, not a trigger)
		$effect(() => {
			const renderInst = axis === 'x' ? this.#xScaleInstance : this.#yScaleInstance;
			if (!renderInst || !(renderInst instanceof LinearScaleState)) return;

			const sourceScale = findSourceScale();
			if (!sourceScale || sourceScale === renderInst) return;

			const extent = sourceScale.selectionExtent; // reactive trigger
			if (extent) {
				const [targetMin, targetMax] = untrack(() => renderInst.domain.target);
				if (extent[0] !== targetMin || extent[1] !== targetMax) {
					untrack(() => renderInst.setExternalDomain(extent[0], extent[1]));
				}
			} else {
				untrack(() => renderInst.clearExternalDomain());
			}
		});

		// Effect B (backward): render scale domain.target → source.selectionExtent
		// Tracks: renderInst.domain.target (the input signal)
		// Untracks: sourceScale.selectionExtent (comparison-only, not a trigger)
		$effect(() => {
			const renderInst = axis === 'x' ? this.#xScaleInstance : this.#yScaleInstance;
			if (!renderInst || !(renderInst instanceof LinearScaleState)) return;

			const sourceScale = findSourceScale();
			if (!sourceScale || sourceScale === renderInst) return;

			const [targetMin, targetMax] = renderInst.domain.target; // reactive trigger

			// If detail is at full data extent, clear the selection (removes brush)
			const [extMin, extMax] = untrack(() => renderInst.effectiveExtent);
			if (targetMin === extMin && targetMax === extMax) {
				untrack(() => sourceScale.clearSelectionExtent());
				return;
			}

			// Propagate detail domain to source selection (creates or updates brush)
			const current = untrack(() => sourceScale.selectionExtent);
			if (!current || current[0] !== targetMin || current[1] !== targetMax) {
				untrack(() => sourceScale.setSelectionExtent(targetMin, targetMax, 'external'));
			}
		});
	}

	get xLabel(): string | null | undefined {
		return this.config.xLabel;
	}

	get yLabel(): string | null | undefined {
		return this.config.yLabel;
	}

	/** Column name from mark registrations — used as interactor field fallback. */
	get xColumnName(): string | null {
		return this.scaleConfigurations?.x?.columnName?.toString() ?? null;
	}

	get yColumnName(): string | null {
		return this.scaleConfigurations?.y?.columnName?.toString() ?? null;
	}

	get layout(): ChartLayout {
		return this.config.layout;
	}

	get chartId(): string {
		return this.config.layout.chartId;
	}

	/**
	 * Build the config object for a single axis scale, adding discriminators
	 * (sourceField for band/point, __selectionConsumer for selection-driven).
	 */
	#buildAxisScaleConfig(axisConfig: ResolvedScaleConfiguration): Record<string, unknown> {
		const cfg: Record<string, unknown> = { ...(axisConfig.config || {}) };
		const col = axisConfig.columnName;
		if (typeof col === 'string') {
			// Band/point: sourceField for ViewManager index columns.
			// Time: sourceField for EPOCH() SQL in TimeScaleState.
			// sourceField is NOT added to linear scales to avoid changing their
			// config hash, which would break scale sharing for use_selection.
			if (axisConfig.type === 'band' || axisConfig.type === 'point' || axisConfig.type === 'time') {
				cfg.sourceField = col;
			}
		}
		return cfg;
	}

	/**
	 * Resolve scale instances from current scaleConfigurations.
	 * Called both eagerly (from registerScaleType, synchronous) and
	 * reactively (from the $effect). Idempotent — a no-op when scales
	 * are already correct.
	 */
	#resolveScaleInstances(): void {
		const xConfig = this.scaleConfigurations.x;
		const yConfig = this.scaleConfigurations.y;

		// Resolve each axis independently — parallel coordinates only registers x.
		if (xConfig) {
			const xKey = this.xLabel || xConfig.columnName || 'x';
			const xScaleConfig = this.#buildAxisScaleConfig(xConfig);
			if (this.config.useXSelection) xScaleConfig.__selectionConsumer = this.chartId;
			if (this.scaleRequirements.x?.some((r) => r.config?.__fitDomain))
				xScaleConfig.__fitDomain = this.chartId;

			const neededXScale = this.#scaleRegistry.getOrCreateScale(
				xKey,
				xConfig.type,
				xScaleConfig,
				this.chartId
			) as ScaleStateInstance;

			if (this.#xScaleInstance !== neededXScale) {
				if (this.#xScaleInstance) {
					this.#scaleRegistry.deregisterChart(this.#xScaleInstance, this.chartId);
				}
				this.#xScaleInstance = neededXScale;
			}
		}

		if (yConfig) {
			const yKey = this.yLabel || yConfig.columnName || 'y';
			const yScaleConfig = this.#buildAxisScaleConfig(yConfig);
			if (this.config.useYSelection) yScaleConfig.__selectionConsumer = this.chartId;
			if (this.scaleRequirements.y?.some((r) => r.config?.__fitDomain))
				yScaleConfig.__fitDomain = this.chartId;

			const neededYScale = this.#scaleRegistry.getOrCreateScale(
				yKey,
				yConfig.type,
				yScaleConfig,
				this.chartId
			) as ScaleStateInstance;

			if (this.#yScaleInstance !== neededYScale) {
				if (this.#yScaleInstance) {
					this.#scaleRegistry.deregisterChart(this.#yScaleInstance, this.chartId);
				}
				this.#yScaleInstance = neededYScale;
			}
		}
		this.#markScalesEntered();
	}

	scaleConfigurations = $derived.by(() => {
		try {
			return {
				x: resolveScaleConfiguration(this.scaleRequirements.x),
				y: resolveScaleConfiguration(this.scaleRequirements.y)
			};
		} catch (error) {
			console.error('Scale config error', error);
			return {
				x: { type: 'linear', config: {}, columnName: null } as ResolvedScaleConfiguration,
				y: { type: 'linear', config: {}, columnName: null } as ResolvedScaleConfiguration
			};
		}
	});

	scaleTypes = $derived.by(() => ({
		x: this.scaleConfigurations?.x?.type || 'linear',
		y: this.scaleConfigurations?.y?.type || 'linear'
	}));

	get xScaleState(): ScaleStateInstance | null {
		return this.#xScaleInstance;
	}

	get yScaleState(): ScaleStateInstance | null {
		return this.#yScaleInstance;
	}

	baseXScale = $derived(
		this.layout.isReady && this.#xScaleInstance
			? this.#xScaleInstance.getBaseScale('x', this.layout.innerWidth)
			: null
	);

	baseYScale = $derived(
		this.layout.isReady && this.#yScaleInstance
			? this.#yScaleInstance.getBaseScale('y', this.layout.innerHeight)
			: null
	);

	get xScale(): D3Scale | null {
		if (!this.layout.isReady || !this.baseXScale || !this.#xScaleInstance) return null;
		this.#xScaleInstance.domainForReactivity; // Register dependency
		return this.#xScaleInstance.updateScaleDomain(this.baseXScale) as D3Scale;
	}

	get yScale(): D3Scale | null {
		if (!this.layout.isReady || !this.baseYScale || !this.#yScaleInstance) return null;
		this.#yScaleInstance.domainForReactivity; // Register dependency
		return this.#yScaleInstance.updateScaleDomain(this.baseYScale) as D3Scale;
	}

	get xTargetScale(): D3Scale | null {
		if (!this.layout.isReady || !this.baseXScale || !this.#xScaleInstance) return null;
		return this.#xScaleInstance.updateScaleDomain(this.baseXScale) as D3Scale;
	}

	get yTargetScale(): D3Scale | null {
		if (!this.layout.isReady || !this.baseYScale || !this.#yScaleInstance) return null;
		return this.#yScaleInstance.updateScaleDomain(this.baseYScale) as D3Scale;
	}

	currentXDataPoint = $derived(this.#xScaleInstance?.currentDataPoint);
	currentYDataPoint = $derived(this.#yScaleInstance?.currentDataPoint);
	currentXScreenPoint = $derived(this.xScale?.(this.currentXDataPoint));
	currentYScreenPoint = $derived(this.yScale?.(this.currentYDataPoint));
	scalesReady = $derived(this.#xScaleInstance?.ready && this.#yScaleInstance?.ready);

	registerScaleType = (
		dimension: 'x' | 'y',
		type: string,
		priority: number = SCALE_PRIORITIES.PREFER,
		markId: string = 'unknown',
		config: Record<string, unknown> = {},
		columnName: FieldRef | null = null
	): void => {
		let rawColumn: FieldRef | null = columnName;
		if (isBinExpression(rawColumn)) {
			rawColumn = rawColumn.field;
		}
		if (rawColumn && typeof rawColumn !== 'string') {
			rawColumn = rawColumn.toString();
		}
		const resolvedColumnName: string | null = typeof rawColumn === 'string' ? rawColumn : null;

		const requirements = this.scaleRequirements[dimension];
		const existing = requirements.find(
			(req) =>
				req.type === type &&
				req.priority === priority &&
				req.markId === markId &&
				JSON.stringify(req.config) === JSON.stringify(config)
		);

		if (!existing) {
			requirements.push({ type, priority, markId, config, columnName: resolvedColumnName });
			this.scaleRequirements[dimension] = [...requirements];
		}

		// Eagerly resolve scale instances so MarkLifecycle effects (which may
		// run before the ChartScales $effect) always see the correct scales.
		// Safe from untrack() contexts — reads $derived synchronously, writes
		// $state. No-op when only one axis has requirements (the other config
		// will be null, causing #resolveScaleInstances to return early).
		this.#resolveScaleInstances();
	};

	unregisterScaleType = (dimension: 'x' | 'y', markId: string): void => {
		const requirements = this.scaleRequirements[dimension];
		const filtered = requirements.filter((req) => req.markId !== markId);
		if (filtered.length !== requirements.length) {
			this.scaleRequirements[dimension] = filtered;
		}
	};

	// --- PARALLEL COLUMN SCALE MANAGEMENT ---

	#ensureReorder(): ParallelAxisReorder {
		if (!this.#reorder) {
			this.#reorder = new ParallelAxisReorder({
				gpuCoordinator: this.gpuCoordinator,
				chartId: this.chartId,
				getAxisOrder: () => this.#parallelAxisOrder,
				setAxisOrder: (order) => {
					this.#parallelAxisOrder = order;
				}
			});
		}
		return this.#reorder;
	}

	/**
	 * Set a parallel mark's columns: its whole list, in its order; an empty list
	 * when it goes. The axes are the union of every mark's columns, in mark
	 * order, so a column a mark drops loses its axis once no mark has it, and a
	 * column put back returns to its place in the mark's list. A parallel mark
	 * draws its i-th column on the i-th axis, so the axes must follow its list.
	 *
	 * One call replaces the mark's previous list, so a mark that re-creates its
	 * setup when its columns change needs nothing else; the mark clears its list
	 * when it unmounts. A change of axes resets the axis order to column order,
	 * dropping a manual reorder, as adding a column always has.
	 */
	setParallelColumns = (markId: string, columns: string[]): void => {
		if (columns.length > 0) this.#parallelColumnsByMark.set(markId, [...columns]);
		else this.#parallelColumnsByMark.delete(markId);

		const wanted = parallelAxisColumns(this.#parallelColumnsByMark);
		const current = [...this.#parallelScaleInstances.keys()];
		if (wanted.length === current.length && wanted.every((c, i) => c === current[i])) return;

		const next = new Map<string, LinearScaleState>();
		for (const column of wanted) {
			// Via ScaleRegistry, keyed by the raw column name, so it shares with any
			// other chart using the same column (domain sync).
			next.set(
				column,
				this.#parallelScaleInstances.get(column) ??
					(this.#scaleRegistry.getOrCreateScale(
						column,
						'linear',
						{},
						this.chartId
					) as LinearScaleState)
			);
		}
		for (const [column, scale] of this.#parallelScaleInstances) {
			if (!next.has(column)) this.#scaleRegistry.deregisterChart(scale, this.chartId);
		}
		this.#parallelScaleInstances = next;
		this.#markScalesEntered();
		this.#parallelAxisOrder = wanted.map((_, i) => i);
		if (next.size > 0) this.#ensureReorder().resetSprings();
		else this.#reorder?.resetSprings();
	};

	get parallelScales(): {
		scaleStates: LinearScaleState[];
		columns: string[];
		axisOrder: number[];
	} | null {
		if (this.#parallelScaleInstances.size === 0) return null;
		return {
			scaleStates: [...this.#parallelScaleInstances.values()],
			columns: [...this.#parallelScaleInstances.keys()],
			axisOrder: this.#parallelAxisOrder
		};
	}

	/** Reorder parallel axes: move the axis at visual position `from` to position `to`. */
	reorderParallelAxis = (from: number, to: number): void => {
		const order = [...this.#parallelAxisOrder];
		const [moved] = order.splice(from, 1);
		order.splice(to, 0, moved);
		this.#parallelAxisOrder = order;
	};

	getRegisteredScaleRequirementsSummary = () => {
		return {
			x: this.scaleRequirements.x,
			y: this.scaleRequirements.y,
			resolvedTypes: this.scaleTypes
		};
	};

	clearCurrentDataPoints = (): void => {
		if (this.#xScaleInstance) this.#xScaleInstance.currentDataPoint = null;
		if (this.#yScaleInstance) this.#yScaleInstance.currentDataPoint = null;
	};

	#isContinuous(axis: 'x' | 'y'): boolean {
		return isContinuousScale(this.scaleTypes?.[axis]);
	}

	updateCurrentDataPoints = (
		innerPoint: { x: number; y: number },
		innerWidth: number,
		innerHeight: number
	): void => {
		if (this.#yScaleInstance?.invertScreenToData) {
			this.#yScaleInstance.currentDataPoint = this.#yScaleInstance.invertScreenToData(
				innerPoint.y,
				innerHeight,
				true
			);
		}
		if (this.#xScaleInstance?.invertScreenToData) {
			this.#xScaleInstance.currentDataPoint = this.#xScaleInstance.invertScreenToData(
				innerPoint.x,
				innerWidth,
				false
			);
		}
	};

	resetZoom = (resetX = true, resetY = true): void => {
		if (resetX && this.#isContinuous('x') && this.#xScaleInstance) {
			this.#xScaleInstance.resetZoom();
		}
		if (resetY && this.#isContinuous('y') && this.#yScaleInstance) {
			this.#yScaleInstance.resetZoom();
		}
	};

	accumulateZoom = (
		innerPoint: { x: number; y: number },
		scaleFactor: number,
		doX: boolean,
		doY: boolean,
		innerWidth: number,
		innerHeight: number
	): void => {
		if (doX && isPanZoomScale(this.#xScaleInstance)) {
			this.#xScaleInstance.accumulateZoom(innerPoint.x / innerWidth, scaleFactor);
		}
		if (doY && isPanZoomScale(this.#yScaleInstance)) {
			this.#yScaleInstance.accumulateZoom(1 - innerPoint.y / innerHeight, scaleFactor);
		}
	};

	applyZoom = (
		innerPoint: { x: number; y: number },
		scaleFactor: number,
		doX: boolean,
		doY: boolean,
		innerWidth: number,
		innerHeight: number
	): void => {
		if (doX && isPanZoomScale(this.#xScaleInstance)) {
			this.#xScaleInstance.accumulateZoom(innerPoint.x / innerWidth, scaleFactor);
		}
		if (doY && isPanZoomScale(this.#yScaleInstance)) {
			this.#yScaleInstance.accumulateZoom(1 - innerPoint.y / innerHeight, scaleFactor);
		}
	};

	startPan = (
		x: number,
		y: number,
		activePanX: boolean,
		activePanY: boolean,
		innerWidth: number,
		innerHeight: number
	): void => {
		this.activePanX = activePanX;
		this.activePanY = activePanY;

		const xInst = this.#xScaleInstance;
		if (activePanX && isPanZoomScale(xInst)) {
			const currentDomain = xInst.domain.current;

			this._xPanContext.initialScreenPos = x;
			this._xPanContext.initialDomain[0] = currentDomain[0];
			this._xPanContext.initialDomain[1] = currentDomain[1];
			this._xPanContext.screenToDataRatio = (currentDomain[1] - currentDomain[0]) / innerWidth;
			this._xPanContext.domainWidth = currentDomain[1] - currentDomain[0];
			this._xPanContext.screenDimension = innerWidth;
			this._xPanContext.lastScreenPos = x;

			xInst.setPanContext(this._xPanContext);
		}

		const yInst = this.#yScaleInstance;
		if (activePanY && isPanZoomScale(yInst)) {
			const currentDomain = yInst.domain.current;

			this._yPanContext.initialScreenPos = y;
			this._yPanContext.initialDomain[0] = currentDomain[0];
			this._yPanContext.initialDomain[1] = currentDomain[1];
			this._yPanContext.screenToDataRatio = (currentDomain[1] - currentDomain[0]) / innerHeight;
			this._yPanContext.domainWidth = currentDomain[1] - currentDomain[0];
			this._yPanContext.screenDimension = innerHeight;
			this._yPanContext.lastScreenPos = y;

			yInst.setPanContext(this._yPanContext);
		}
	};

	endPan = (): void => {
		this.activePanX = false;
		this.activePanY = false;

		const xInst = this.#xScaleInstance;
		if (isPanZoomScale(xInst)) {
			xInst.endPan();
		}
		const yInst = this.#yScaleInstance;
		if (isPanZoomScale(yInst)) {
			yInst.endPan();
		}
	};

	updatePanPosition = (screenX: number, screenY: number): void => {
		const xInst = this.#xScaleInstance;
		if (this.activePanX && isPanZoomScale(xInst)) {
			xInst.updatePanPosition(screenX, 0);
		}
		const yInst = this.#yScaleInstance;
		if (this.activePanY && isPanZoomScale(yInst)) {
			yInst.updatePanPosition(0, screenY);
		}
		// Parallel axis pan
		if (this.#parallelPanAxis) {
			this.#parallelPanAxis.updatePanPosition(0, screenY);
		}
	};

	// --- PARALLEL AXIS PAN/ZOOM ---

	#parallelPanAxis: LinearScaleState | null = null;

	// --- PARALLEL AXIS REORDER (delegated to ParallelAxisReorder) ---

	get reorderCurrentX(): number | null {
		return this.#reorder?.reorderCurrentX ?? null;
	}
	get reorderDataIdx(): number | null {
		return this.#reorder?.reorderDataIdx ?? null;
	}
	get animatedAxisXPositions(): number[] {
		return this.#reorder?.animatedAxisXPositions ?? [];
	}

	startParallelReorder = (innerX: number, innerWidth: number): boolean => {
		return this.#reorder?.startReorder(innerX, innerWidth) ?? false;
	};
	updateParallelReorder = (innerX: number, innerWidth: number): void => {
		this.#reorder?.updateReorder(innerX, innerWidth);
	};
	endParallelReorder = (): void => {
		this.#reorder?.endReorder();
	};
	cancelParallelReorder = (): void => {
		this.#reorder?.cancelReorder();
	};

	/** Find the nearest parallel axis DATA index from an inner x-coordinate.
	 *  Uses axisOrder for visual positioning. */
	#nearestParallelAxis(innerX: number, innerWidth: number): number | null {
		const order = this.#parallelAxisOrder;
		const n = order.length;
		if (n === 0) return null;
		const gap = n > 1 ? innerWidth / (n - 1) : innerWidth;
		let bestVisual = 0;
		let bestDist = Infinity;
		for (let v = 0; v < n; v++) {
			const axisX = n > 1 ? (v / (n - 1)) * innerWidth : innerWidth / 2;
			const dist = Math.abs(innerX - axisX);
			if (dist < bestDist) {
				bestDist = dist;
				bestVisual = v;
			}
		}
		return bestDist <= gap * 0.5 ? order[bestVisual] : null;
	}

	/** Get the parallel scale state by data index. */
	#parallelScaleAt(dataIdx: number): LinearScaleState | null {
		const values = [...this.#parallelScaleInstances.values()];
		return values[dataIdx] ?? null;
	}

	/** Start a pan on the nearest parallel axis. Returns true if a parallel axis was found. */
	startParallelPan = (
		screenY: number,
		innerX: number,
		innerWidth: number,
		innerHeight: number
	): boolean => {
		const idx = this.#nearestParallelAxis(innerX, innerWidth);
		if (idx == null) return false;
		const scale = this.#parallelScaleAt(idx);
		if (!scale || !scale.supportsPanZoom) return false;

		const currentDomain = scale.domain.current;
		scale.setPanContext({
			screenToDataRatio: (currentDomain[1] - currentDomain[0]) / innerHeight,
			axis: 'y',
			initialScreenPos: screenY
		});
		this.#parallelPanAxis = scale;
		return true;
	};

	endParallelPan = (): void => {
		if (this.#parallelPanAxis) {
			this.#parallelPanAxis.endPan();
			this.#parallelPanAxis = null;
		}
	};

	/** Reset zoom on the nearest parallel axis, or all if no position given. */
	resetParallelZoom = (innerX?: number, innerWidth?: number): boolean => {
		if (this.#parallelScaleInstances.size === 0) return false;
		if (innerX != null && innerWidth != null) {
			const idx = this.#nearestParallelAxis(innerX, innerWidth);
			if (idx == null) return false;
			this.#parallelScaleAt(idx)?.resetZoom();
		} else {
			for (const scale of this.#parallelScaleInstances.values()) {
				scale.resetZoom();
			}
		}
		return true;
	};

	/** Zoom the nearest parallel axis. Returns true if a parallel axis was found. */
	zoomParallelAxis = (
		innerX: number,
		innerY: number,
		scaleFactor: number,
		innerWidth: number,
		innerHeight: number
	): boolean => {
		const idx = this.#nearestParallelAxis(innerX, innerWidth);
		if (idx == null) return false;
		const scale = this.#parallelScaleAt(idx);
		if (!scale || !scale.supportsPanZoom) return false;

		const visualCenter = 1 - innerY / innerHeight;
		scale.accumulateZoom(visualCenter, scaleFactor);
		return true;
	};

	xBandwidth = $derived.by(() => {
		if (this.scaleTypes?.x !== 'band' || !this.baseXScale || !this.layout.isReady) return 0;
		return (this.baseXScale as D3BandScale).bandwidth();
	});

	yBandwidth = $derived.by(() => {
		if (this.scaleTypes?.y !== 'band' || !this.baseYScale || !this.layout.isReady) return 0;
		return (this.baseYScale as D3BandScale).bandwidth();
	});

	setBinStepMultiplier(value: number): void {
		const clamped = Math.max(0.1, Math.min(20.0, value));
		if (Math.abs(clamped - this.binStepMultiplier) > 0.001) {
			this.binStepMultiplier = clamped;
		}
	}

	adjustBinMultiplier(delta: number): void {
		const current = this.binStepMultiplier;
		this.setBinStepMultiplier(current + current * delta);
	}

	getContextData() {
		const coordinator = this;
		return {
			get xScale() {
				return coordinator.xScale;
			},
			get yScale() {
				return coordinator.yScale;
			},
			get xTargetScale() {
				return coordinator.xTargetScale;
			},
			get yTargetScale() {
				return coordinator.yTargetScale;
			},
			get xLabel() {
				return coordinator.xLabel;
			},
			get yLabel() {
				return coordinator.yLabel;
			},
			get currentXDataPoint() {
				return coordinator.currentXDataPoint;
			},
			get currentYDataPoint() {
				return coordinator.currentYDataPoint;
			},
			get currentXScreenPoint() {
				return coordinator.currentXScreenPoint;
			},
			get currentYScreenPoint() {
				return coordinator.currentYScreenPoint;
			},
			get xScaleState() {
				return coordinator.xScaleState;
			},
			get yScaleState() {
				return coordinator.yScaleState;
			},
			get scaleTypes() {
				return coordinator.scaleTypes;
			},
			get scalesReady() {
				return coordinator.scalesReady;
			},
			get active() {
				return coordinator.active;
			},
			get scaleConfigurations() {
				return coordinator.scaleConfigurations;
			},
			get xBandwidth() {
				return coordinator.xBandwidth;
			},
			get yBandwidth() {
				return coordinator.yBandwidth;
			},
			registerScaleType: coordinator.registerScaleType,
			unregisterScaleType: coordinator.unregisterScaleType,
			setParallelColumns: coordinator.setParallelColumns,
			reorderParallelAxis: coordinator.reorderParallelAxis,
			get parallelReorderState() {
				return {
					dataIdx: coordinator.reorderDataIdx,
					currentX: coordinator.reorderCurrentX
				};
			},
			get parallelScales() {
				return coordinator.parallelScales;
			},
			get animatedAxisXPositions() {
				return coordinator.animatedAxisXPositions;
			},
			getRegisteredScaleRequirementsSummary: coordinator.getRegisteredScaleRequirementsSummary,
			get binStepMultiplier() {
				return coordinator.binStepMultiplier;
			},
			adjustBinMultiplier: (d: number) => coordinator.adjustBinMultiplier(d),
			setBinStepMultiplier: (v: number) => coordinator.setBinStepMultiplier(v)
		};
	}

	/**
	 * A scale snaps every extent change until a chart drawing it has its marks'
	 * first data in, so the domain is that chart's whole extent when it enters,
	 * and its axes show no ticks before then (the domain is a placeholder).
	 * Marked here when the chart's entrance gate opens, and again whenever the
	 * scale instances change after that.
	 */
	#entranceGateOff: (() => void) | null = null;

	#markScalesEntered(): void {
		const gate = this.config.entranceGate;
		if (gate && !gate.opened) return;
		for (const scale of [
			this.#xScaleInstance,
			this.#yScaleInstance,
			...this.#parallelScaleInstances.values()
		]) {
			if (scale instanceof LinearScaleState && !scale.entered) scale.entered = true;
		}
	}

	destroy(): void {
		this.#entranceGateOff?.();
		this.#entranceGateOff = null;
		this.#reorder?.destroy();
		this.#reorder = null;

		if (this.#scaleRegistry) {
			this.#scaleRegistry.removeChartUsage(this.chartId);
		}

		// Clean up parallel column scales
		for (const scale of this.#parallelScaleInstances.values()) {
			this.#scaleRegistry.deregisterChart(scale, this.chartId);
		}
		this.#parallelScaleInstances = new Map();
		this.#parallelColumnsByMark.clear();

		this.#xScaleInstance = null;
		this.#yScaleInstance = null;
	}
}

/**
 * A parallel chart's axes: the union of its marks' column lists, each column
 * once, in mark order (the first mark's columns first, each in its own order).
 */
export function parallelAxisColumns(
	columnsByMark: ReadonlyMap<string, readonly string[]>
): string[] {
	const axes: string[] = [];
	for (const list of columnsByMark.values()) {
		for (const column of list) if (!axes.includes(column)) axes.push(column);
	}
	return axes;
}
