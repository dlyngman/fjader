// =============================================================================
// TimeScaleState.svelte.ts - Time scale with derived offset columns
// =============================================================================

import { scaleUtc } from 'd3-scale';
import { LinearScaleState } from './LinearScaleState.svelte';
import { viewManager, ViewManagerService } from '$lib/data/ViewManager.svelte';

/**
 * TimeScaleState extends LinearScaleState with datetime awareness.
 *
 * Data flow:
 * 1. Receives raw datetime extents from sidecar queries
 * 2. Computes shared origin t0 = global min datetime
 * 3. Creates derived DuckDB view column: CAST((EPOCH(col) - EPOCH(t0)) AS REAL)
 * 4. All GPU/scale math operates on float offsets (identical to linear)
 * 5. Ticks and labels rehydrate offsets back to datetimes for display
 */
export class TimeScaleState extends LinearScaleState {
	// --- Time Metadata ---
	#t0: Date | null = null; // Origin Date (raw global min datetime)
	#unit: number = 1; // Seconds per offset unit (1 = seconds)

	// --- Datetime Extent Tracking ---
	#datetimeExtents: Map<string, [Date, Date]> = new Map(); // Map<markId, [minDate, maxDate]>

	// --- ViewManager Integration ---
	#registeredTables: Set<string> = new Set();
	#viewsCreated: Set<string> = new Set();

	// --- Batching ---
	#suppressUpdate: boolean = false;

	constructor(
		name: string,
		extent: [number, number],
		type: string,
		zoomLimits: [number, number],
		options: any,
		gpuCoordinator: any
	) {
		super(name, extent, type ?? 'time', zoomLimits, options, gpuCoordinator);
	}

	// ===========================================================================
	// TIME ORIGIN
	// ===========================================================================

	/** The origin datetime. All offsets are relative to this. */
	get t0(): Date | null {
		return this.#t0;
	}

	/** Seconds per offset unit. */
	get unit(): number {
		return this.#unit;
	}

	// ===========================================================================
	// DATETIME EXTENT MANAGEMENT
	// ===========================================================================

	/**
	 * Register a mark's datetime extent.
	 * Computes t0, converts all extents to offsets, updates parent.
	 */
	addDatetimeExtent(
		datetimeRange: [Date | number | bigint | string, Date | number | bigint | string],
		markId: string
	): void {
		const minDate = toDate(datetimeRange[0]);
		const maxDate = toDate(datetimeRange[1]);
		this.#datetimeExtents.set(markId, [minDate, maxDate]);

		// Recompute t0 (may trigger view recreation if t0 changes)
		this.#recomputeT0();

		// Recompute ALL parent offsets with current t0, suppress intermediate updates
		this.#suppressUpdate = true;
		for (const [id, [min, max]] of this.#datetimeExtents) {
			const offMin = (min.getTime() - this.#t0!.getTime()) / (this.#unit * 1000);
			const offMax = (max.getTime() - this.#t0!.getTime()) / (this.#unit * 1000);
			super.addMark([offMin, offMax], id);
		}
		this.#suppressUpdate = false;

		// Single update with time-aware nice
		this.updateExtentFromExtents();
	}

	/**
	 * Register a mark's extent using offset values (seconds from t0).
	 * Useful when data is already in offset form (e.g., from binned queries).
	 * Converts offsets back to datetimes and delegates to addDatetimeExtent.
	 */
	addOffsetExtent(offsetRange: [number, number], markId: string): void {
		if (!this.#t0) {
			console.warn(`[TimeScaleState] Cannot add offset extent: t0 not set yet`);
			return;
		}
		const minDate = this.offsetToDate(offsetRange[0])!;
		const maxDate = this.offsetToDate(offsetRange[1])!;
		this.addDatetimeExtent([minDate, maxDate], markId);
	}

	/**
	 * Remove a mark's datetime extent.
	 */
	removeDatetimeExtent(markId: string): void {
		this.#datetimeExtents.delete(markId);

		if (this.#datetimeExtents.size === 0) {
			this.#t0 = null;
		} else {
			this.#recomputeT0();
		}

		super.removeMark(markId);
	}

	/**
	 * Override: apply time-aware nice instead of linear nice.
	 * Called by super.addMark via polymorphism.
	 */
	updateExtentFromExtents(nice: boolean = true): void {
		if (this.#suppressUpdate) return;

		// If no datetime extents, fall through to linear behavior
		if (this.#datetimeExtents.size === 0) {
			super.updateExtentFromExtents(nice);
			return;
		}

		// Compute global datetime range
		let allMinMs = Infinity;
		let allMaxMs = -Infinity;
		for (const [minDate, maxDate] of this.#datetimeExtents.values()) {
			allMinMs = Math.min(allMinMs, minDate.getTime());
			allMaxMs = Math.max(allMaxMs, maxDate.getTime());
		}

		if (nice) {
			// Time-aware nice: round to calendar boundaries
			const niceScale = scaleUtc()
				.domain([new Date(allMinMs), new Date(allMaxMs)])
				.nice();
			const [niceMin, niceMax] = niceScale.domain();
			const niceMinOffset = (niceMin.getTime() - this.#t0!.getTime()) / (this.#unit * 1000);
			const niceMaxOffset = (niceMax.getTime() - this.#t0!.getTime()) / (this.#unit * 1000);
			this._setExtent(niceMinOffset, niceMaxOffset);
		} else {
			const minOffset = (allMinMs - this.#t0!.getTime()) / (this.#unit * 1000);
			const maxOffset = (allMaxMs - this.#t0!.getTime()) / (this.#unit * 1000);
			this._setExtent(minOffset, maxOffset);
		}

		this.resetDomainLimits();
		this.resetZoom();
	}

	// ===========================================================================
	// VIEWMANAGER INTEGRATION
	// ===========================================================================

	/** The derived column name for this time scale's offsets. */
	get offsetColumnName(): string {
		return ViewManagerService.timeOffsetColumn(this.name);
	}

	/**
	 * Register a source table for derived view column creation.
	 * View is created once t0 is known.
	 */
	registerTable(sourceTable: string): void {
		this.#registeredTables.add(sourceTable);
		if (this.#t0) {
			this.#maybeCreateView(sourceTable);
		}
	}

	/**
	 * Create derived offset column in DuckDB view if not already created.
	 */
	#maybeCreateView(sourceTable: string): void {
		if (this.#viewsCreated.has(sourceTable)) return;
		if (!this.#t0) return;

		this.#viewsCreated.add(sourceTable);

		const alias = this.offsetColumnName;
		const t0Epoch = Math.floor(this.#t0.getTime() / 1000);
		const sql = `CAST((EPOCH("${this.name}") - ${t0Epoch}) AS REAL)`;

		viewManager.registerColumn(sourceTable, alias, {
			sql,
			source: this.name,
			scaleId: this.id
		});

		console.log(
			`[TimeScaleState] Created offset column ${alias} for ${sourceTable} (t0=${this.#t0.toISOString()})`
		);
	}

	/**
	 * Unregister from ViewManager. Called during destroy.
	 */
	#unregisterFromViewManager(): void {
		const alias = this.offsetColumnName;
		for (const table of this.#registeredTables) {
			viewManager.unregisterColumn(table, alias, this.id);
		}
		this.#registeredTables.clear();
		this.#viewsCreated.clear();
	}

	// ===========================================================================
	// CONVERSION UTILITIES
	// ===========================================================================

	/**
	 * Convert an offset (seconds from t0) to a Date object.
	 */
	offsetToDate(offset: number): Date | null {
		if (!this.#t0) return null;
		return new Date(this.#t0.getTime() + offset * this.#unit * 1000);
	}

	/**
	 * Convert a Date object to an offset (seconds from t0).
	 */
	dateToOffset(date: Date | number | bigint | string): number | null {
		if (!this.#t0) return null;
		const dateMs = toDate(date).getTime();
		return (dateMs - this.#t0.getTime()) / (this.#unit * 1000);
	}

	// ===========================================================================
	// D3 TIME SCALE INTERFACE
	// ===========================================================================

	/**
	 * Generate calendar-nice tick values in offset space.
	 */
	getTicks(count: number = 5): number[] {
		this._version; // Svelte reactivity dependency
		if (!this.#t0) return [];

		const [renderMin, renderMax] = this.domainForReactivity;
		const minDate = new Date(this.#t0.getTime() + renderMin * this.#unit * 1000);
		const maxDate = new Date(this.#t0.getTime() + renderMax * this.#unit * 1000);

		const timeScale = scaleUtc().domain([minDate, maxDate]);
		const dateTicks = timeScale.ticks(count);

		// Convert Date ticks back to offsets
		const t0Ms = this.#t0.getTime();
		const unitMs = this.#unit * 1000;
		return dateTicks.map((d) => (d.getTime() - t0Ms) / unitMs);
	}

	/**
	 * Returns a formatter function that converts offsets to datetime strings.
	 * Uses d3's multi-resolution time format (adapts to zoom level).
	 */
	tickFormat(): (offset: number) => string {
		this._version; // Svelte reactivity dependency (must be before #t0 check)
		if (!this.#t0) return (v: number) => String(v);
		const [renderMin, renderMax] = this.domainForReactivity;
		const minDate = new Date(this.#t0.getTime() + renderMin * this.#unit * 1000);
		const maxDate = new Date(this.#t0.getTime() + renderMax * this.#unit * 1000);

		const d3Formatter = scaleUtc().domain([minDate, maxDate]).tickFormat();
		const t0Ms = this.#t0.getTime();
		const unitMs = this.#unit * 1000;

		return (offset: number) => {
			const date = new Date(t0Ms + offset * unitMs);
			return d3Formatter(date);
		};
	}

	/**
	 * Format a single offset value to a datetime string.
	 * Uses d3's multi-resolution tick format (adapts to zoom level).
	 */
	formatValue(offset: number): string {
		return this.formatTooltipValue(offset);
	}

	// Cached Intl formatters for tooltip (created once, reused)
	static #tooltipFmtDate = new Intl.DateTimeFormat(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC'
	});
	static #tooltipFmtDateTime = new Intl.DateTimeFormat(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		timeZone: 'UTC'
	});
	static #tooltipFmtDateTimeSec = new Intl.DateTimeFormat(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		timeZone: 'UTC'
	});

	/**
	 * Format an offset for tooltip display.
	 * Shows all precision present in the data — never drops detail.
	 */
	formatTooltipValue(offset: number): string {
		const date = this.offsetToDate(offset);
		if (!date) return String(offset);

		const s = date.getUTCSeconds();
		const m = date.getUTCMinutes();
		const h = date.getUTCHours();

		if (s !== 0) return TimeScaleState.#tooltipFmtDateTimeSec.format(date);
		if (h !== 0 || m !== 0) return TimeScaleState.#tooltipFmtDateTime.format(date);
		return TimeScaleState.#tooltipFmtDate.format(date);
	}

	// ===========================================================================
	// PRIVATE
	// ===========================================================================

	/**
	 * Recompute t0 from all datetime extents.
	 * If t0 changes, recreate all views with new offset expression.
	 */
	#recomputeT0(): void {
		let minMs = Infinity;
		for (const [minDate] of this.#datetimeExtents.values()) {
			minMs = Math.min(minMs, minDate.getTime());
		}

		const newT0 = new Date(minMs);

		if (this.#t0 && this.#t0.getTime() === newT0.getTime()) return;

		this.#t0 = newT0;

		// t0 changed: recreate all views with updated offset expression
		this.#viewsCreated.clear();
		for (const table of this.#registeredTables) {
			this.#maybeCreateView(table);
		}
	}

	// ===========================================================================
	// CLEANUP
	// ===========================================================================

	destroy(): void {
		this.#unregisterFromViewManager();
		super.destroy();
	}
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Convert various datetime representations to a Date object.
 * Handles: Date, number (ms), BigInt (microseconds from Arrow), string.
 */
function toDate(value: Date | number | bigint | string): Date {
	if (value instanceof Date) return value;
	if (typeof value === 'number') return new Date(value);
	if (typeof value === 'bigint') return new Date(Number(value / 1000n)); // microseconds → ms
	return new Date(value);
}
