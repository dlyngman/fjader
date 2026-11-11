import {
	Query,
	isNode,
	column as sqlColumn,
	isAggregateExpression,
	cast,
	min,
	max
} from '@uwdata/mosaic-sql';
import type { ExprValue } from '@uwdata/mosaic-sql';
import type { QueryEngine } from '$lib/query-engine/QueryEngine';
import type { DimValue } from '$lib/query-engine/categorical-identity';
import type { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import type { ColorScaleState } from '$lib/scales/ColorScaleState.svelte';
import type { SizeScaleState } from '$lib/scales/SizeScaleState.svelte';
import type { ContinuousScaleState } from '$lib/types';
import { isBinExpression } from '$lib/sql/bin';
import { identityKeyFor } from '$lib/query-engine/identity-key';

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
	bandDomainFromData: boolean,
	markId: string,
	explicitDomain?: { x?: DimValue[]; y?: DimValue[] } | null,
	/** nulls="drop": the band and facet domains leave out the NULL category. */
	dropNull = false
): Promise<number> {
	const categoriesOf = (key: string): DimValue[] => {
		const categories = coordinator.categoryValues(key, table);
		return dropNull ? categories.filter((c) => c !== null) : categories;
	};
	const fetches: Promise<void>[] = [];

	const setupFetch = (axis: string, field: unknown, scaleState: BandScaleState | null): void => {
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

		// The band domain comes from the field's dim, not a SELECT DISTINCT.
		// Two reasons beyond removing a query:
		//
		//  - Order. DISTINCT has no ORDER BY, so today's domain is whatever DuckDB
		//    returned, then "first-appearance order" in updateDomainFromExtents.
		//    Arbitrary. Dim values are listed in id order, so the domain is
		//    deterministic. It is the real categories only (`categoryValues`
		//    leaves out Other buckets), so position-in-domain equals the dim id
		//    only until a bucket's row: the scale encodes each value to its id
		//    rather than relying on position.
		//  - Multi-table. The dim spans every table registering the field, so two
		//    marks on one shared scale agree on the category set by construction.
		//
		// A sorted axis does not come here at all: its order is a ranking the
		// query publishes as a column (see `rank()`), and its domain is registered
		// from the data, the way a topN axis's membership is.
		//
		// Expression-backed axes take this path too, since `20c2370`'s successor
		// gave the key derivation a shared home. They used to fall through to the
		// DISTINCT below — correct but redundant, and deferred only because
		// routing them here would have meant a second copy of #identityKey.
		const identityField = identityKeyFor(field);
		if (!identityField) return;
		fetches.push(
			(async () => {
				// Idempotent and coalesced — the mark's own setup calls this too.
				await coordinator.ensureColumns(table, { categorical: [identityField] });
				// This table's categories: the dim spans every table on the field.
				const categories = categoriesOf(identityField.key);
				// A snapshot of the real categories. The scale adopts the live
				// identity itself in MarkLifecycleV2's #ensureIdentityColumns, which
				// also covers the explicit-domain axes that never reach this branch.
				if (categories.length > 0) scaleState.addMark(categories, markId);
			})()
		);
	};

	// A mark whose band axis is decided by its data — topN membership, a
	// ranking from `sort` — registers the axis from each result in
	// registerDataDerivedDomains, so it does not take the dim here: a dim
	// registration first and a ranked one on the first result would animate
	// every chart into its order on load.
	const skipBandFetch = bandDomainFromData;
	// Track explicit domains to apply after all async fetches complete —
	// other scales (color, series) register ViewManager columns in their
	// fetch callbacks, so the band view must be created after those finish.
	// DimValue, not string: a band axis over a numeric column takes a numeric
	// explicit domain, and it reaches the scale uncoerced — which is what makes
	// it work, since #toIds looks each entry up in a dim keyed by the same type.
	let deferredExplicitX: DimValue[] | null = null;
	let deferredExplicitY: DimValue[] | null = null;

	if (actualXScaleType === 'band' || actualXScaleType === 'point') {
		if (skipBandFetch) {
			// Registered from the data.
		} else if (explicitDomain?.x && xScaleState) {
			deferredExplicitX = explicitDomain.x;
		} else {
			setupFetch('x', select.x, xScaleState);
		}
	}
	if (actualYScaleType === 'band' || actualYScaleType === 'point') {
		if (skipBandFetch) {
			// Registered from the data.
		} else if (explicitDomain?.y && yScaleState) {
			// Y band scale maps index 0 → bottom, so reverse the user's
			// top-to-bottom array to match GPU rendering order.
			deferredExplicitY = [...explicitDomain.y].reverse();
		} else {
			setupFetch('y', select.y, yScaleState);
		}
	}

	// Facet: register categories with the facet BandScaleState.
	//
	// From the dim, like the positional axes (step 3c). The DISTINCT it replaces
	// had no ORDER BY, so cell order was whatever DuckDB happened to return and
	// then first-appearance order — arbitrary, and different between two marks on
	// the same facet scale. Dim values are ordered by id, so cell order is
	// deterministic and every mark agrees on it by construction.
	const facetKey = fx ? identityKeyFor(fx) : null;
	if (facetBandScale && facetKey) {
		fetches.push(
			(async () => {
				// Idempotent and coalesced — the mark's own setup calls this too.
				await coordinator.ensureColumns(table, { categorical: [facetKey] });
				const categories = categoriesOf(facetKey.key);
				if (categories.length > 0) facetBandScale.addMark(categories, markId);
			})()
		);
	}
	// No fallback when the fx expression cannot be dimmed. #ensureIdentityColumns
	// reports that case and the mark renders nothing, so populating a domain here
	// would draw empty cells for categories no mark can put a row in.

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

	// The colour domain, if a colour scale is set and there is a colour field.
	const colorKey = colorChannel || 'fill';
	if (colorScaleState && select[colorKey]) {
		const colorValue = select[colorKey];
		const colorField =
			typeof colorValue === 'object' && 'field' in colorValue && !isNode(colorValue)
				? (colorValue as { field: string }).field
				: colorValue;

		const isAggregate = isNode(colorField) && isAggregateExpression(colorField);

		if (!isAggregate) {
			if (colorScaleState.isOrdinal) {
				// From the field's dim, like a band axis: the same values in the
				// same order a SELECT DISTINCT ... ORDER BY returned, without the
				// query, and spanning every table that registers the field, so a
				// colour scale shared by two tables agrees on its categories by
				// construction. The dim is what the colour channel selects its ids
				// from, so the domain and the ids cannot disagree either.
				//
				// A field this cannot dim (an aggregate, a bin) gets no domain, as
				// it got none from the DISTINCT, which failed at the binder for a
				// bin; the lifecycle reports it.
				const colorIdentity = identityKeyFor(colorField);
				if (colorIdentity) {
					fetches.push(
						(async () => {
							// Idempotent and coalesced — the mark's own setup calls this too.
							await coordinator.ensureColumns(table, { categorical: [colorIdentity] });
							const categories = coordinator.categoryValues(colorIdentity.key);
							if (categories.length > 0) {
								colorScaleState.setDomain(categories as (string | number)[]);
							}
						})()
					);
				}
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

	// The series domain, from the dim, the same way. When the series channel is
	// the colour channel the registry hands both the same scale, and the colour
	// branch above has already set it.
	if (seriesScaleState && seriesChannel && seriesChannel !== colorKey && select[seriesChannel]) {
		const seriesIdentity = identityKeyFor(select[seriesChannel]);
		if (seriesIdentity) {
			fetches.push(
				(async () => {
					await coordinator.ensureColumns(table, { categorical: [seriesIdentity] });
					const categories = coordinator.categoryValues(seriesIdentity.key);
					if (categories.length > 0) {
						seriesScaleState.setDomain(categories as (string | number)[]);
					}
				})()
			);
		}
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
	buildQueryFn: (table: string, config: unknown, filter: unknown[], forMosaic: boolean) => Query,
	config: unknown,
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
