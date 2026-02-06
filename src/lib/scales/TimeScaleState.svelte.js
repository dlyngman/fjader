// =============================================================================
// TimeScaleState.svelte.js - Time scale with derived offset columns
// =============================================================================

import { scaleTime } from 'd3-scale';
import { LinearScaleState } from './LinearScaleState.svelte.js';
import { viewManager, ViewManagerService } from '$lib/data/ViewManager.svelte.js';

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
	#t0 = null; // Origin Date (raw global min datetime)
	#unit = 1; // Seconds per offset unit (1 = seconds)

	// --- Datetime Extent Tracking ---
	#datetimeExtents = new Map(); // Map<markId, [minDate, maxDate]>

	// --- ViewManager Integration ---
	#registeredTables = new Set();
	#viewsCreated = new Set();

	// --- Batching ---
	#suppressUpdate = false;

	constructor(name, extent, type, zoomLimits, options, gpuCoordinator) {
		super(name, extent, type ?? 'time', zoomLimits, options, gpuCoordinator);
	}

	// ===========================================================================
	// TIME ORIGIN
	// ===========================================================================

	/** The origin datetime. All offsets are relative to this. */
	get t0() {
		return this.#t0;
	}

	/** Seconds per offset unit. */
	get unit() {
		return this.#unit;
	}

	// ===========================================================================
	// DATETIME EXTENT MANAGEMENT
	// ===========================================================================

	/**
	 * Register a mark's datetime extent.
	 * Computes t0, converts all extents to offsets, updates parent.
	 *
	 * @param {[Date, Date]} datetimeRange - [minDate, maxDate]
	 * @param {string} markId - Mark identifier
	 */
	addDatetimeExtent(datetimeRange, markId) {
		const minDate = toDate(datetimeRange[0]);
		const maxDate = toDate(datetimeRange[1]);
		this.#datetimeExtents.set(markId, [minDate, maxDate]);

		// Recompute t0 (may trigger view recreation if t0 changes)
		this.#recomputeT0();

		// Recompute ALL parent offsets with current t0, suppress intermediate updates
		this.#suppressUpdate = true;
		for (const [id, [min, max]] of this.#datetimeExtents) {
			const offMin = (min.getTime() - this.#t0.getTime()) / (this.#unit * 1000);
			const offMax = (max.getTime() - this.#t0.getTime()) / (this.#unit * 1000);
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
	 *
	 * @param {[number, number]} offsetRange - [minOffset, maxOffset] in seconds from t0
	 * @param {string} markId - Mark identifier
	 */
	addOffsetExtent(offsetRange, markId) {
		if (!this.#t0) {
			console.warn(`[TimeScaleState] Cannot add offset extent: t0 not set yet`);
			return;
		}
		const minDate = this.offsetToDate(offsetRange[0]);
		const maxDate = this.offsetToDate(offsetRange[1]);
		this.addDatetimeExtent([minDate, maxDate], markId);
	}

	/**
	 * Remove a mark's datetime extent.
	 * @param {string} markId
	 */
	removeDatetimeExtent(markId) {
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
	updateExtentFromExtents(nice = true) {
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
			const niceScale = scaleTime()
				.domain([new Date(allMinMs), new Date(allMaxMs)])
				.nice();
			const [niceMin, niceMax] = niceScale.domain();
			const niceMinOffset = (niceMin.getTime() - this.#t0.getTime()) / (this.#unit * 1000);
			const niceMaxOffset = (niceMax.getTime() - this.#t0.getTime()) / (this.#unit * 1000);
			this._setExtent(niceMinOffset, niceMaxOffset);
		} else {
			const minOffset = (allMinMs - this.#t0.getTime()) / (this.#unit * 1000);
			const maxOffset = (allMaxMs - this.#t0.getTime()) / (this.#unit * 1000);
			this._setExtent(minOffset, maxOffset);
		}

		this.resetDomainLimits();
		this.resetZoom();
	}

	// ===========================================================================
	// VIEWMANAGER INTEGRATION
	// ===========================================================================

	/** The derived column name for this time scale's offsets. */
	get offsetColumnName() {
		return ViewManagerService.timeOffsetColumn(this.name);
	}

	/**
	 * Register a source table for derived view column creation.
	 * View is created once t0 is known.
	 *
	 * @param {string} sourceTable
	 */
	registerTable(sourceTable) {
		this.#registeredTables.add(sourceTable);
		if (this.#t0) {
			this.#maybeCreateView(sourceTable);
		}
	}

	/**
	 * Create derived offset column in DuckDB view if not already created.
	 */
	#maybeCreateView(sourceTable) {
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
	#unregisterFromViewManager() {
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
	 * @param {number} offset - Offset in seconds from t0
	 * @returns {Date|null} Date object or null if t0 not set
	 */
	offsetToDate(offset) {
		if (!this.#t0) return null;
		return new Date(this.#t0.getTime() + offset * this.#unit * 1000);
	}

	/**
	 * Convert a Date object to an offset (seconds from t0).
	 * @param {Date} date - Date object
	 * @returns {number|null} Offset in seconds or null if t0 not set
	 */
	dateToOffset(date) {
		if (!this.#t0) return null;
		const dateMs = toDate(date).getTime();
		return (dateMs - this.#t0.getTime()) / (this.#unit * 1000);
	}

	// ===========================================================================
	// D3 TIME SCALE INTERFACE
	// ===========================================================================

	/**
	 * Generate calendar-nice tick values in offset space.
	 *
	 * @param {number} count - Approximate number of ticks
	 * @returns {Array<number>} Tick offsets
	 */
	getTicks(count = 5) {
		this._version; // Svelte reactivity dependency
		if (!this.#t0) return [];

		const [renderMin, renderMax] = this.domainForReactivity;
		const minDate = new Date(this.#t0.getTime() + renderMin * this.#unit * 1000);
		const maxDate = new Date(this.#t0.getTime() + renderMax * this.#unit * 1000);

		const timeScale = scaleTime().domain([minDate, maxDate]);
		const dateTicks = timeScale.ticks(count);

		// Convert Date ticks back to offsets
		const t0Ms = this.#t0.getTime();
		const unitMs = this.#unit * 1000;
		return dateTicks.map((d) => (d.getTime() - t0Ms) / unitMs);
	}

	/**
	 * Returns a formatter function that converts offsets to datetime strings.
	 * Uses d3's multi-resolution time format (adapts to zoom level).
	 *
	 * @returns {(offset: number) => string}
	 */
	tickFormat() {
		if (!this.#t0) return (v) => String(v);

		const [renderMin, renderMax] = this.domainForReactivity;
		const minDate = new Date(this.#t0.getTime() + renderMin * this.#unit * 1000);
		const maxDate = new Date(this.#t0.getTime() + renderMax * this.#unit * 1000);

		const d3Formatter = scaleTime().domain([minDate, maxDate]).tickFormat();
		const t0Ms = this.#t0.getTime();
		const unitMs = this.#unit * 1000;

		return (offset) => {
			const date = new Date(t0Ms + offset * unitMs);
			return d3Formatter(date);
		};
	}

	/**
	 * Format a single offset value to a datetime string.
	 * Uses d3's multi-resolution tick format (adapts to zoom level).
	 *
	 * @param {number} offset - Time offset value
	 * @returns {string} Formatted datetime string
	 */
	formatValue(offset) {
		return this.tickFormat()(offset);
	}

	// Cached Intl formatters for tooltip (created once, reused)
	static #tooltipFmtDate = new Intl.DateTimeFormat(undefined, {
		year: 'numeric', month: 'short', day: 'numeric'
	});
	static #tooltipFmtDateTime = new Intl.DateTimeFormat(undefined, {
		year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
	});
	static #tooltipFmtDateTimeSec = new Intl.DateTimeFormat(undefined, {
		year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
	});

	/**
	 * Format an offset for tooltip display.
	 * Shows all precision present in the data — never drops detail.
	 *
	 * @param {number} offset - Time offset value
	 * @returns {string} Formatted datetime string
	 */
	formatTooltipValue(offset) {
		const date = this.offsetToDate(offset);
		if (!date) return String(offset);

		const s = date.getSeconds();
		const m = date.getMinutes();
		const h = date.getHours();

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
	#recomputeT0() {
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

	destroy() {
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
function toDate(value) {
	if (value instanceof Date) return value;
	if (typeof value === 'number') return new Date(value);
	if (typeof value === 'bigint') return new Date(Number(value / 1000n)); // microseconds → ms
	return new Date(value);
}
