import {
	Query,
	isNode,
	sql,
	column as sqlColumn,
	isAggregateExpression,
	cast,
	min,
	max
} from '@uwdata/mosaic-sql';
import type { ExprNode, ExprValue, GroupByExpr } from '@uwdata/mosaic-sql';
import type { QueryEngine } from '$lib/query-engine/QueryEngine';
import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
import type { SizeScaleState } from '$lib/scales/SizeScaleState.svelte';
import type { ContinuousScaleState, NormalizedSortConfig } from '$lib/types';
import { isBinExpression } from '$lib/sql/bin';
interface DataClientConfig {
	_filterNulls: unknown[] | null;
	select?: Record<string, unknown>;
	sort?: { channel: string; direction: 'asc' | 'desc' } | null;
	domain?: { x?: string[]; y?: string[] } | null;
	limit?: number;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// fetchCategoricalDomains
// ---------------------------------------------------------------------------

/**
 * Fetch categorical (band/point), time, color, size, and series domains
 * via sidecar queries against the coordinator.
 *
 * Returns the number of fetches executed (for logging).
 */
export async function fetchCategoricalDomains(
	coordinator: QueryEngine,
	table: string,
	select: Record<string, unknown>,
	sort: NormalizedSortConfig,
	actualXScaleType: string,
	actualYScaleType: string,
	xScaleState: BandScaleState | null,
	yScaleState: BandScaleState | null,
	facetBandScale: BandScaleState | null | undefined,
	fx: unknown,
	colorChannel: string,
	colorScaleState: ColorScaleState | null,
	sizeChannel: string,
	sizeScaleState: SizeScaleState | null,
	seriesScaleState: ColorScaleState | null,
	seriesChannel: string | null,
	hasCategoryReducingTransforms: boolean,
	markId: string,
	explicitDomain?: { x?: string[]; y?: string[] } | null
): Promise<number> {
	const fetches: Promise<void>[] = [];

	const setupFetch = (
		axis: string,
		field: unknown,
		scaleState: BandScaleState | null,
		{ sortOnly = false } = {}
	): void => {
		if (!field || !scaleState) return;

		// Binned band axes are not supported. bin() produces continuous values, but
		// marks like BarMarkX/BarMarkY declare their categorical axis as
		// SCALE_PRIORITIES.MANDATE band — so the mismatch is never negotiated and
		// used to surface here as `SELECT DISTINCT "[object Object]"`, failing setup
		// for the whole mark with no hint at the cause.
		//
		// It cannot be made to work at this point even in principle: resolving an
		// AutoBinNode to SQL needs min/max field stats, and this function runs in the
		// SAME Promise.all as the fetch that produces them (MarkLifecycleV2
		// #runSetup). Nor does the domain arrive later — registerDataDerivedDomains
		// only populates band domains for category-reducing transforms (topN).
		//
		// Say so plainly instead. A binned continuous axis is a rect mark's job.
		// The general fix — validating channel expressions against mandated scale
		// types at requirement-resolution time — is issue #197.
		if (isBinExpression(field)) {
			console.error(
				`[${markId}] Unsupported: bin() on the "${axis}" axis, which this mark ` +
					`mandates as a band scale. bin() produces continuous values — use a ` +
					`rect mark (RectXMark / RectYMark) for binned axes. This mark will ` +
					`render without a "${axis}" domain.`
			);
			return;
		}

		// Resolve the sort channel to a select key. Point-based marks (Dots, Lines)
		// have direct 'x'/'y' keys, but extent-based marks (Bars, Rects, Areas) use
		// 'x1'/'x2'/'y1'/'y2'. Fall back to channel+'2' then channel+'1' for those.
		const sortField = sort
			? select[sort.channel] || select[sort.channel + '2'] || select[sort.channel + '1']
			: null;

		// sortOnly mode: only fetch sort order, skip if no sort config
		if (sortOnly && !sortField) return;

		// Only strings become column refs; expression nodes pass through as-is.
		const axisExpr: ExprValue = isNode(field) ? (field as ExprNode) : sqlColumn(String(field));

		let q = Query.from(table).select({ [axis]: axisExpr });
		if (sortField) {
			if (isAggregateExpression(sortField as ExprNode)) {
				// Aggregate: GROUP BY band field, SELECT aggregate, ORDER BY it
				q = q.groupby(axisExpr as GroupByExpr).select({ _sort: sortField as ExprValue });
				if (sort!.direction === 'desc') {
					q.orderby(sql`${sqlColumn('_sort')} DESC`);
				} else {
					q.orderby(sqlColumn('_sort'));
				}
			} else {
				// Raw field or expression: ORDER BY directly
				const sortExpr = isNode(sortField) ? sortField : sqlColumn(String(sortField));
				if (sort!.direction === 'desc') {
					q.orderby(sql`${sortExpr} DESC`);
				} else {
					q.orderby(sortExpr);
				}
			}
		} else {
			q.distinct();
		}

		fetches.push(
			coordinator.query(q).then((result) => {
				const categories = Array.from(result).map((row) => row[axis]);
				// Y band scale maps index 0 → bottom, index N → top (bottom-to-top),
				// but users read top-to-bottom. Reverse so SQL sort order matches
				// the visual reading direction (e.g. 'desc' → largest at top).
				if (axis === 'y' && sortField) {
					categories.reverse();
				}
				if (categories.length > 0) {
					if (sortOnly) {
						scaleState.setSortOrder(categories);
					} else {
						scaleState.addMark(categories, markId, { sorted: !!sortField });
					}
				}
			})
		);
	};

	// Skip band fetch for marks with category-reducing transforms (topN):
	// domain will be populated post-transform in registerDataDerivedDomains.
	// BUT still run the sort sidecar so #sortOrder is set on the shared scale.
	const skipBandFetch = hasCategoryReducingTransforms;
	// Track explicit domains to apply after all async fetches complete —
	// other scales (color, series) register ViewManager columns in their
	// fetch callbacks, so the band view must be created after those finish.
	let deferredExplicitX: string[] | null = null;
	let deferredExplicitY: string[] | null = null;

	if (actualXScaleType === 'band' || actualXScaleType === 'point') {
		if (skipBandFetch) {
			setupFetch('x', select.x, xScaleState, { sortOnly: true });
		} else if (explicitDomain?.x && xScaleState) {
			deferredExplicitX = explicitDomain.x;
		} else {
			setupFetch('x', select.x, xScaleState);
		}
	}
	if (actualYScaleType === 'band' || actualYScaleType === 'point') {
		if (skipBandFetch) {
			setupFetch('y', select.y, yScaleState, { sortOnly: true });
		} else if (explicitDomain?.y && yScaleState) {
			// Y band scale maps index 0 → bottom, so reverse the user's
			// top-to-bottom array to match GPU rendering order.
			deferredExplicitY = [...explicitDomain.y].reverse();
		} else {
			setupFetch('y', select.y, yScaleState);
		}
	}

	// Facet: register categories with the facet BandScaleState
	if (facetBandScale && fx) {
		const fxExpr = isNode(fx) ? fx : sqlColumn(String(fx));
		const q = Query.from(table).select({ fx: fxExpr }).distinct();
		fetches.push(
			coordinator.query(q).then((result) => {
				const categories = Array.from(result).map((row) => row.fx);
				if (categories.length > 0) {
					facetBandScale.addMark(categories, markId);
				}
			})
		);
	}

	// Time scale sidecar queries: fetch MIN/MAX datetime for t0 computation
	const setupTimeFetch = (axis: string, field: unknown): void => {
		if (!field) return;
		const timeScaleState = axis === 'x' ? xScaleState : yScaleState;
		if (!(timeScaleState as unknown as { addDatetimeExtent?: unknown })?.addDatetimeExtent) return;

		// Unwrap AutoBinNode to get the underlying column name
		const rawField = isBinExpression(field) ? field.field : field;
		const colExpr = isNode(rawField) ? rawField : sqlColumn(String(rawField));

		const q = Query.from(table).select({
			min_time: min(colExpr),
			max_time: max(colExpr)
		});

		fetches.push(
			coordinator.query(q).then((result) => {
				const row = Array.from(result)[0];
				if (row && row.min_time != null && row.max_time != null) {
					console.log(`[fetchCategoricalDomains] Time extent for ${axis}:`, [
						row.min_time,
						row.max_time
					]);
					(
						timeScaleState as unknown as { addDatetimeExtent: (e: unknown[], id: string) => void }
					).addDatetimeExtent([row.min_time, row.max_time], markId);
				}
			})
		);
	};

	if (actualXScaleType === 'time') {
		setupTimeFetch('x', select.x || select.x1);
	}
	if (actualYScaleType === 'time') {
		setupTimeFetch('y', select.y || select.y1);
	}

	// Fetch color domain if color scale is set and there's a color field.
	// Eagerly register the table so setDomain → #maybeCreateView can create
	// the index column even if MarkColor's $effect hasn't fired yet.
	const colorKey = colorChannel || 'fill';
	if (colorScaleState && select[colorKey]) {
		colorScaleState.registerTable(table);
		const colorValue = select[colorKey];
		const colorField =
			typeof colorValue === 'object' && 'field' in colorValue && !isNode(colorValue)
				? (colorValue as { field: string }).field
				: colorValue;

		const isAggregate = isNode(colorField) && isAggregateExpression(colorField);

		if (!isAggregate) {
			if (colorScaleState.isOrdinal) {
				const colExpr = isNode(colorField) ? colorField : sqlColumn(String(colorField));
				const q = Query.from(table).select({ color: colExpr }).distinct().orderby('color');

				fetches.push(
					coordinator.query(q).then((result) => {
						const categories = Array.from(result).map((row) => row.color);
						if (categories.length > 0) {
							console.log(`[fetchCategoricalDomains] Color domain (ordinal):`, categories);
							colorScaleState.setDomain(categories as (string | number)[]);
						}
					})
				);
			} else {
				const colExpr = isNode(colorField) ? colorField : sqlColumn(String(colorField));
				const q = Query.from(table).select({
					min_color: cast(min(colExpr), 'REAL'),
					max_color: cast(max(colExpr), 'REAL')
				});

				fetches.push(
					coordinator.query(q).then((result) => {
						const row = Array.from(result)[0];
						if (row && row.min_color != null && row.max_color != null) {
							console.log(`[fetchCategoricalDomains] Color domain (sequential):`, [
								row.min_color,
								row.max_color
							]);
							colorScaleState.setDomain([row.min_color, row.max_color] as (string | number)[]);
						}
					})
				);
			}
		}
	}

	// Fetch size domain if size scale is set and there's a size field
	const sizeKey = sizeChannel || 'r';
	if (sizeScaleState && select[sizeKey]) {
		const sizeField = select[sizeKey];
		const q = Query.from(table).select({
			min_radius: cast(min(sqlColumn(String(sizeField))), 'REAL'),
			max_radius: cast(max(sqlColumn(String(sizeField))), 'REAL')
		});

		fetches.push(
			coordinator.query(q).then((result) => {
				const row = Array.from(result)[0];
				if (row && row.min_radius != null && row.max_radius != null) {
					sizeScaleState.setDomain([row.min_radius as number, row.max_radius as number]);
				}
			})
		);
	}

	// Fetch series domain if series scale is set and there's a series field
	if (seriesScaleState && seriesChannel && select[seriesChannel]) {
		const seriesField = select[seriesChannel];
		const q = Query.from(table)
			.select({ series: sqlColumn(String(seriesField)) })
			.distinct()
			.orderby('series');

		fetches.push(
			coordinator.query(q).then((result) => {
				const categories = Array.from(result).map((row) => row.series);
				if (categories.length > 0) {
					seriesScaleState.setDomain(categories as (string | number)[]);
				}
			})
		);
	}

	if (fetches.length > 0) await Promise.all(fetches);

	// Apply explicit domains after all async fetches — ViewManager columns
	// from color/series scales are now registered, so the band view will
	// include all necessary index columns.
	if (deferredExplicitX && xScaleState) {
		xScaleState.addMark(deferredExplicitX, markId, { explicit: true });
	}
	if (deferredExplicitY && yScaleState) {
		yScaleState.addMark(deferredExplicitY, markId, { explicit: true });
	}

	return fetches.length;
}

// ---------------------------------------------------------------------------
// fetchGlobalAggregates
// ---------------------------------------------------------------------------

/**
 * Fetch global min/max extents for aggregated fields using a "sidecar" query.
 * Runs the same aggregation as the main query but without filters, wrapped
 * in an outer MIN/MAX to get the full domain.
 *
 * Returns `{ globalAggregatesSet: true }` on success so the caller can
 * update its reactive state.
 */
export async function fetchGlobalAggregates(
	coordinator: QueryEngine,
	table: string,
	select: Record<string, unknown>,
	channelsNeedingDataDomain: Set<string>,
	autoBinNodeCount: number,
	buildQueryFn: (
		table: string,
		config: DataClientConfig,
		filter: unknown[],
		forMosaic: boolean
	) => Query,
	config: DataClientConfig,
	xScaleState: ContinuousScaleState | null,
	yScaleState: ContinuousScaleState | null,
	colorScaleState: ColorScaleState | null,
	markId: string
): Promise<{ globalAggregatesSet: boolean }> {
	// Only proceed if we have channels needing data-derived domains
	if (channelsNeedingDataDomain.size === 0) {
		console.log(`[${markId}] No aggregated channels, skipping sidecar query`);
		return { globalAggregatesSet: false };
	}

	// Skip sidecar when AutoBinNodes exist — they can't be resolved to SQL
	// until fieldInfo is available (which requires the DataClient created later).
	// Domains will be set from query results via registerDataDerivedDomains.
	if (autoBinNodeCount > 0) {
		console.log(`[${markId}] Skipping sidecar: bin domains derived from query results`);
		return { globalAggregatesSet: false };
	}

	console.log(
		`🔍 [${markId}] Building sidecar query for channels:`,
		Array.from(channelsNeedingDataDomain)
	);

	try {
		// Step 1: Build the inner query with channel-named aliases (forMosaic=false)
		const innerQuery = buildQueryFn(table, config, [], false);

		console.log(`📊 [${markId}] Inner query SQL:`, innerQuery.toString());

		// Step 2: Build outer aggregation to get min/max of each channel
		const outerSelect: Record<string, ExprValue> = {};

		if (channelsNeedingDataDomain.has('x')) {
			if ('x' in select) {
				outerSelect.min_x = cast(min('x'), 'REAL');
				outerSelect.max_x = cast(max('x'), 'REAL');
			} else {
				if ('x1' in select) outerSelect.min_x = cast(min('x1'), 'REAL');
				if ('x2' in select) outerSelect.max_x = cast(max('x2'), 'REAL');
			}
		}

		if (channelsNeedingDataDomain.has('y')) {
			if ('y' in select) {
				outerSelect.min_y = cast(min('y'), 'REAL');
				outerSelect.max_y = cast(max('y'), 'REAL');
			} else {
				if ('y1' in select) outerSelect.min_y = cast(min('y1'), 'REAL');
				if ('y2' in select) outerSelect.max_y = cast(max('y2'), 'REAL');
			}
		}

		// Color channel domain discovery (fill or stroke key)
		const colorChannel = channelsNeedingDataDomain.has('fill')
			? 'fill'
			: channelsNeedingDataDomain.has('stroke')
				? 'stroke'
				: null;
		if (colorChannel) {
			outerSelect.min_color = cast(min(colorChannel), 'REAL');
			outerSelect.max_color = cast(max(colorChannel), 'REAL');
		}

		// Skip if no aggregation expressions were generated
		if (Object.keys(outerSelect).length === 0) {
			console.log(`📊 [${markId}] Skipping sidecar: no SQL channels to aggregate`);
			return { globalAggregatesSet: false };
		}

		const sidecarQuery = Query.from(innerQuery).select(outerSelect);

		console.log(`📊 [${markId}] Sidecar query SQL:`, sidecarQuery.toString());

		// Step 3: Execute the query
		const result = await coordinator.query(sidecarQuery);
		const extents: Record<string, unknown> = Array.from(result)[0];

		console.log(`✅ [${markId}] Sidecar results:`, extents);

		// Step 4: Apply extents to scales
		if (channelsNeedingDataDomain.has('x') && extents.min_x != null && extents.max_x != null) {
			const xExtent = [extents.min_x as number, extents.max_x as number];
			console.log(`📊 [${markId}] Applying X extent from sidecar:`, xExtent);
			xScaleState?.addMark(xExtent, markId);
		}

		if (channelsNeedingDataDomain.has('y') && extents.min_y != null && extents.max_y != null) {
			const yExtent = [extents.min_y as number, extents.max_y as number];
			console.log(`📊 [${markId}] Applying Y extent from sidecar:`, yExtent);
			yScaleState?.addMark(yExtent, markId);
		}

		if (
			(channelsNeedingDataDomain.has('fill') || channelsNeedingDataDomain.has('stroke')) &&
			extents.min_color != null &&
			extents.max_color != null
		) {
			const colorExtent = [extents.min_color, extents.max_color];
			console.log(`📊 [${markId}] Applying color extent from sidecar:`, colorExtent);
			colorScaleState?.setDomain(colorExtent as (string | number)[]);
		}

		return { globalAggregatesSet: true };
	} catch (error) {
		console.error(`❌ [${markId}] Sidecar query failed:`, error);
		return { globalAggregatesSet: false };
	}
}
