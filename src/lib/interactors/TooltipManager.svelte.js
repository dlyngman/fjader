// src/lib/interactors/TooltipManager.svelte.js

/**
 * TooltipManager - DB-first tooltip query service.
 *
 * Queries DuckDB temp tables (written by BaseMarkSetup) to find the nearest
 * data point to the cursor. Supports hit-test (bars/rects) and nearest-neighbor
 * (dots) query strategies.
 *
 * Driven by GPUCoordinator's animation loop via tick() — no separate RAF.
 * Skips tooltip queries when scales are animating (pan/zoom).
 *
 * Created per-chart and made available via Svelte context.
 */
export class TooltipManager {
	#coordinator;
	#chartScales;
	#marks = new Map(); // markId → config
	#queryPending = false;
	#latestPosition = null; // { xData, yData } — always the most recent cursor position
	#cursorActive = false; // True when cursor is over the chart, false when it leaves

	// Reactive state
	currentPoint = $state(null);
	currentMarkId = $state(null);
	currentMarkType = $state(null);
	currentColor = $state(null);
	currentColorField = $state(null);
	currentChannelFields = $state(null); // { x: 'bill_length', y: 'species', color: 'species' }
	visible = $state(false);
	pointerScreenX = $state(0);
	pointerScreenY = $state(0);
	matchedScreenX = $state(null);
	matchedScreenY = $state(null);

	/**
	 * @param {object} coordinator - Mosaic coordinator for DB queries
	 * @param {object} chartScales - ChartScales instance (provides currentXDataPoint, etc.)
	 */
	constructor(coordinator, chartScales) {
		this.#coordinator = coordinator;
		this.#chartScales = chartScales;
	}

	/**
	 * Update the cursor's data-space position. Called directly from pointer move handler.
	 */
	updatePosition(xData, yData) {
		if (xData == null && yData == null) {
			this.visible = false;
			this.#latestPosition = null;
			this.#cursorActive = false;
			this.matchedScreenX = null;
			this.matchedScreenY = null;
			return;
		}
		this.#cursorActive = true;
		this.#latestPosition = { xData, yData };
	}

	/**
	 * Register a mark for tooltip queries.
	 *
	 * @param {string} markId
	 * @param {object} config
	 * @param {string} config.tempTable - DuckDB temp table name
	 * @param {string} config.markType - 'dot', 'barX', 'bar', 'rect', etc.
	 * @param {object} config.scaleTypes - { x: 'linear'|'band'|'time', y: ... }
	 * @param {object} config.channelFields - Channel → field name { x: 'bill_length', y: 'species' }
	 * @param {object} [config.columns] - Column aliases for hit testing { xLow, xHigh, yLow, yHigh, x, y }
	 * @param {object} [config.bandDomains] - { y: ['Adelie', 'Gentoo', ...] } for band scales
	 * @param {string[]} [config.colorDomain] - Color category labels (ordinal)
	 * @param {object} [config.colorScaleState] - ColorScaleState for CSS color lookup via getColor()
	 * @param {boolean} [config.enabled=true]
	 */
	registerMark(markId, config) {
		this.#marks.set(markId, { enabled: true, ...config });
	}

	unregisterMark(markId) {
		this.#marks.delete(markId);
		if (this.currentMarkId === markId) {
			this.visible = false;
			this.currentPoint = null;
			this.currentMarkId = null;
		}
	}

	/**
	 * Update raw screen position for tooltip positioning.
	 * Called from chart container's pointer move handler.
	 */
	updatePointerScreen(x, y) {
		this.pointerScreenX = x;
		this.pointerScreenY = y;
	}

	// =========================================================================
	// QUERY SCHEDULING (driven by animation loop)
	// =========================================================================

	/**
	 * Called once per animation frame by GPUCoordinator's render loop.
	 * @param {boolean} isAnimating - true when scales are actively animating (pan/zoom)
	 */
	tick(isAnimating) {
		// Hide tooltip during pan/zoom — screen positions become stale
		if (isAnimating) {
			this.visible = false;
			return;
		}

		// If there's a new position and no query in flight, execute
		if (this.#latestPosition && !this.#queryPending) {
			this.#executeLatest();
		}
	}

	async #executeLatest() {
		if (!this.#latestPosition || this.#queryPending) return;

		const { xData, yData } = this.#latestPosition;
		this.#latestPosition = null;
		this.#queryPending = true;

		try {
			// Build all queries and execute in parallel
			const queryPromises = [];
			for (const [markId, config] of this.#marks) {
				if (!config.enabled) continue;

				const sql = this.#buildQuery(config, xData, yData);
				if (!sql) continue;

				queryPromises.push(
					this.#coordinator
						.query(sql)
						.then((result) => ({
							markId,
							config,
							row: Array.from(result)[0]
						}))
						.catch(() => null) // Skip marks whose temp table doesn't exist yet
				);
			}

			const results = await Promise.allSettled(queryPromises);

			// Only discard if cursor left the chart entirely
			if (!this.#cursorActive) return;

			let bestResult = null;
			let bestDistance = Infinity;
			let bestMarkId = null;
			let bestConfig = null;

			for (const r of results) {
				if (r.status !== 'fulfilled' || !r.value?.row) continue;
				const { markId, config, row } = r.value;
				const dist = row._distance ?? 0;
				if (dist < bestDistance) {
					bestDistance = dist;
					bestResult = row;
					bestMarkId = markId;
					bestConfig = config;
				}
			}

			if (bestResult && bestConfig) {
				const resolved = this.#resolveLabels(bestResult, bestConfig);
				this.currentPoint = resolved;
				this.currentMarkId = bestMarkId;
				this.currentMarkType = bestConfig.markType;
				this.visible = true;

				this.currentChannelFields = bestConfig.channelFields ?? null;

				// Resolve color swatch
				const colorFieldName = bestConfig.channelFields?.color || 'color';
				const colorValue = resolved[colorFieldName];
				this.currentColorField = colorValue != null ? colorFieldName : null;
				this.currentColor = colorValue != null
					? bestConfig.colorScaleState?.getColor(colorValue) ?? null
					: null;

				// Compute matched point screen position from raw data-space values
				const xScale = this.#chartScales.xScale;
				const yScale = this.#chartScales.yScale;
				const cols = bestConfig.columns;

				this.matchedScreenX = this.#resolveScreenPos(
					'x', bestResult, bestConfig, xScale, cols
				);
				this.matchedScreenY = this.#resolveScreenPos(
					'y', bestResult, bestConfig, yScale, cols
				);
			} else {
				this.visible = false;
			}
		} catch (error) {
			console.error('Tooltip query failed:', error);
			this.visible = false;
		} finally {
			this.#queryPending = false;

			// If a newer position arrived while we were querying, execute immediately
			if (this.#latestPosition) {
				this.#executeLatest();
			}
		}
	}

	// =========================================================================
	// QUERY BUILDING
	// =========================================================================

	#buildQuery(config, xData, yData) {
		const { markType } = config;

		if (markType === 'barX' || markType === 'bar' || markType === 'rect') {
			return this.#buildHitTestQuery(config, xData, yData);
		}
		return this.#buildNearestQuery(config, xData, yData);
	}

	#buildHitTestQuery(config, xData, yData) {
		const { tempTable, scaleTypes, columns } = config;
		const conditions = [];

		// Y axis
		if (scaleTypes.y === 'band' && yData != null) {
			const col = columns?.y || 'y';
			conditions.push(`CAST(${col} AS INTEGER) = ${Math.round(yData)}`);
		} else if (yData != null) {
			const low = columns?.yLow ?? 'y0';
			const high = columns?.yHigh ?? 'y1';
			const lowExpr = typeof low === 'number' ? low : `CAST(${low} AS DOUBLE)`;
			const highExpr = typeof high === 'number' ? high : `CAST(${high} AS DOUBLE)`;
			conditions.push(
				`CAST(${yData} AS DOUBLE) BETWEEN LEAST(${lowExpr}, ${highExpr}) AND GREATEST(${lowExpr}, ${highExpr})`
			);
		}

		// X axis
		if (scaleTypes.x === 'band' && xData != null) {
			const col = columns?.x || 'x';
			conditions.push(`CAST(${col} AS INTEGER) = ${Math.round(xData)}`);
		} else if (xData != null) {
			const low = columns?.xLow ?? 'x0';
			const high = columns?.xHigh ?? 'x1';
			const lowExpr = typeof low === 'number' ? low : `CAST(${low} AS DOUBLE)`;
			const highExpr = typeof high === 'number' ? high : `CAST(${high} AS DOUBLE)`;
			conditions.push(
				`CAST(${xData} AS DOUBLE) BETWEEN LEAST(${lowExpr}, ${highExpr}) AND GREATEST(${lowExpr}, ${highExpr})`
			);
		}

		if (conditions.length === 0) return null;

		return `SELECT *, 0 AS _distance FROM "${tempTable}" WHERE ${conditions.join(' AND ')} LIMIT 1`;
	}

	#buildNearestQuery(config, xData, yData) {
		const { tempTable, scaleTypes } = config;
		const distParts = [];
		const bbConditions = []; // bounding box (applied in inner query)
		const boundingBoxPx = 50;
		const dismissPxSq = 30 * 30;

		const xScale = this.#chartScales.xScale;
		const yScale = this.#chartScales.yScale;

		// X axis (x/y are pre-cast to DOUBLE during tooltip table creation)
		if (scaleTypes.x === 'band' && xData != null) {
			bbConditions.push(`CAST(x AS INTEGER) = ${Math.round(xData)}`);
		} else if (xData != null) {
			if (xScale) {
				const x0 = xScale.invert(xScale(xData) - boundingBoxPx);
				const x1 = xScale.invert(xScale(xData) + boundingBoxPx);
				bbConditions.push(
					`x BETWEEN ${Math.min(x0, x1)} AND ${Math.max(x0, x1)}`
				);

				const pxPerUnit = xScale(xData + 1) - xScale(xData);
				const pxSq = pxPerUnit * pxPerUnit;
				distParts.push(
					`(x - ${xData}) * (x - ${xData}) * ${pxSq}`
				);
			} else {
				distParts.push(
					`(x - ${xData}) * (x - ${xData})`
				);
			}
		}

		// Y axis
		if (scaleTypes.y === 'band' && yData != null) {
			bbConditions.push(`CAST(y AS INTEGER) = ${Math.round(yData)}`);
		} else if (yData != null) {
			if (yScale) {
				const y0 = yScale.invert(yScale(yData) - boundingBoxPx);
				const y1 = yScale.invert(yScale(yData) + boundingBoxPx);
				bbConditions.push(
					`y BETWEEN ${Math.min(y0, y1)} AND ${Math.max(y0, y1)}`
				);

				const pxPerUnit = yScale(yData + 1) - yScale(yData);
				const pxSq = pxPerUnit * pxPerUnit;
				distParts.push(
					`(y - ${yData}) * (y - ${yData}) * ${pxSq}`
				);
			} else {
				distParts.push(
					`(y - ${yData}) * (y - ${yData})`
				);
			}
		}

		const distExpr = distParts.length > 0 ? distParts.join(' + ') : '0';
		const bbWhere =
			bbConditions.length > 0
				? `WHERE ${bbConditions.join(' AND ')}`
				: '';

		// Subquery: bounding box filter + compute distance once.
		// Outer query: dismiss threshold + ORDER BY on the already-computed column.
		const inner = `SELECT *, ${distExpr} AS _distance FROM "${tempTable}" ${bbWhere}`;

		if (distParts.length > 0) {
			return `SELECT * FROM (${inner}) WHERE _distance <= ${dismissPxSq} ORDER BY _distance LIMIT 1`;
		}
		return `${inner} ORDER BY _distance LIMIT 1`;
	}

	// =========================================================================
	// SCREEN POSITION RESOLUTION
	// =========================================================================

	/**
	 * Resolve screen position for one axis from a query result row.
	 * Handles band scales (index → category string) and range columns (x1/x2 midpoint).
	 */
	#resolveScreenPos(axis, row, config, scale, columns) {
		if (!scale) return null;

		// Band scale: convert integer index to category string, center in band
		if (config.scaleTypes[axis] === 'band' && config.bandDomains?.[axis]) {
			const col = columns?.[axis] || axis;
			const index = row[col];
			if (index == null) return null;
			const category = config.bandDomains[axis][index];
			if (category == null) return null;
			const pos = scale(category);
			const bandwidth = scale.bandwidth ? scale.bandwidth() : 0;
			return pos != null ? pos + bandwidth / 2 : null;
		}

		// Range columns (bars): use midpoint of low/high
		const lowKey = axis === 'x' ? 'xLow' : 'yLow';
		const highKey = axis === 'x' ? 'xHigh' : 'yHigh';
		if (columns?.[lowKey] && columns?.[highKey]) {
			const low = row[columns[lowKey]];
			const high = row[columns[highKey]];
			if (low != null && high != null) {
				return scale((low + high) / 2);
			}
			return null;
		}

		// Single value column (dots)
		const val = row[axis];
		return val != null ? scale(val) : null;
	}

	// =========================================================================
	// LABEL RESOLUTION
	// =========================================================================

	/**
	 * Resolve band indices, time offsets, and color indices back to human-readable labels.
	 * Renames columns from aliases (x, y, color) to original field names.
	 */
	#resolveLabels(row, config) {
		const { scaleTypes, channelFields, bandDomains, colorDomain } = config;
		const point = {};

		for (const [key, value] of Object.entries(row)) {
			// Skip internal columns
			if (key.startsWith('_') || key.startsWith('__dplot_')) continue;

			const fieldName = channelFields?.[key] || key;

			// Resolve band index to category label
			if (
				(key === 'x' || key === 'y') &&
				scaleTypes[key] === 'band' &&
				bandDomains?.[key]
			) {
				const label = bandDomains[key][value];
				point[fieldName] = label ?? value;
				continue;
			}

			// Resolve time offset to formatted datetime string
			if (
				(key === 'x' || key === 'x1' || key === 'x2') &&
				scaleTypes.x === 'time' &&
				typeof value === 'number'
			) {
				const scaleState = this.#chartScales.xScaleState;
				point[fieldName] = scaleState?.formatTooltipValue?.(value) ?? value;
				continue;
			}
			if (
				(key === 'y' || key === 'y1' || key === 'y2') &&
				scaleTypes.y === 'time' &&
				typeof value === 'number'
			) {
				const scaleState = this.#chartScales.yScaleState;
				point[fieldName] = scaleState?.formatTooltipValue?.(value) ?? value;
				continue;
			}

			// Resolve color index to label
			if (key === 'color' && colorDomain) {
				const label = colorDomain[value];
				point[fieldName] = label ?? value;
				continue;
			}

			point[fieldName] = value;
		}

		return point;
	}

	// =========================================================================
	// LIFECYCLE
	// =========================================================================

	destroy() {
		this.#marks.clear();
		this.visible = false;
		this.currentPoint = null;
		this.currentMarkId = null;
		this.currentMarkType = null;
		this.currentColor = null;
		this.currentColorField = null;
		this.currentChannelFields = null;
		this.matchedScreenX = null;
		this.matchedScreenY = null;
	}
}
