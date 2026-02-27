// src/lib/scales/ChartScales.svelte.ts
import { resolveScaleConfiguration, SCALE_PRIORITIES } from './ScalePriorities';
import type { RegisteredScaleRequirement, ResolvedScaleConfiguration } from './ScalePriorities';
import type { ScaleRegistry } from './ScaleRegistry.svelte';
import type { GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';
import type { ChartLayout } from '$lib/layout/ChartLayout.svelte';
import type { ScaleStateInstance, D3Scale, D3BandScale, FieldRef, MosaicClient } from '$lib/types';
import { isBinExpression } from '$lib/sql/bin';

interface PanContext {
	initialScreenPos: number;
	initialDomain: number[];
	screenToDataRatio: number;
	domainWidth: number;
	screenDimension: number;
	axis: 'x' | 'y';
	lastScreenPos: number;
}

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
}

export class ChartScales {
	#scaleRegistry: ScaleRegistry;
	scaleRequirements = $state<{ x: RegisteredScaleRequirement[]; y: RegisteredScaleRequirement[] }>({
		x: [],
		y: []
	});

	#xScaleInstance = $state<ScaleStateInstance | null>(null);
	#yScaleInstance = $state<ScaleStateInstance | null>(null);

	#previousXScale: ScaleStateInstance | null = null;
	#previousYScale: ScaleStateInstance | null = null;

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

	markClients = new Set<MosaicClient>();

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

		if (!this.#scaleRegistry) {
			console.error('ChartScales initialized without scaleRegistry!');
		}

		// Effect: Update scale instances when requirements or labels change
		$effect(() => {
			const xLabel = this.xLabel;
			const yLabel = this.yLabel;
			const xConfig = this.scaleConfigurations.x;
			const yConfig = this.scaleConfigurations.y;

			if (!xConfig || !yConfig) return;

			const xKey = xLabel || xConfig.columnName || 'x';
			const yKey = yLabel || yConfig.columnName || 'y';

			// ChartScales only creates axis scales (linear/band/time), safe to narrow
			const neededXScale = this.#scaleRegistry.getOrCreateScale(
				xKey,
				xConfig.type,
				xConfig.config || {},
				this.chartId
			) as ScaleStateInstance;

			const neededYScale = this.#scaleRegistry.getOrCreateScale(
				yKey,
				yConfig.type,
				yConfig.config || {},
				this.chartId
			) as ScaleStateInstance;

			const facetIds = this.#getFacetChartIds?.();
			if (facetIds) {
				for (const cellId of facetIds) {
					this.#scaleRegistry.getOrCreateScale(xKey, xConfig.type, xConfig.config || {}, cellId);
					this.#scaleRegistry.getOrCreateScale(yKey, yConfig.type, yConfig.config || {}, cellId);
				}
			}

			if (this.#xScaleInstance !== neededXScale) {
				if (this.#xScaleInstance) {
					this.#scaleRegistry.deregisterChart(this.#xScaleInstance, this.chartId);
				}
				this.#xScaleInstance = neededXScale;
				this.#previousXScale = neededXScale;
			}

			if (this.#yScaleInstance !== neededYScale) {
				if (this.#yScaleInstance) {
					this.#scaleRegistry.deregisterChart(this.#yScaleInstance, this.chartId);
				}
				this.#yScaleInstance = neededYScale;
				this.#previousYScale = neededYScale;
			}

			{
				const xInst = this.#xScaleInstance;
				const yInst = this.#yScaleInstance;
				if (this.config.xZoomLimit !== undefined && xInst && xInst.scaleType !== 'band') {
					xInst.setZoomLimit(this.config.xZoomLimit);
				}
				if (this.config.yZoomLimit !== undefined && yInst && yInst.scaleType !== 'band') {
					yInst.setZoomLimit(this.config.yZoomLimit);
				}
				if (this.config.xPanLimit !== undefined && xInst && xInst.scaleType !== 'band') {
					xInst.setPanLimit(this.config.xPanLimit);
				}
				if (this.config.yPanLimit !== undefined && yInst && yInst.scaleType !== 'band') {
					yInst.setPanLimit(this.config.yPanLimit);
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
	}

	get xLabel(): string | null | undefined {
		return this.config.xLabel;
	}

	get yLabel(): string | null | undefined {
		return this.config.yLabel;
	}

	get layout(): ChartLayout {
		return this.config.layout;
	}

	get chartId(): string {
		return this.config.layout.chartId;
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
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return this.#xScaleInstance.updateScaleDomain(this.baseXScale) as D3Scale;
	}

	get yScale(): D3Scale | null {
		if (!this.layout.isReady || !this.baseYScale || !this.#yScaleInstance) return null;
		this.#yScaleInstance.domainForReactivity; // Register dependency
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return this.#yScaleInstance.updateScaleDomain(this.baseYScale) as D3Scale;
	}

	get xTargetScale(): D3Scale | null {
		if (!this.layout.isReady || !this.baseXScale || !this.#xScaleInstance) return null;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return this.#xScaleInstance.updateScaleDomain(this.baseXScale) as D3Scale;
	}

	get yTargetScale(): D3Scale | null {
		if (!this.layout.isReady || !this.baseYScale || !this.#yScaleInstance) return null;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
	};

	unregisterScaleType = (dimension: 'x' | 'y', markId: string): void => {
		const requirements = this.scaleRequirements[dimension];
		const filtered = requirements.filter((req) => req.markId !== markId);
		if (filtered.length !== requirements.length) {
			this.scaleRequirements[dimension] = filtered;
		}
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
		const type = this.scaleTypes?.[axis];
		return type === 'linear' || type === 'time';
	}

	registerClient = (client: MosaicClient): (() => void) => {
		this.markClients.add(client);
		return () => this.markClients.delete(client);
	};

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
		const xInst = this.#xScaleInstance;
		if (doX && xInst && xInst.scaleType !== 'band') {
			const dataPoint = xInst.invertScreenToData(innerPoint.x, innerWidth, false);
			xInst.accumulateZoom(dataPoint, scaleFactor);
		}
		const yInst = this.#yScaleInstance;
		if (doY && yInst && yInst.scaleType !== 'band') {
			const dataPoint = yInst.invertScreenToData(innerPoint.y, innerHeight, true);
			yInst.accumulateZoom(dataPoint, scaleFactor);
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
		const xInst = this.#xScaleInstance;
		if (doX && xInst && xInst.scaleType !== 'band') {
			const dataPoint = xInst.invertScreenToData(innerPoint.x, innerWidth, false);
			xInst.accumulateZoom(dataPoint, scaleFactor);
		}
		const yInst = this.#yScaleInstance;
		if (doY && yInst && yInst.scaleType !== 'band') {
			const dataPoint = yInst.invertScreenToData(innerPoint.y, innerHeight, true);
			yInst.accumulateZoom(dataPoint, scaleFactor);
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
		if (activePanX && xInst && xInst.scaleType !== 'band') {
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
		if (activePanY && yInst && yInst.scaleType !== 'band') {
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
		if (xInst && xInst.scaleType !== 'band') {
			xInst.endPan();
		}
		const yInst = this.#yScaleInstance;
		if (yInst && yInst.scaleType !== 'band') {
			yInst.endPan();
		}
	};

	updatePanPosition = (screenX: number, screenY: number): void => {
		const xInst = this.#xScaleInstance;
		if (this.activePanX && xInst && xInst.scaleType !== 'band') {
			xInst.updatePanPosition(screenX, 0);
		}
		const yInst = this.#yScaleInstance;
		if (this.activePanY && yInst && yInst.scaleType !== 'band') {
			yInst.updatePanPosition(0, screenY);
		}
	};

	xCategoryPositions = $derived.by(() => {
		const xInst = this.#xScaleInstance;
		if (!xInst || xInst.scaleType !== 'band' || !this.xScale || !this.layout.isReady) return null;
		const domain = xInst.effectiveDomain;
		if (!domain || domain.length === 0) return null;
		return new Float32Array(domain.map((d: string | number) => this.xScale!(d)));
	});

	yCategoryPositions = $derived.by(() => {
		const yInst = this.#yScaleInstance;
		if (!yInst || yInst.scaleType !== 'band' || !this.yScale || !this.layout.isReady) return null;
		const domain = yInst.effectiveDomain;
		if (!domain || domain.length === 0) return null;
		return new Float32Array(domain.map((d: string | number) => this.yScale!(d)));
	});

	categoryPositionsReady = $derived.by(() => {
		const xReady = this.scaleTypes?.x !== 'band' || this.xCategoryPositions !== null;
		const yReady = this.scaleTypes?.y !== 'band' || this.yCategoryPositions !== null;
		return xReady && yReady;
	});

	xBandwidth = $derived.by(() => {
		if (this.scaleTypes?.x !== 'band' || !this.baseXScale || !this.layout.isReady) return 0;
		return (this.baseXScale as D3BandScale).bandwidth();
	});

	yBandwidth = $derived.by(() => {
		if (this.scaleTypes?.y !== 'band' || !this.baseYScale || !this.layout.isReady) return 0;
		return (this.baseYScale as D3BandScale).bandwidth();
	});

	adjustBinMultiplier(delta: number): void {
		const current = this.binStepMultiplier;
		const absoluteDelta = current * delta;
		const newValue = Math.max(0.1, Math.min(20.0, current + absoluteDelta));

		if (Math.abs(newValue - current) > 0.001) {
			this.binStepMultiplier = newValue;
		}
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
			get xCategoryPositions() {
				return coordinator.xCategoryPositions;
			},
			get yCategoryPositions() {
				return coordinator.yCategoryPositions;
			},
			get categoryPositionsReady() {
				return coordinator.categoryPositionsReady;
			},
			get xBandwidth() {
				return coordinator.xBandwidth;
			},
			get yBandwidth() {
				return coordinator.yBandwidth;
			},
			registerScaleType: coordinator.registerScaleType,
			unregisterScaleType: coordinator.unregisterScaleType,
			getRegisteredScaleRequirementsSummary: coordinator.getRegisteredScaleRequirementsSummary,
			get binStepMultiplier() {
				return coordinator.binStepMultiplier;
			},
			adjustBinMultiplier: (d: number) => coordinator.adjustBinMultiplier(d)
		};
	}

	destroy(): void {
		if (this.#scaleRegistry) {
			this.#scaleRegistry.removeChartUsage(this.chartId);
		}

		this.#xScaleInstance = null;
		this.#yScaleInstance = null;
		this.#previousXScale = null;
		this.#previousYScale = null;
	}
}
