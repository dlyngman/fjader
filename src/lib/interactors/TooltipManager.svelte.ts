// src/lib/interactors/TooltipManager.svelte.ts

import type { Coordinator } from '@uwdata/mosaic-core';
import type { D3Scale, D3BandScale, ScaleStateInstance } from '$lib/types';
import type { TimeScaleState } from '$lib/scales/TimeScaleState.svelte';
import { isTemporalScale } from '$lib/scales/scale-categories';

type DataRow = Record<string, unknown>;

export interface MatchedPoint {
	screenX: number | null;
	screenY: number | null;
	color: string | null;
}

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
	constantColor?: string;
	bandDomains?: Record<string, string[]>;
	colorDomain?: string[];
	colorScaleState?: { getColor: (value: unknown) => string | null };
	sizeScaleState?: { getRenderedRadius: (value: number) => number };
	constantRadius?: number;
	displayFields?: string[] | null;
	proximityAxis: 'x' | 'y' | 'xy';
	enabled: boolean;
}

interface ScaleProvider {
	xScale: D3Scale | null;
	yScale: D3Scale | null;
	xScaleState: ScaleStateInstance | null;
	yScaleState: ScaleStateInstance | null;
}

interface QueryResult {
	markId: string;
	config: TooltipMarkRegistration;
	rows: DataRow[];
}

/**
 * TooltipManager - DB-first tooltip query service.
 *
 * Queries DuckDB temp tables (written by BaseMarkSetup) to find the nearest
 * data point(s) to the cursor. Returns multiple co-located points when they
 * share the same (or nearly same) position — e.g., multi-series lines at the
 * same x, or overlapping dots in a dense scatter plot.
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
	#pendingX: number | null = null;
	#pendingY: number | null = null;
	#hasPending: boolean = false;
	#cursorActive: boolean = false;
	#suppressUntil: number = 0;
	#stickyCategory: unknown = null;

	// Reactive state — multi-point with focused index
	currentPoints: DataRow[] = $state([]);
	matchedPoints: MatchedPoint[] = $state([]);
	focusedIndex: number = $state(0);
	currentMarkId: string | null = $state(null);
	currentMarkType: string | null = $state(null);
	currentColorField: string | null = $state(null);
	currentChannelFields: Record<string, string> | null = $state(null);
	currentDisplayFields: string[] | null = $state(null);
	visible: boolean = $state(false);
	pointerScreenX: number = $state(0);
	pointerScreenY: number = $state(0);
	matchedRadius: number | null = $state(null);

	// Focused point getters — used by Tooltip and HoverIndicator
	get focusedPoint(): DataRow | null {
		return this.currentPoints[this.focusedIndex] ?? null;
	}
	get focusedMatch(): MatchedPoint | null {
		return this.matchedPoints[this.focusedIndex] ?? null;
	}

	// Backwards-compat getters
	get currentPoint(): DataRow | null {
		return this.currentPoints[0] ?? null;
	}
	get currentColor(): string | null {
		return this.matchedPoints[0]?.color ?? null;
	}
	get matchedScreenX(): number | null {
		return this.matchedPoints[0]?.screenX ?? null;
	}
	get matchedScreenY(): number | null {
		return this.matchedPoints[0]?.screenY ?? null;
	}

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
			this.#hasPending = false;
			this.#cursorActive = false;
			this.matchedPoints = [];
			this.focusedIndex = 0;
			this.#stickyCategory = null;
			return;
		}
		this.#cursorActive = true;
		this.#pendingX = xData;
		this.#pendingY = yData;
		this.#hasPending = true;
	}

	/**
	 * Cycle the focused point index by delta. Wraps around.
	 * Remembers the focused category so it persists across cursor moves.
	 */
	cycleFocused(delta: number): void {
		const n = this.currentPoints.length;
		if (n <= 1) return;
		this.focusedIndex = ((this.focusedIndex + delta) % n + n) % n;
		// Remember the category so we can restore it after the next query
		const colorField = this.currentColorField;
		if (colorField) {
			this.#stickyCategory = this.currentPoints[this.focusedIndex]?.[colorField] ?? null;
		}
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
		config: Omit<TooltipMarkRegistration, 'enabled' | 'proximityAxis'> & {
			enabled?: boolean;
			proximityAxis?: 'x' | 'y' | 'xy';
		}
	): void {
		this.#marks.set(markId, { proximityAxis: 'xy', enabled: true, ...config });
	}

	unregisterMark(markId: string): void {
		this.#marks.delete(markId);
		if (this.currentMarkId === markId) {
			this.visible = false;
			this.currentPoints = [];
			this.matchedPoints = [];
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
		if (this.#hasPending && !this.#queryPending) {
			this.#executeLatest();
		}
	}

	async #executeLatest(): Promise<void> {
		if (!this.#hasPending || this.#queryPending) return;

		const xData = this.#pendingX;
		const yData = this.#pendingY;
		this.#hasPending = false;
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
						.then((result) => {
							const rows = Array.from(result) as DataRow[];
							return rows.length > 0 ? { markId, config, rows } : null;
						})
						.catch(() => null) // Skip marks whose temp table doesn't exist yet
				);
			}

			const results = await Promise.allSettled(queryPromises);

			// Only discard if cursor left the chart entirely
			if (!this.#cursorActive) return;

			// Find the best mark (lowest distance among first rows)
			let bestDistance = Infinity;
			let bestResult: QueryResult | null = null;

			for (const r of results) {
				if (r.status !== 'fulfilled' || !r.value) continue;
				const { rows } = r.value;
				const dist = (rows[0]._distance as number) ?? 0;
				if (dist < bestDistance) {
					bestDistance = dist;
					bestResult = r.value;
				}
			}

			if (bestResult && this.#marks.has(bestResult.markId)) {
				const { config, markId, rows } = bestResult;
				const xScale = this.#scaleProvider.xScale;
				const yScale = this.#scaleProvider.yScale;
				const cols = config.columns;
				const colorCol = config.colorColumn;

				// Resolve all matched rows
				const resolvedPoints: DataRow[] = [];
				const matched: MatchedPoint[] = [];
				const colorFieldName = colorCol ? (config.channelFields?.[colorCol] ?? colorCol) : null;

				for (const row of rows) {
					const resolved = this.#resolveLabels(row, config);
					resolvedPoints.push(resolved);

					const screenX = this.#resolveScreenPos('x', row, config, xScale, cols);
					const screenY = this.#resolveScreenPos('y', row, config, yScale, cols);

					const colorValue = colorFieldName ? resolved[colorFieldName] : undefined;
					const color =
						colorValue != null
							? (config.colorScaleState?.getColor(colorValue) ?? null)
							: (config.constantColor ?? null);

					matched.push({ screenX, screenY, color });
				}

				this.currentPoints = resolvedPoints;
				this.matchedPoints = matched;
				this.currentMarkId = markId;
				this.currentMarkType = config.markType;
				this.currentChannelFields = config.channelFields ?? null;
				this.currentDisplayFields = config.displayFields ?? null;
				this.matchedRadius = this.#resolveRadius(rows[0], config);
				this.visible = true;

				const firstColorValue = colorFieldName ? resolvedPoints[0]?.[colorFieldName] : undefined;
				this.currentColorField = firstColorValue != null ? colorFieldName : null;

				// Restore focused index to sticky category, or default to 0
				if (this.#stickyCategory != null && colorFieldName) {
					const idx = resolvedPoints.findIndex(
						(pt) => pt[colorFieldName] === this.#stickyCategory
					);
					this.focusedIndex = idx >= 0 ? idx : 0;
				} else {
					this.focusedIndex = 0;
				}
			} else {
				this.visible = false;
			}
		} catch (error) {
			console.error('Tooltip query failed:', error);
			this.visible = false;
		} finally {
			this.#queryPending = false;

			// If a newer position arrived while we were querying, execute immediately
			if (this.#hasPending) {
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

		return `SELECT *, 0 AS _distance FROM "${tempTable}" WHERE ${conditions.join(' AND ')} LIMIT 20`;
	}

	#buildNearestQuery(
		config: TooltipMarkRegistration,
		xData: number | null,
		yData: number | null
	): string | null {
		const { tempTable, scaleTypes, columns, proximityAxis } = config;
		const distParts: string[] = [];
		const bbConditions: string[] = [];
		const boundingBoxPx = 50;
		const dismissPxSq = 30 * 30;
		// Tolerance for co-located points — only match points at effectively the same distance
		const tolerancePxSq = 0.01;

		const xScale = this.#scaleProvider.xScale;
		const yScale = this.#scaleProvider.yScale;

		// Column overrides (e.g., stacked areas use y1 instead of y)
		const xCol = columns?.x || 'x';
		const yCol = columns?.y || 'y';

		const useX = proximityAxis === 'x' || proximityAxis === 'xy';
		const useY = proximityAxis === 'y' || proximityAxis === 'xy';

		// X axis (x/y are pre-cast to DOUBLE during tooltip table creation)
		if (useX && scaleTypes.x === 'band' && xData != null) {
			bbConditions.push(`CAST(${xCol} AS INTEGER) = ${Math.round(xData)}`);
		} else if (useX && xData != null) {
			if (xScale) {
				const x0 = xScale.invert!(xScale(xData) - boundingBoxPx);
				const x1 = xScale.invert!(xScale(xData) + boundingBoxPx);
				bbConditions.push(
					`${xCol} BETWEEN ${Math.min(x0 as number, x1 as number)} AND ${Math.max(x0 as number, x1 as number)}`
				);

				const pxPerUnit = xScale(xData + 1) - xScale(xData);
				const pxSq = pxPerUnit * pxPerUnit;
				distParts.push(`(${xCol} - ${xData}) * (${xCol} - ${xData}) * ${pxSq}`);
			} else {
				distParts.push(`(${xCol} - ${xData}) * (${xCol} - ${xData})`);
			}
		}

		// Y axis
		if (useY && scaleTypes.y === 'band' && yData != null) {
			bbConditions.push(`CAST(${yCol} AS INTEGER) = ${Math.round(yData)}`);
		} else if (useY && yData != null) {
			if (yScale) {
				const y0 = yScale.invert!(yScale(yData) - boundingBoxPx);
				const y1 = yScale.invert!(yScale(yData) + boundingBoxPx);
				bbConditions.push(
					`${yCol} BETWEEN ${Math.min(y0 as number, y1 as number)} AND ${Math.max(y0 as number, y1 as number)}`
				);

				const pxPerUnit = yScale(yData + 1) - yScale(yData);
				const pxSq = pxPerUnit * pxPerUnit;
				distParts.push(`(${yCol} - ${yData}) * (${yCol} - ${yData}) * ${pxSq}`);
			} else {
				distParts.push(`(${yCol} - ${yData}) * (${yCol} - ${yData})`);
			}
		}

		const distExpr = distParts.length > 0 ? distParts.join(' + ') : '0';
		const bbWhere = bbConditions.length > 0 ? `WHERE ${bbConditions.join(' AND ')}` : '';
		const colorCol = config.colorColumn;

		// Window function: compute per-row distance + global minimum in one pass.
		// When colorColumn is set, deduplicate to one point per series (closest per partition).
		const dedupSelect = colorCol
			? `, ROW_NUMBER() OVER (PARTITION BY "${colorCol}" ORDER BY ${distExpr}) AS _rn`
			: '';
		const dedupFilter = colorCol ? ' AND _rn = 1' : '';
		const inner = `SELECT *, ${distExpr} AS _distance, MIN(${distExpr}) OVER () AS _min_distance${dedupSelect} FROM "${tempTable}" ${bbWhere}`;

		if (distParts.length > 0) {
			return `SELECT * FROM (${inner}) WHERE _distance <= _min_distance + ${tolerancePxSq} AND _distance <= ${dismissPxSq}${dedupFilter} ORDER BY _distance LIMIT 20`;
		}
		return `${inner} ORDER BY _distance LIMIT 20`;
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

		// Single value column (dots, lines, stacked areas with column override)
		const col = columns?.[axis] || axis;
		const val = row[col as string];
		return val != null ? scale(val) : null;
	}

	// =========================================================================
	// RADIUS RESOLUTION (for HoverIndicator sizing)
	// =========================================================================

	/**
	 * Resolve the rendered pixel radius of the matched point.
	 * For dots: data-driven via size scale, or constant r prop.
	 * For lines/areas: constant dotRadius prop (if set).
	 */
	#resolveRadius(row: DataRow, config: TooltipMarkRegistration): number | null {
		// Data-driven size (dots only): use the size scale
		if (config.sizeScaleState && row.r != null) {
			return config.sizeScaleState.getRenderedRadius(row.r as number);
		}

		// Constant radius (dots: r prop, lines/areas: dotRadius prop)
		return config.constantRadius ?? null;
	}

	// =========================================================================
	// LABEL RESOLUTION
	// =========================================================================

	/**
	 * Resolve band indices, time offsets, and color indices back to human-readable labels.
	 * Renames columns from aliases (x, y, color) to original field names.
	 */
	/** Resolve a single value: band index → label, time offset → formatted date. */
	#resolveValue(
		axis: 'x' | 'y',
		key: string,
		value: unknown,
		config: TooltipMarkRegistration
	): unknown {
		const { scaleTypes, bandDomains } = config;

		// Band index → category label
		if (
			(key === 'x' || key === 'y') &&
			scaleTypes[key] === 'band' &&
			bandDomains?.[key]
		) {
			return bandDomains[key]![value as number] ?? value;
		}

		// Time offset → formatted datetime
		if (
			key.startsWith(axis) &&
			isTemporalScale(scaleTypes[axis]) &&
			typeof value === 'number'
		) {
			const scaleState =
				axis === 'x' ? this.#scaleProvider.xScaleState : this.#scaleProvider.yScaleState;
			if (scaleState && isTemporalScale(scaleState.scaleType)) {
				return (scaleState as TimeScaleState).formatTooltipValue(value) ?? value;
			}
		}

		return value;
	}

	/** Format a value for tooltip display, using scale formatter when available. */
	#formatValue(value: unknown, axis?: 'x' | 'y'): string {
		if (typeof value === 'number' && axis) {
			const scaleState =
				axis === 'x' ? this.#scaleProvider.xScaleState : this.#scaleProvider.yScaleState;
			if (scaleState && scaleState.scaleType !== 'band' && 'formatValue' in scaleState) {
				return (scaleState as { formatValue: (v: number) => string }).formatValue(value);
			}
		}
		if (typeof value === 'number') {
			return Number.isInteger(value) ? value.toString() : value.toFixed(2);
		}
		return String(value ?? '');
	}

	#resolveLabels(row: DataRow, config: TooltipMarkRegistration): DataRow {
		const { scaleTypes, channelFields, bandDomains, colorDomain, columns } = config;
		const point: DataRow = {};

		// --- Detect range pairs from columns config ---
		// rangePairs: [{axis, lowKey, highKey}] for each detected pair
		type RangePair = { axis: 'x' | 'y'; lowKey: string; highKey: string };
		const rangePairs: RangePair[] = [];
		if (columns) {
			if (typeof columns.yLow === 'string' && typeof columns.yHigh === 'string')
				rangePairs.push({ axis: 'y', lowKey: columns.yLow, highKey: columns.yHigh });
			if (typeof columns.xLow === 'string' && typeof columns.xHigh === 'string')
				rangePairs.push({ axis: 'x', lowKey: columns.xLow, highKey: columns.xHigh });
		}

		// Classify each pair and build suppressed-keys set
		const suppressedKeys = new Set<string>();
		const mergedRanges: {
			axis: 'x' | 'y';
			lowKey: string;
			highKey: string;
			label: string;
		}[] = [];

		for (const pair of rangePairs) {
			const lowField = channelFields?.[pair.lowKey];
			const highField = channelFields?.[pair.highKey];
			const lowInMap = lowField != null;
			const highInMap = highField != null;

			if (lowInMap && highInMap && lowField === highField) {
				// Same field → merge as range
				suppressedKeys.add(pair.lowKey);
				suppressedKeys.add(pair.highKey);
				mergedRanges.push({ ...pair, label: lowField! });
			} else if (!lowInMap || !highInMap) {
				// An endpoint not in channelFields → transform-injected (e.g., stack)
				// Suppress the pair keys; also suppress any extra range columns on this axis
				// (e.g., y2 when stack produces y0/y1) so the value column shows alone
				suppressedKeys.add(pair.lowKey);
				suppressedKeys.add(pair.highKey);
				const axisPattern = pair.axis === 'y' ? /^y\d$/ : /^x\d$/;
				for (const k of Object.keys(row)) {
					if (axisPattern.test(k) && !suppressedKeys.has(k)) {
						// Don't suppress — this is the value column we want to keep
					}
				}
			}
			// Both in channelFields with different names → keep separate (do nothing)
		}

		// --- Main resolution loop ---
		const entries = Object.entries(row);
		let rangeInsertIndex = -1;

		for (let i = 0; i < entries.length; i++) {
			const [key, value] = entries[i];

			// Skip internal columns
			if (key.startsWith('_') || key.startsWith('__dplot_')) continue;

			// Skip suppressed range columns; track insertion position
			if (suppressedKeys.has(key)) {
				if (rangeInsertIndex === -1) rangeInsertIndex = Object.keys(point).length;
				continue;
			}

			// Skip transform-injected range columns (e.g., y0/y1 from stack) not in channelFields
			if (/^[xy]\d$/.test(key) && !channelFields?.[key]) continue;

			const fieldName = channelFields?.[key] || key;
			const axis: 'x' | 'y' = key.startsWith('x') ? 'x' : 'y';

			// Resolve band index to category label
			if ((key === 'x' || key === 'y') && scaleTypes[key] === 'band' && bandDomains?.[key]) {
				point[fieldName] = bandDomains[key]![value as number] ?? value;
				continue;
			}

			// Resolve time offset to formatted datetime string
			if (
				(key === 'x' || key === 'x1' || key === 'x2') &&
				isTemporalScale(scaleTypes.x) &&
				typeof value === 'number'
			) {
				const scaleState = this.#scaleProvider.xScaleState;
				point[fieldName] =
					scaleState && isTemporalScale(scaleState.scaleType)
						? ((scaleState as TimeScaleState).formatTooltipValue(value) ?? value)
						: value;
				continue;
			}
			if (
				(key === 'y' || key === 'y1' || key === 'y2') &&
				isTemporalScale(scaleTypes.y) &&
				typeof value === 'number'
			) {
				const scaleState = this.#scaleProvider.yScaleState;
				point[fieldName] =
					scaleState && isTemporalScale(scaleState.scaleType)
						? ((scaleState as TimeScaleState).formatTooltipValue(value) ?? value)
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

		// --- Insert merged range rows ---
		if (mergedRanges.length > 0) {
			// Rebuild point with ranges inserted at the right position
			const pointEntries = Object.entries(point);
			const insertAt = rangeInsertIndex >= 0 ? rangeInsertIndex : pointEntries.length;

			const rangeEntries: [string, unknown][] = mergedRanges.map((r) => {
				const lowVal = this.#resolveValue(r.axis, r.lowKey, row[r.lowKey], config);
				const highVal = this.#resolveValue(r.axis, r.highKey, row[r.highKey], config);
				return [r.label, `${this.#formatValue(lowVal, r.axis)}\u2013${this.#formatValue(highVal, r.axis)}`];
			});

			// Splice range entries into position
			const merged = [
				...pointEntries.slice(0, insertAt),
				...rangeEntries,
				...pointEntries.slice(insertAt)
			];

			const result: DataRow = {};
			for (const [k, v] of merged) result[k] = v;
			return result;
		}

		return point;
	}

	// =========================================================================
	// LIFECYCLE
	// =========================================================================

	destroy(): void {
		this.#marks.clear();
		this.visible = false;
		this.currentPoints = [];
		this.matchedPoints = [];
		this.focusedIndex = 0;
		this.#stickyCategory = null;
		this.currentMarkId = null;
		this.currentMarkType = null;
		this.currentColorField = null;
		this.currentChannelFields = null;
		this.currentDisplayFields = null;
		this.matchedRadius = null;
	}
}
