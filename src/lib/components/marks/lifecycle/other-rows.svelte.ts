/**
 * What a mark's Other rows hold, and what is done with it: the one owner of
 * the three things that read an Other row's member lists.
 *
 * - `register`: hands the members to their field, so a click on the bucket
 *   selects them and the bucket is lit while the selection reaches into it.
 * - `split`: a bar's selected share, for the bar renderer to draw as two parts.
 * - `stats`: what that share is made of, for a tooltip.
 *
 * Takes getters, not values, so what it reads is tracked by whoever reads it.
 * MarkLifecycleV2 holds one and says only what it is told by the mark.
 */

import type { Table } from '@uwdata/flechette';
import type { FilterGroup } from '$lib/query-engine/FilterGroup.svelte';
import type { OtherEntry } from '$lib/query-engine/FieldActivity.svelte';
import type { QueryEngine } from '$lib/query-engine/QueryEngine';
import type { ChannelIdentity } from '$lib/types';
import { OTHER_IDS_COLUMN, OTHER_VALUES_COLUMN } from '$lib/transforms';
import { otherSplit, splittable, type OtherSplit } from './other-split';

/** What the mark is, for whether its Other bar can be split. */
export interface SplitPlan {
	markType: string;
	/** The bar's length channel: `y` for vertical bars, `x` for horizontal. */
	length: string | undefined;
	/** The measure topN ranks by, null for its default (the length). */
	by: string | null;
	/** The length channel's select expression. */
	expr: unknown;
	/** The mark's topN has an Other bucket. */
	hasOther: boolean;
	/** JS transforms follow the query, so its rows no longer line up. */
	hasJsTransforms: boolean;
}

/** What the bar renderer draws an Other split from. */
export interface SplitProp {
	/** 0 on rows that are not an Other row, `1 + share` on one. */
	data: Float32Array;
	/** Whether the split travels with the bar's morph or lands at once. */
	slides: boolean;
	/** The band axis the bars are grouped on; the split runs along the other. */
	axis: 'x' | 'y';
	/** Colour is the band's own field, so an Other row's colour term reads its id too. */
	colorOnBand: boolean;
}

/** One Other row's share, in numbers. */
export interface OtherRowStats {
	picked: number;
	total: number;
	pickedCount: number;
	memberCount: number;
	/** The field has a selection; without one picked is everything and says nothing. */
	active: boolean;
}

export interface OtherRowsDeps {
	queryEngine: QueryEngine;
	filterGroup: FilterGroup;
	markId: string;
	/** The mark's result, and the version it is at. */
	table: () => Table | null;
	dataVersion: () => number;
	identity: () => Record<string, ChannelIdentity> | null;
	/** The identity key of a band axis, or null when it has none. */
	identityKey: (axis: 'x' | 'y') => string | null;
	/** The mark is filtered by the selection rather than dimmed by it. */
	filtered: () => boolean;
	/** The mark's plan, or null before its setup completes. */
	plan: () => SplitPlan | null;
	/** The identity key of the mark's ordinal colour scale, or null. */
	colorKey: () => string | null;
	/** The identity key of the chart's band scale on an axis, or null. */
	bandScaleKey: (axis: 'x' | 'y') => string | null;
}

export class OtherRows {
	readonly #deps: OtherRowsDeps;

	/** The (field, Other id) pairs this mark has rows registered under. */
	#registered = new Map<string, number>();

	/** The split last computed, and for which result: what a selection change holds against. */
	#last: { dataVersion: number; split: OtherSplit } | null = null;

	constructor(deps: OtherRowsDeps) {
		this.#deps = deps;
	}

	/**
	 * Register this result's Other rows with their field: what each Other bucket
	 * holds, per facet cell, for a click on it to select (FieldActivity.setOther).
	 * Per result, so the members follow the filters the mark receives. A mark
	 * filtered by the selection (`'filter'`) registers with no group, which is
	 * how a click on its Other knows to drill down rather than toggle off.
	 */
	register(): void {
		const { table: getTable, identity: getIdentity, filterGroup, markId } = this.#deps;
		const table = getTable();
		const identity = getIdentity();
		const group = this.#deps.filtered() ? null : filterGroup.index;
		const now = new Map<string, number>();
		const ids = table?.getChild(OTHER_IDS_COLUMN) ?? null;
		if (table && identity && ids) {
			const facets = table.getChild('__facet');
			for (const axis of ['x', 'y'] as const) {
				const otherId = identity[axis]?.otherId;
				const key = this.#deps.identityKey(axis);
				const band = table.getChild(axis);
				if (otherId == null || !key || !band) continue;
				const rows: OtherEntry['rows'] = [];
				for (let i = 0; i < table.numRows; i++) {
					if (Number(band.at(i)) !== otherId) continue;
					const members = ids.at(i) as ArrayLike<number> | null;
					if (!members) continue;
					rows.push({ facetId: facets ? Number(facets.at(i)) : null, ids: members });
				}
				filterGroup.activity(key).setOther(otherId, markId, { group, rows });
				now.set(key, otherId);
			}
		}
		// A field or bucket this mark no longer draws an Other on gives its rows up.
		for (const [key, otherId] of this.#registered) {
			if (now.get(key) !== otherId) filterGroup.activity(key).setOther(otherId, markId, null);
		}
		this.#registered = now;
	}

	/** Give every registered row up: the mark is going away or starting over. */
	unregister(): void {
		for (const [key, otherId] of this.#registered) {
			this.#deps.filterGroup.activity(key).setOther(otherId, this.#deps.markId, null);
		}
		this.#registered = new Map();
	}

	/**
	 * The bar renderer's split, or null: no split, the bar is lit or dim as a
	 * whole (see #splitAxis for when a bar has one).
	 *
	 * Per row, share = Σ values[k] · selected(ids[k]) / Σ values[k] over the
	 * row's own member lists: the part of the bar the selection holds. A weighted
	 * sum over values the query already returned, in JS, per result and per
	 * selection change: the alternative is re-querying a mark that dims, which is
	 * what dimming exists to avoid.
	 */
	get split(): SplitProp | null {
		const axis = this.#splitAxis;
		const computed = this.#computed;
		if (!axis || !computed) return null;
		return {
			data: computed.split,
			slides: computed.slides,
			axis,
			colorOnBand: this.#colorOnBand(axis)
		};
	}

	/** What an Other row's share is made of, or null where it has no split. */
	stats(row: number): OtherRowStats | null {
		const computed = this.#computed;
		if (!computed || computed.memberCount[row] === 0) return null;
		return {
			picked: computed.picked[row],
			total: computed.total[row],
			pickedCount: computed.pickedCount[row],
			memberCount: computed.memberCount[row],
			active: computed.active
		};
	}

	/**
	 * `stats` of the Other row a tooltip point names: its band id and, with
	 * facets, its cell (null: any). A tooltip's rows are not the result's, so it
	 * finds its row by identity. A scan of the result's rows, per hover change
	 * and not per frame; null where the point is not an Other row of this mark's
	 * split.
	 */
	statsAt(bandId: number, facetId: number | null): OtherRowStats | null {
		const axis = this.#splitAxis;
		const table = this.#deps.table();
		const otherId = axis ? this.#deps.identity()?.[axis]?.otherId : null;
		if (!axis || !table || otherId == null || bandId !== otherId) return null;
		const band = table.getChild(axis);
		const facets = facetId == null ? null : table.getChild('__facet');
		if (!band) return null;
		for (let row = 0; row < table.numRows; row++) {
			if (Number(band.at(row)) !== bandId) continue;
			if (facets && Number(facets.at(row)) !== facetId) continue;
			return this.stats(row);
		}
		return null;
	}

	/**
	 * The band axis whose Other bar splits, or null. Only where a share is what
	 * it looks like:
	 * - a bar mark ('bary', 'barx') with a topN Other bucket, dimming (not
	 *   'filter', which never dims) and without JS transforms, whose rows would
	 *   no longer line up with the query's;
	 * - whose length is the measure topN ranks by, which is what Other sums;
	 * - and that measure a bare COUNT or SUM, or a raw column: a mean or a max
	 *   summed into Other is no total, and a share of it would mean nothing.
	 */
	get #splitAxis(): 'x' | 'y' | null {
		const plan = this.#deps.plan();
		if (!plan || this.#deps.filtered()) return null;
		if (!plan.hasOther || plan.hasJsTransforms) return null;
		if (plan.markType !== 'bary' && plan.markType !== 'barx') return null;
		return splittable(plan.length, plan.by, plan.expr)
			? plan.markType === 'barx'
				? 'y'
				: 'x'
			: null;
	}

	/** Whether colour is the band's own field, so an Other row's colour term reads its id too. */
	#colorOnBand(axis: 'x' | 'y'): boolean {
		const color = this.#deps.colorKey();
		return color != null && color === this.#deps.bandScaleKey(axis);
	}

	#computed: OtherSplit | null = $derived.by(() => {
		const axis = this.#splitAxis;
		if (!axis) return null;
		const dataVersion = this.#deps.dataVersion();
		const table = this.#deps.table();
		const otherId = this.#deps.identity()?.[axis]?.otherId;
		const key = this.#deps.identityKey(axis);
		const ids = table?.getChild(OTHER_IDS_COLUMN) ?? null;
		const values = table?.getChild(OTHER_VALUES_COLUMN) ?? null;
		const band = table?.getChild(axis) ?? null;
		if (!table || otherId == null || !key || !ids || !values || !band) return null;

		// The last split, for the same result only: a selection change holds a
		// flat row's position. A new result starts afresh and travels with the bar.
		const { filterGroup, queryEngine } = this.#deps;
		const last = this.#last;
		const next = otherSplit({
			rows: table.numRows,
			band,
			otherId,
			ids,
			values,
			selected: filterGroup.activity(key).selectedValues(filterGroup.index),
			decode: queryEngine.identityFor(key).values,
			previous: last && last.dataVersion === dataVersion ? last.split : null
		});
		this.#last = { dataVersion, split: next };
		return next;
	});
}
