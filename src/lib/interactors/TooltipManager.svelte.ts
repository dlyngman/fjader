// src/lib/interactors/TooltipManager.svelte.ts

import type { Coordinator } from '@uwdata/mosaic-core';
import type { D3Scale, D3BandScale, ScaleStateInstance } from '$lib/types';
import type { TimeScaleState } from '$lib/scales/TimeScaleState.svelte';
import { isTemporalScale } from '$lib/scales/scale-categories';

type DataRow = Record<string, unknown>;

interface TooltipMarkRegistration {
	tempTable: string;
	markType: string;
	scaleTypes: { x: string; y: string };
	channelFields?: Record<string, string>;
	columns?: {
		xLow?: string | number;
		xHigh?: string | number;
		yLow?: string | number;
		yHigh?: string | number;
		x?: string;
		y?: string;
	};
	colorColumn?: string;
	bandDomains?: Record<string, string[]>;
	colorDomain?: string[];
	colorScaleState?: { getColor: (value: unknown) => string | null };
	enabled: boolean;
}

interface ScaleProvider {
	xScale: D3Scale | null;
	yScale: D3Scale | null;
	xScaleState: ScaleStateInstance | null;
	yScaleState: ScaleStateInstance | null;
}

interface CursorPosition {
	xData: number | null;
	yData: number | null;
}

interface QueryResult {
	markId: string;
	config: TooltipMarkRegistration;
	row: DataRow;
}

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
	#coordinator: Coordinator;
	#scaleProvider: ScaleProvider;
	#marks: Map<string, TooltipMarkRegistration> = new Map();
	#queryPending: boolean = false;
	#latestPosition: CursorPosition | null = null;
	#cursorActive: boolean = false;
	#suppressUntil: number = 0;

	// Reactive state
	currentPoint: DataRow | null = $state(null);
	currentMarkId: string | null = $state(null);
	currentMarkType: string | null = $state(null);
	currentColor: string | null = $state(null);
	currentColorField: string | null = $state(null);
	currentChannelFields: Record<string, string> | null = $state(null);
	visible: boolean = $state(false);
	pointerScreenX: number = $state(0);
	pointerScreenY: number = $state(0);
	matchedScreenX: number | null = $state(null);
	matchedScreenY: number | null = $state(null);

	constructor(coordinator: Coordinator, scaleProvider: ScaleProvider) {
		this.#coordinator = coordinator;
		this.#scaleProvider = scaleProvider;
	}

	/**
	 * Update the cursor's data-space position. Called directly from pointer move handler.
	 */
	updatePosition(xData: number | null, yData: number | null): void {
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
	 * Suppress tooltip queries for the given duration.
	 * Call from interaction handlers (pan, zoom, reset) to block tooltips
	 * during active interaction. Each call extends the suppression window.
	 */
	suppress(durationMs: number): void {
		this.#suppressUntil = performance.now() + durationMs;
		this.visible = false;
	}

	/**
	 * Register a mark for tooltip queries.
	 */
	registerMark(
		markId: string,
		config: Omit<TooltipMarkRegistration, 'enabled'> & { enabled?: boolean }
	): void {
		this.#marks.set(markId, { enabled: true, ...config });
	}

	unregisterMark(markId: string): void {
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
	updatePointerScreen(x: number, y: number): void {
		this.pointerScreenX = x;
		this.pointerScreenY = y;
	}

	// =========================================================================
	// QUERY SCHEDULING (driven by animation loop)
	// =========================================================================

	/**
	 * Called once per animation frame by GPUCoordinator's render loop.
	 */
	tick(): void {
		// Suppressed by active interaction (pan, zoom, reset)
		if (performance.now() < this.#suppressUntil) {
			this.visible = false;
			return;
		}

		// If there's a new position and no query in flight, execute
		if (this.#latestPosition && !this.#queryPending) {
			this.#executeLatest();
		}
	}

	async #executeLatest(): Promise<void> {
		if (!this.#latestPosition || this.#queryPending) return;

		const { xData, yData } = this.#latestPosition;
		this.#latestPosition = null;
		this.#queryPending = true;

		try {
			// Build all queries and execute in parallel
			const queryPromises: Promise<QueryResult | null>[] = [];
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

			let bestResult: DataRow | null = null;
			let bestDistance = Infinity;
			let bestMarkId: string | null = null;
			let bestConfig: TooltipMarkRegistration | null = null;

			for (const r of results) {
				if (r.status !== 'fulfilled' || !r.value?.row) continue;
				const { markId, config, row } = r.value;
				const dist = (row._distance as number) ?? 0;
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

				// Resolve color swatch — use the actual color channel (fill/stroke) from colorColumn
				const colorCol = bestConfig.colorColumn;
				const colorFieldName = colorCol ? (bestConfig.channelFields?.[colorCol] ?? colorCol) : null;
				const colorValue = colorFieldName ? resolved[colorFieldName] : undefined;
				this.currentColorField = colorValue != null ? colorFieldName : null;
				this.currentColor =
					colorValue != null ? (bestConfig.colorScaleState?.getColor(colorValue) ?? null) : null;

				// Compute matched point screen position from raw data-space values
				const xScale = this.#scaleProvider.xScale;
				const yScale = this.#scaleProvider.yScale;
				const cols = bestConfig.columns;

				this.matchedScreenX = this.#resolveScreenPos('x', bestResult, bestConfig, xScale, cols);
				this.matchedScreenY = this.#resolveScreenPos('y', bestResult, bestConfig, yScale, cols);
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

	#buildQuery(
		config: TooltipMarkRegistration,
		xData: number | null,
		yData: number | null
	): string | null {
		const { markType } = config;

		const hitTestMarks = ['barx', 'bary', 'rect', 'rectx', 'recty'];
		if (hitTestMarks.includes(markType)) {
			return this.#buildHitTestQuery(config, xData, yData);
		}
		return this.#buildNearestQuery(config, xData, yData);
	}

	#buildHitTestQuery(
		config: TooltipMarkRegistration,
		xData: number | null,
		yData: number | null
	): string | null {
		const { tempTable, scaleTypes, columns } = config;
		const conditions: string[] = [];

		// Y axis
		if (scaleTypes.y === 'band' && yData != null) {
			const col = columns?.y || 'y';
			conditions.push(`CAST("${col}" AS INTEGER) = ${Math.round(yData)}`);
		} else if (yData != null) {
			const low = columns?.yLow ?? 'y0';
			const high = columns?.yHigh ?? 'y1';
			const lowExpr = typeof low === 'number' ? low : `CAST("${low}" AS DOUBLE)`;
			const highExpr = typeof high === 'number' ? high : `CAST("${high}" AS DOUBLE)`;
			conditions.push(
				`CAST(${yData} AS DOUBLE) BETWEEN LEAST(${lowExpr}, ${highExpr}) AND GREATEST(${lowExpr}, ${highExpr})`
			);
		}

		// X axis
		if (scaleTypes.x === 'band' && xData != null) {
			const col = columns?.x || 'x';
			conditions.push(`CAST("${col}" AS INTEGER) = ${Math.round(xData)}`);
		} else if (xData != null) {
			const low = columns?.xLow ?? 'x0';
			const high = columns?.xHigh ?? 'x1';
			const lowExpr = typeof low === 'number' ? low : `CAST("${low}" AS DOUBLE)`;
			const highExpr = typeof high === 'number' ? high : `CAST("${high}" AS DOUBLE)`;
			conditions.push(
				`CAST(${xData} AS DOUBLE) BETWEEN LEAST(${lowExpr}, ${highExpr}) AND GREATEST(${lowExpr}, ${highExpr})`
			);
		}

		if (conditions.length === 0) return null;

		return `SELECT *, 0 AS _distance FROM "${tempTable}" WHERE ${conditions.join(' AND ')} LIMIT 1`;
	}

	#buildNearestQuery(
		config: TooltipMarkRegistration,
		xData: number | null,
		yData: number | null
	): string | null {
		const { tempTable, scaleTypes, columns } = config;
		const distParts: string[] = [];
		const bbConditions: string[] = [];
		const boundingBoxPx = 50;
		const dismissPxSq = 30 * 30;

		const xScale = this.#scaleProvider.xScale;
		const yScale = this.#scaleProvider.yScale;

		// Column overrides (e.g., stacked areas use y1 instead of y)
		const xCol = columns?.x || 'x';
		const yCol = columns?.y || 'y';

		// X axis (x/y are pre-cast to DOUBLE during tooltip table creation)
		if (scaleTypes.x === 'band' && xData != null) {
			bbConditions.push(`CAST(${xCol} AS INTEGER) = ${Math.round(xData)}`);
		} else if (xData != null) {
			if (xScale) {
				const x0 = xScale.invert!(xScale(xData) - boundingBoxPx);
				const x1 = xScale.invert!(xScale(xData) + boundingBoxPx);
				bbConditions.push(`${xCol} BETWEEN ${Math.min(x0 as number, x1 as number)} AND ${Math.max(x0 as number, x1 as number)}`);

				const pxPerUnit = xScale(xData + 1) - xScale(xData);
				const pxSq = pxPerUnit * pxPerUnit;
				distParts.push(`(${xCol} - ${xData}) * (${xCol} - ${xData}) * ${pxSq}`);
			} else {
				distParts.push(`(${xCol} - ${xData}) * (${xCol} - ${xData})`);
			}
		}

		// Y axis
		if (scaleTypes.y === 'band' && yData != null) {
			bbConditions.push(`CAST(${yCol} AS INTEGER) = ${Math.round(yData)}`);
		} else if (yData != null) {
			if (yScale) {
				const y0 = yScale.invert!(yScale(yData) - boundingBoxPx);
				const y1 = yScale.invert!(yScale(yData) + boundingBoxPx);
				bbConditions.push(`${yCol} BETWEEN ${Math.min(y0 as number, y1 as number)} AND ${Math.max(y0 as number, y1 as number)}`);

				const pxPerUnit = yScale(yData + 1) - yScale(yData);
				const pxSq = pxPerUnit * pxPerUnit;
				distParts.push(`(${yCol} - ${yData}) * (${yCol} - ${yData}) * ${pxSq}`);
			} else {
				distParts.push(`(${yCol} - ${yData}) * (${yCol} - ${yData})`);
			}
		}

		const distExpr = distParts.length > 0 ? distParts.join(' + ') : '0';
		const bbWhere = bbConditions.length > 0 ? `WHERE ${bbConditions.join(' AND ')}` : '';

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
	#resolveScreenPos(
		axis: 'x' | 'y',
		row: DataRow,
		config: TooltipMarkRegistration,
		scale: D3Scale | null,
		columns: TooltipMarkRegistration['columns']
	): number | null {
		if (!scale) return null;

		// Band scale: convert integer index to category string, center in band
		if (config.scaleTypes[axis] === 'band' && config.bandDomains?.[axis]) {
			const col = columns?.[axis] || axis;
			const index = row[col as string];
			if (index == null) return null;
			const category = config.bandDomains[axis]![index as number];
			if (category == null) return null;
			const pos = scale(category);
			const bandwidth = 'bandwidth' in scale ? (scale as D3BandScale).bandwidth() : 0;
			return pos != null ? pos + bandwidth / 2 : null;
		}

		// Range columns (bars): use midpoint of low/high
		const lowKey = axis === 'x' ? 'xLow' : 'yLow';
		const highKey = axis === 'x' ? 'xHigh' : 'yHigh';
		if (columns?.[lowKey] && columns?.[highKey]) {
			const low = row[columns[lowKey] as string];
			const high = row[columns[highKey] as string];
			if (low != null && high != null) {
				return scale(((low as number) + (high as number)) / 2);
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
	#resolveLabels(row: DataRow, config: TooltipMarkRegistration): DataRow {
		const { scaleTypes, channelFields, bandDomains, colorDomain } = config;
		const point: DataRow = {};

		for (const [key, value] of Object.entries(row)) {
			// Skip internal columns
			if (key.startsWith('_') || key.startsWith('__dplot_')) continue;

			const fieldName = channelFields?.[key] || key;

			// Resolve band index to category label
			if ((key === 'x' || key === 'y') && scaleTypes[key] === 'band' && bandDomains?.[key]) {
				const label = bandDomains[key]![value as number];
				point[fieldName] = label ?? value;
				continue;
			}

			// Resolve time offset to formatted datetime string
			if (
				(key === 'x' || key === 'x1' || key === 'x2') &&
				isTemporalScale(scaleTypes.x) &&
				typeof value === 'number'
			) {
				const scaleState = this.#scaleProvider.xScaleState;
				point[fieldName] = scaleState && isTemporalScale(scaleState.scaleType)
					? (scaleState as TimeScaleState).formatTooltipValue(value) ?? value
					: value;
				continue;
			}
			if (
				(key === 'y' || key === 'y1' || key === 'y2') &&
				isTemporalScale(scaleTypes.y) &&
				typeof value === 'number'
			) {
				const scaleState = this.#scaleProvider.yScaleState;
				point[fieldName] = scaleState && isTemporalScale(scaleState.scaleType)
					? (scaleState as TimeScaleState).formatTooltipValue(value) ?? value
					: value;
				continue;
			}

			// Resolve color column: index → label (ordinal) or rename to field name (sequential)
			const colorCol = config.colorColumn;
			if (colorCol && key === colorCol) {
				const resolvedName = channelFields?.[key] || key;
				if (colorDomain) {
					const label = colorDomain[value as number];
					point[resolvedName] = label ?? value;
				} else {
					point[resolvedName] = value;
				}
				continue;
			}

			point[fieldName] = value;
		}

		return point;
	}

	// =========================================================================
	// LIFECYCLE
	// =========================================================================

	destroy(): void {
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
