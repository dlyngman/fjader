// src/lib/scales/ChartScales.svelte.js
import { getContext } from 'svelte';
import { getScaleState } from '$lib/scales';
import { resolveScaleConfiguration, SCALE_PRIORITIES } from './ScalePriorities';

export class ChartScales {
	#scaleRegistry;
	scaleRequirements = $state({
		x: [],
		y: []
	});

	// Use $state instead of $derived for scale instances
	#xScaleInstance = $state(null);
	#yScaleInstance = $state(null);

	// Track previous scales for cleanup
	#previousXScale = null;
	#previousYScale = null;

	active = $state(false);

	// --- MEMORY POOLS ---
	// Reusable objects to avoid garbage collection during "pointerdown"
	_xPanContext = {
		initialScreenPos: 0,
		initialDomain: [0, 0],
		screenToDataRatio: 0,
		domainWidth: 0,
		screenDimension: 0,
		axis: 'x',
		lastScreenPos: 0
	};

	_yPanContext = {
		initialScreenPos: 0,
		initialDomain: [0, 0],
		screenToDataRatio: 0,
		domainWidth: 0,
		screenDimension: 0,
		axis: 'y',
		lastScreenPos: 0
	};

	binStepMultiplier = $state(1.0);

	// Mark client tracking (moved from ChartContainer)
	markClients = new Set();

	#getFacetChartIds;

	constructor(config) {
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

			// Wait for at least one mark to register on each axis.
			// When scale inference is pending, configurations are null.
			if (!xConfig || !yConfig) return;

			// Resolve scale keys: use explicit label if provided, otherwise auto-infer from marks
			const xKey = xLabel || xConfig.columnName || 'x';
			const yKey = yLabel || yConfig.columnName || 'y';

			// Get what scales SHOULD be

			const neededXScale = this.#scaleRegistry.getOrCreateScale(
				xKey,
				xConfig.type,
				xConfig.config || {},
				this.chartId
			);

			const neededYScale = this.#scaleRegistry.getOrCreateScale(
				yKey,
				yConfig.type,
				yConfig.config || {},
				this.chartId
			);

			// Register facet cell chart IDs with the same scales so the
			// animation loop knows to redraw them when scales change.
			const facetIds = this.#getFacetChartIds?.();
			if (facetIds) {
				for (const cellId of facetIds) {
					this.#scaleRegistry.getOrCreateScale(xKey, xConfig.type, xConfig.config || {}, cellId);
					this.#scaleRegistry.getOrCreateScale(yKey, yConfig.type, yConfig.config || {}, cellId);
				}
			}

			// Check if X scale changed
			if (this.#xScaleInstance !== neededXScale) {
				if (this.#xScaleInstance) {
					this.#scaleRegistry.deregisterChart(this.#xScaleInstance, this.chartId);
				}
				this.#xScaleInstance = neededXScale;
				this.#previousXScale = neededXScale;
			}

			// Check if Y scale changed
			if (this.#yScaleInstance !== neededYScale) {
				if (this.#yScaleInstance) {
					this.#scaleRegistry.deregisterChart(this.#yScaleInstance, this.chartId);
				}
				this.#yScaleInstance = neededYScale;
				this.#previousYScale = neededYScale;
			}

			// Apply zoom/pan limits from chart config
			if (this.config.xZoomLimit !== undefined) {
				this.#xScaleInstance?.setZoomLimit?.(this.config.xZoomLimit);
			}
			if (this.config.yZoomLimit !== undefined) {
				this.#yScaleInstance?.setZoomLimit?.(this.config.yZoomLimit);
			}
			if (this.config.xPanLimit !== undefined) {
				this.#xScaleInstance?.setPanLimit?.(this.config.xPanLimit);
			}
			if (this.config.yPanLimit !== undefined) {
				this.#yScaleInstance?.setPanLimit?.(this.config.yPanLimit);
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
						// Propagate to facet cell charts (pending mechanism handles timing)
						const facetIds = this.#getFacetChartIds?.();
						if (facetIds) {
							for (const cellId of facetIds) {
								this.gpuCoordinator.setChartScaleMapping(cellId, mapping);
							}
						}
					} catch (error) {
						// Retry logic for race conditions
						setTimeout(trySetMapping, 10);
					}
				};
				trySetMapping();
			}
		});
	}

	// Getters
	get xLabel() {
		return this.config.xLabel;
	}

	get yLabel() {
		return this.config.yLabel;
	}

	get layout() {
		return this.config.layout;
	}

	get chartId() {
		return this.config.layout.chartId;
	}

	// Derived scale configurations
	scaleConfigurations = $derived.by(() => {
		try {
			return {
				x: resolveScaleConfiguration(this.scaleRequirements.x),
				y: resolveScaleConfiguration(this.scaleRequirements.y)
			};
		} catch (error) {
			console.error('Scale config error', error);
			return { x: { type: 'linear', config: {} }, y: { type: 'linear', config: {} } };
		}
	});

	scaleTypes = $derived.by(() => ({
		x: this.scaleConfigurations?.x?.type || 'linear',
		y: this.scaleConfigurations?.y?.type || 'linear'
	}));

	// Expose scale instances as getters (now using $state)
	get xScaleState() {
		return this.#xScaleInstance;
	}

	get yScaleState() {
		return this.#yScaleInstance;
	}

	// Base D3 scales
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

	// D3 scales with current domains
	get xScale() {
		if (!this.layout.isReady || !this.baseXScale || !this.#xScaleInstance) return null;
		this.#xScaleInstance.domainForReactivity; // Register dependency
		return this.#xScaleInstance.updateScaleDomain(this.baseXScale);
	}

	get yScale() {
		if (!this.layout.isReady || !this.baseYScale || !this.#yScaleInstance) return null;
		this.#yScaleInstance.domainForReactivity; // Register dependency
		return this.#yScaleInstance.updateScaleDomain(this.baseYScale);
	}

	get xTargetScale() {
		if (!this.layout.isReady || !this.baseXScale || !this.#xScaleInstance) return null;
		return this.#xScaleInstance.updateScaleDomain(this.baseXScale, false);
	}

	get yTargetScale() {
		if (!this.layout.isReady || !this.baseYScale || !this.#yScaleInstance) return null;
		return this.#yScaleInstance.updateScaleDomain(this.baseYScale, false);
	}

	// Derived properties
	currentXDataPoint = $derived(this.#xScaleInstance?.currentDataPoint);
	currentYDataPoint = $derived(this.#yScaleInstance?.currentDataPoint);
	currentXScreenPoint = $derived(this.xScale?.(this.currentXDataPoint));
	currentYScreenPoint = $derived(this.yScale?.(this.currentYDataPoint));
	scalesReady = $derived(this.#xScaleInstance?.ready && this.#yScaleInstance?.ready);

	// Scale requirement registration
	registerScaleType = (
		dimension,
		type,
		priority = SCALE_PRIORITIES.PREFER,
		markId = 'unknown',
		config = {},
		columnName = null
	) => {
		let rawColumn = columnName;
		if (rawColumn?.isAutoBinNode) {
			rawColumn = rawColumn.field;
		}
		if (rawColumn && typeof rawColumn !== 'string') {
			rawColumn = rawColumn.toString();
		}

		const requirements = this.scaleRequirements[dimension];
		const existing = requirements.find(
			(req) =>
				req.type === type &&
				req.priority === priority &&
				req.markId === markId &&
				JSON.stringify(req.config) === JSON.stringify(config)
		);

		if (!existing) {
			requirements.push({ type, priority, markId, config, columnName: rawColumn });
			this.scaleRequirements[dimension] = [...requirements];

			// requirements.push({ type, priority, markId, config, columnName });
			// this.scaleRequirements[dimension] = [...requirements];
		}
	};

	unregisterScaleType = (dimension, markId) => {
		const requirements = this.scaleRequirements[dimension];
		const filtered = requirements.filter((req) => req.markId !== markId);
		if (filtered.length !== requirements.length) {
			this.scaleRequirements[dimension] = filtered;
		}
	};

	getScaleRequirementsSummary = () => {
		return {
			x: this.scaleRequirements.x,
			y: this.scaleRequirements.y,
			resolvedTypes: this.scaleTypes
		};
	};

	// Interaction methods
	clearCurrentDataPoints = () => {
		if (this.#xScaleInstance) this.#xScaleInstance.currentDataPoint = null;
		if (this.#yScaleInstance) this.#yScaleInstance.currentDataPoint = null;
	};

	/** Check if axis has a continuous scale that supports pan/zoom/hover. */
	#isContinuous(axis) {
		const type = this.scaleTypes?.[axis];
		return type === 'linear' || type === 'time';
	}

	registerClient = (client) => {
		this.markClients.add(client);
		return () => this.markClients.delete(client);
	};

	updateCurrentDataPoints = (innerPoint, innerWidth, innerHeight) => {
		if (this.#yScaleInstance?.invertScreenToData) {
			this.#yScaleInstance.currentDataPoint = this.#yScaleInstance.invertScreenToData(
				innerPoint.y,
				innerHeight,
				true // isYAxis
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

	resetZoom = (resetX = true, resetY = true) => {
		if (resetX && this.#isContinuous('x') && this.#xScaleInstance) {
			this.#xScaleInstance.resetZoom();
		}
		if (resetY && this.#isContinuous('y') && this.#yScaleInstance) {
			this.#yScaleInstance.resetZoom();
		}
	};

	accumulateZoom = (innerPoint, scaleFactor, doX, doY, innerWidth, innerHeight) => {
		if (doX && this.#isContinuous('x') && this.#xScaleInstance) {
			const dataPoint = this.#xScaleInstance.invertScreenToData(
				innerPoint.x,
				innerWidth,
				false
			);
			this.#xScaleInstance.accumulateZoom(dataPoint, scaleFactor);
		}
		if (doY && this.#isContinuous('y') && this.#yScaleInstance) {
			const dataPoint = this.#yScaleInstance.invertScreenToData(
				innerPoint.y,
				innerHeight,
				true
			);
			this.#yScaleInstance.accumulateZoom(dataPoint, scaleFactor);
		}
	};

	applyZoom = (innerPoint, scaleFactor, doX, doY, innerWidth, innerHeight) => {
		if (doX && this.#isContinuous('x') && this.#xScaleInstance) {
			const dataPoint = this.#xScaleInstance.invertScreenToData(
				innerPoint.x,
				innerWidth,
				false
			);
			this.#xScaleInstance.accumulateZoom(dataPoint, scaleFactor);
			this.#xScaleInstance.applyZoomDomain(dataPoint, scaleFactor, 'x', innerWidth);
		}
		if (doY && this.#isContinuous('y') && this.#yScaleInstance) {
			const dataPoint = this.#yScaleInstance.invertScreenToData(
				innerPoint.y,
				innerHeight,
				true
			);
			this.#yScaleInstance.accumulateZoom(dataPoint, scaleFactor);
			this.#yScaleInstance.applyZoomDomain(dataPoint, scaleFactor, 'y', innerHeight);
		}
	};

	startPan = (x, y, activePanX, activePanY, innerWidth, innerHeight) => {
		this.activePanX = activePanX;
		this.activePanY = activePanY;

		// X Axis Setup
		if (activePanX && this.#isContinuous('x') && this.#xScaleInstance) {
			const currentDomain = this.#xScaleInstance.domain.current;

			this._xPanContext.initialScreenPos = x;
			this._xPanContext.initialDomain[0] = currentDomain[0];
			this._xPanContext.initialDomain[1] = currentDomain[1];
			this._xPanContext.screenToDataRatio =
				(currentDomain[1] - currentDomain[0]) / innerWidth;
			this._xPanContext.domainWidth = currentDomain[1] - currentDomain[0];
			this._xPanContext.screenDimension = innerWidth;
			this._xPanContext.lastScreenPos = x;

			this.#xScaleInstance.setPanContext(this._xPanContext);
		}

		// Y Axis Setup
		if (activePanY && this.#isContinuous('y') && this.#yScaleInstance) {
			const currentDomain = this.#yScaleInstance.domain.current;

			this._yPanContext.initialScreenPos = y;
			this._yPanContext.initialDomain[0] = currentDomain[0];
			this._yPanContext.initialDomain[1] = currentDomain[1];
			this._yPanContext.screenToDataRatio =
				(currentDomain[1] - currentDomain[0]) / innerHeight;
			this._yPanContext.domainWidth = currentDomain[1] - currentDomain[0];
			this._yPanContext.screenDimension = innerHeight;
			this._yPanContext.lastScreenPos = y;

			this.#yScaleInstance.setPanContext(this._yPanContext);
		}
	};

	endPan = () => {
		this.activePanX = false;
		this.activePanY = false;

		if (this.#isContinuous('x') && this.#xScaleInstance) {
			this.#xScaleInstance.endPan();
		}
		if (this.#isContinuous('y') && this.#yScaleInstance) {
			this.#yScaleInstance.endPan();
		}
	};

	updatePanPosition = (screenX, screenY) => {
		if (this.activePanX && this.#isContinuous('x') && this.#xScaleInstance) {
			this.#xScaleInstance.updatePanPosition(screenX, 0);
		}
		if (this.activePanY && this.#isContinuous('y') && this.#yScaleInstance) {
			this.#yScaleInstance.updatePanPosition(0, screenY);
		}
	};

	// Band scale support
	xCategoryPositions = $derived.by(() => {
		if (this.scaleTypes?.x !== 'band' || !this.xScale || !this.layout.isReady) return null;
		const domain = this.#xScaleInstance?.effectiveDomain;
		if (!domain || domain.length === 0) return null;
		return new Float32Array(domain.map((d) => this.xScale(d)));
	});

	yCategoryPositions = $derived.by(() => {
		if (this.scaleTypes?.y !== 'band' || !this.yScale || !this.layout.isReady) return null;
		const domain = this.#yScaleInstance?.effectiveDomain;
		if (!domain || domain.length === 0) return null;
		return new Float32Array(domain.map((d) => this.yScale(d)));
	});

	categoryPositionsReady = $derived.by(() => {
		const xReady = this.scaleTypes?.x !== 'band' || this.xCategoryPositions !== null;
		const yReady = this.scaleTypes?.y !== 'band' || this.yCategoryPositions !== null;
		return xReady && yReady;
	});

	xBandwidth = $derived.by(() => {
		if (this.scaleTypes?.x !== 'band' || !this.baseXScale || !this.layout.isReady) return 0;
		return this.baseXScale.bandwidth();
	});

	yBandwidth = $derived.by(() => {
		if (this.scaleTypes?.y !== 'band' || !this.baseYScale || !this.layout.isReady) return 0;
		return this.baseYScale.bandwidth();
	});

	adjustBinMultiplier(delta) {
		// Clamp between 0.1x (coarse) and 20x (fine)
		const current = this.binStepMultiplier;

		// Multiplicative: delta is a percentage of current value
		// e.g., delta=0.2 means 20% change relative to current
		const absoluteDelta = current * delta;
		const newValue = Math.max(0.1, Math.min(20.0, current + absoluteDelta));

		// Only update if changed significantly
		if (Math.abs(newValue - current) > 0.001) {
			this.binStepMultiplier = newValue;
		}
	}

	// Context data for child components
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
			getScaleRequirementsSummary: coordinator.getScaleRequirementsSummary,
			get binStepMultiplier() {
				return coordinator.binStepMultiplier;
			},
			adjustBinMultiplier: (d) => coordinator.adjustBinMultiplier(d)
		};
	}

	destroy() {
		console.log(`💥 ChartScales destroying for chart ${this.chartId}`);

		// const scaleRegistry = getContext('scale-registry');
		if (this.#scaleRegistry) {
			this.#scaleRegistry.removeChartUsage(this.chartId);
			// Remove this chart from all scales it's using
			// if (this.#xScaleInstance && scaleRegistry.scaleUsage.has(this.#xScaleInstance)) {
			// 	scaleRegistry.scaleUsage.get(this.#xScaleInstance).delete(this.chartId);
			// }
			// if (this.#yScaleInstance && scaleRegistry.scaleUsage.has(this.#yScaleInstance)) {
			// 	scaleRegistry.scaleUsage.get(this.#yScaleInstance).delete(this.chartId);
			// }
		}

		this.#xScaleInstance = null;
		this.#yScaleInstance = null;
		this.#previousXScale = null;
		this.#previousYScale = null;
	}
}
