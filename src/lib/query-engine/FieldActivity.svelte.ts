import type { ClockLoop } from '$lib/animation';
import {
	ActivityTable,
	DEFAULT_INACTIVE_OPACITY,
	selectionOpacity
} from '$lib/scales/ActivityTable';
import type { FieldIdentity } from './categorical-identity';

/** What a FieldActivity needs from the page around it. */
/** One mark's Other rows for one bucket: what a click on it selects. */
export interface OtherEntry {
	/** The mark's filter group, or null when it is filtered by the selection (`'filter'`). */
	group: number | null;
	/** One per Other row: a facet cell (null without facets) and its folded ids. */
	rows: { facetId: number | null; ids: ArrayLike<number> }[];
}

/** What a click on Other does to a selection: values to set, add or remove. */
export interface OtherClick {
	action: 'replace' | 'add' | 'remove';
	values: unknown[];
}

export interface FieldActivityHost {
	/** Drives the fades; null in unit tests and before a coordinator exists, and fades land at once. */
	readonly loop: ClockLoop | null;
	/** Fill `out` with the charts drawing any scale on `key`, for the fade's redraws. */
	chartsFor(key: string, out: string[]): string[];
	/** The field's live identity, or null; must never create one. */
	identityOf(key: string): FieldIdentity | null;
}

/** A host with no page: no loop, no charts, no identity. */
export const DETACHED_HOST: FieldActivityHost = {
	loop: null,
	chartsFor: (_key, out) => out,
	identityOf: () => null
};

/** One filter group's selection on one field, and its fade. */
class GroupFade {
	readonly table: ActivityTable;
	/** The selected values, or null for none. State, for the by-value fallback. */
	values: ReadonlySet<unknown> | null = $state.raw(null);
	/** Bumped on every frame the fade is driven, and once at rest. */
	frame = $state(0);

	constructor(host: FieldActivityHost, key: string, charts: string[]) {
		this.table = new ActivityTable(host.loop, {
			charts: () => {
				charts.length = 0;
				return host.chartsFor(key, charts);
			},
			onFrame: () => this.frame++
		});
	}
}

/**
 * Which categories of one field are selected, per filter group, and how far
 * each one has faded.
 *
 * Activity is indexed by the field's identity id, and FieldIdentity is one per
 * field, so it belongs to the field, not to any scale on it: the carrier colour
 * scale and every carrier band scale read the same activity. One fade per
 * filter group, indexed by the group's page-wide index, because a selection
 * belongs to the group it was made in: a click in group A dims group A's marks
 * and leaves group B's alone.
 *
 * The packer writes these tables into the field's activity block, and legends
 * and band labels read them through `opacityOfValue`.
 *
 * IDS AND IDENTITY. Ids are only meaningful within one identity: across a
 * reload the same id can name another category. So the tables follow the
 * field's LIVE identity, which `reconcile` compares with the one last applied:
 * a different object is a reload, and every fade is dropped and snapped to its
 * selection; the same object at a higher version is a dim that grew, and the
 * existing ids keep their fades while new ones start in their state.
 * `reconcile` runs from the packer and from `set`, never from a reader, so
 * nothing is resized or retargeted while a template renders.
 */
/**
 * THE FREE SLOT. Each group's table holds one slot past the field's ids: 1 while
 * the group selects nothing on the field, 0 while it selects anything, faded on
 * the same clock as every id. The shader reads it as the last slot of the
 * group's run (identityFreeActivity): an Other bar's unselected part dims by it,
 * so clearing a selection fades it back in with the other bars, rather than its
 * split sliding.
 */
export class FieldActivity {
	readonly key: string;
	#host: FieldActivityHost;
	#groups: GroupFade[] = [];
	/**
	 * Bumped when a group's fade is created, so a reader that found none runs
	 * again once it exists. Fades are created by `set`, never while rendering.
	 */
	#groupsVersion = $state(0);

	/** The identity the tables' ids belong to, or null when they have none. */
	#identity: FieldIdentity | null = null;
	#version = -1;

	/** Reused id list: selections are applied on every categorical click. */
	#ids: number[] = [];

	constructor(key: string, host: FieldActivityHost = DETACHED_HOST) {
		this.key = key;
		this.#host = host;
	}

	/**
	 * How many slots the tables cover: one per id of the applied identity, and
	 * one past them (FREE_SLOT); 0 without an identity.
	 */
	get count(): number {
		return this.#identity ? this.#identity.values.length + 1 : 0;
	}

	/**
	 * Group `index`'s selected values, or null when it selects nothing on this
	 * field. Reactive: a reader re-runs when the selection changes.
	 */
	selectedValues(index: number): ReadonlySet<unknown> | null {
		void this.#groupsVersion;
		return this.#groups[index]?.values ?? null;
	}

	/** Group `index`'s fade, or null when that group never selected on this field. */
	fadeOf(index: number): ActivityTable | null {
		return this.#groups[index]?.table ?? null;
	}

	/**
	 * Select `values` in group `index`, or nothing for null.
	 *
	 * The table is first brought up to the live identity under the selection it
	 * had, so the change from that selection to this one fades. Sizing it with
	 * the new values instead would put every id straight into its new state: a
	 * group's first click, or the first one after the dim grew, would snap.
	 */
	set(index: number, values: ReadonlySet<unknown> | null): void {
		const group = this.#group(index);
		this.reconcile();
		if (group.table.count !== this.count) this.#apply(group);
		group.values = values;
		this.#apply(group);
	}

	/**
	 * Follow the field's live identity: snap every fade on a reload, extend them
	 * when the dim grew. Two comparisons when nothing moved, no allocation.
	 * Returns whether it re-applied the groups.
	 */
	reconcile(): boolean {
		const live = this.#host.identityOf(this.key);
		const usable = live && live.values.length > 0 ? live : null;
		if (usable === this.#identity) {
			if (!usable || usable.version === this.#version) return false;
			// The same identity, grown.
			this.#version = usable.version;
			for (const group of this.#groups) this.#apply(group);
			return true;
		}
		// Another identity, or none: the old ids mean nothing now.
		this.#identity = usable;
		this.#version = usable ? usable.version : -1;
		for (const group of this.#groups) {
			group.table.resize(0);
			this.#apply(group);
		}
		return true;
	}

	/**
	 * How visible a category is now in group `index`: its fade when the value
	 * has an id in the current identity, and otherwise simply selected or not.
	 * Pure, so it is safe in a template: it never reconciles, and a table that
	 * belongs to an identity no longer live is not trusted.
	 */
	opacityOfValue(
		index: number,
		value: unknown,
		inactiveOpacity: number = DEFAULT_INACTIVE_OPACITY
	): number {
		void this.#groupsVersion;
		const group = this.#groups[index];
		if (!group) return 1;
		// Read first, so a reader that ran before identity landed already depends
		// on the frame counter for the fade that follows.
		void group.frame;
		const identity = this.#identity;
		if (identity && identity === this.#host.identityOf(this.key)) {
			const id = identity.ids.get(value as never);
			if (id != null) return this.opacityOfId(index, id, inactiveOpacity);
		}
		const values = group.values;
		return values == null || values.has(value) ? 1 : inactiveOpacity;
	}

	/**
	 * How visible the category with dim id `id` is now in group `index`: its fade.
	 * The id form of `opacityOfValue`, and the only one that reaches a synthetic
	 * id (an Other bucket): a bucket has a label, not a value, and several may
	 * share one label. Pure, so it is safe in a template.
	 *
	 * Before the group's table covers the id, falls back to the selected values
	 * for a real id, and to fully visible for a bucket or an identity that is not
	 * live: a label is never dimmed on a guess.
	 */
	opacityOfId(
		index: number,
		id: number,
		inactiveOpacity: number = DEFAULT_INACTIVE_OPACITY
	): number {
		void this.#groupsVersion;
		const group = this.#groups[index];
		if (!group) return 1;
		void group.frame;
		const values = group.values;
		const identity = this.#identity;
		if (!identity || identity !== this.#host.identityOf(this.key)) return 1;
		if (id >= 0 && id < group.table.count) {
			return selectionOpacity(group.table.activityOf(id), inactiveOpacity);
		}
		if (values == null || identity.synthetic.has(id) || id < 0 || id >= identity.values.length) {
			return 1;
		}
		return values.has(identity.values[id]) ? 1 : inactiveOpacity;
	}

	// -----------------------------------------------------------------
	// Other buckets: what each one holds, for a click to select
	// -----------------------------------------------------------------

	/**
	 * Every Other bucket's members, by its id and the mark that drew it. Each
	 * mark registers its Other rows per result (`setOther`): the folded ids its
	 * query returned, per facet cell. A click on Other reads them, so what it
	 * selects is exactly what the bar summed.
	 */
	#others = new Map<number, Map<string, OtherEntry>>();
	/**
	 * What an Other click contributed to a group's selection, by `group:otherId`:
	 * how a second click on the same Other knows what to take back. Dropped with
	 * the id's last entry, so a reused id starts with no memory.
	 */
	#otherMemory = new Map<string, ReadonlySet<unknown>>();

	/** Register `markId`'s Other rows under `otherId`; null removes them. */
	setOther(otherId: number, markId: string, entry: OtherEntry | null): void {
		let byMark = this.#others.get(otherId);
		const before = byMark?.get(markId)?.group;
		if (entry) {
			if (!byMark) this.#others.set(otherId, (byMark = new Map()));
			byMark.set(markId, entry);
		} else {
			if (!byMark?.delete(markId)) return;
			if (byMark.size === 0) {
				this.#others.delete(otherId);
				for (const memKey of [...this.#otherMemory.keys()]) {
					if (memKey.endsWith(`:${otherId}`)) this.#otherMemory.delete(memKey);
				}
			}
		}
		// The bucket's members moved (a new result), or it came or went: whether it
		// is lit may have changed in the group its marks dim under. A fade it does
		// not change costs nothing (#retarget returns early).
		this.#reapply(before);
		if (entry && entry.group !== before) this.#reapply(entry.group);
	}

	#reapply(index: number | null | undefined): void {
		if (index == null) return;
		const group = this.#groups[index];
		if (group && group.values != null) this.#apply(group);
	}

	/**
	 * What a click on Other `otherId` does to group `group`'s selection, given
	 * the values it holds now (`current`), and records it. Null when nothing is
	 * registered under the id (no result yet) or it holds no members.
	 *
	 * - The members: every registered row under the id, or only facet cell
	 *   `facetId`'s when the click came from a cell.
	 * - Shift-click adds them, or takes back what this Other added before if it
	 *   is still selected.
	 * - A plain click on an Other whose marks all filter by the selection (no
	 *   group: `'filter'`) drills down, replacing the selection: such an Other is
	 *   computed inside the selection, so a second click means "the rest of it".
	 * - Otherwise a plain click toggles: it takes back what this Other added if
	 *   that is still selected, and replaces the selection with the members if not.
	 */
	otherClick(
		group: number,
		otherId: number,
		facetId: number | null,
		current: ReadonlySet<unknown>,
		multi: boolean
	): OtherClick | null {
		const entries = this.#others.get(otherId);
		const identity = this.#host.identityOf(this.key);
		if (!entries || entries.size === 0 || !identity) return null;

		const members = new Set<unknown>();
		let drill = true;
		for (const entry of entries.values()) {
			if (entry.group !== null) drill = false;
			for (const row of entry.rows) {
				if (facetId !== null && row.facetId !== facetId) continue;
				for (let i = 0; i < row.ids.length; i++) {
					const id = row.ids[i];
					if (identity.synthetic.has(id)) continue;
					const value = identity.values[id];
					if (value !== undefined) members.add(value);
				}
			}
		}
		if (members.size === 0) return null;

		const memKey = `${group}:${otherId}`;
		const before = this.#otherMemory.get(memKey);
		const stillSelected = !!before && before.size > 0 && [...before].every((v) => current.has(v));

		if (stillSelected && (multi || !drill)) {
			this.#otherMemory.delete(memKey);
			return { action: 'remove', values: [...before!] };
		}
		if (!multi) {
			// A replace: what any other Other added is gone from the selection.
			for (const key of [...this.#otherMemory.keys()]) {
				if (key.startsWith(`${group}:`)) this.#otherMemory.delete(key);
			}
		}
		this.#otherMemory.set(memKey, members);
		return { action: multi ? 'add' : 'replace', values: [...members] };
	}

	#group(index: number): GroupFade {
		let group = this.#groups[index];
		if (!group) {
			// Fill any gap below it too: the packer walks the groups by index.
			for (let i = this.#groups.length; i <= index; i++) {
				this.#groups[i] = new GroupFade(this.#host, this.key, []);
			}
			group = this.#groups[index];
			this.#groupsVersion++;
		}
		return group;
	}

	/**
	 * Point a group's table at its selection under the applied identity. A new
	 * id starts in its state rather than fading in, which is what keeps a
	 * selection made before its ids existed from fading on arrival.
	 */
	#apply(group: GroupFade): void {
		const identity = this.#identity;
		if (!identity) {
			group.table.resize(0);
			return;
		}
		// Every id, and the free slot past them: clear() sets it to 1 and
		// setActive() leaves it out, so it fades to 0 while anything is selected
		// and back to 1 once nothing is (see FieldActivity's FREE_SLOT note).
		const count = identity.values.length + 1;
		const values = group.values;
		if (values == null) {
			group.table.resize(count, null, true);
			group.table.clear();
			return;
		}
		const ids = this.#ids;
		ids.length = 0;
		for (const value of values) {
			const id = identity.ids.get(value as never);
			if (id != null) ids.push(id);
		}
		this.#lightOthers(this.#groups.indexOf(group), ids, count);
		group.table.resize(count, ids, true);
		group.table.setActive(ids);
	}

	/**
	 * Add to `ids` (the selected ids) every Other bucket that holds one of them,
	 * by the members its marks in group `index` registered: a bucket is lit while
	 * the selection reaches into it. In the same pass as the rest of the group's
	 * fade, so it is one retarget per update, never two. Marks filtered by the
	 * selection (no group) are skipped: they never dim.
	 */
	#lightOthers(index: number, ids: number[], count: number): void {
		if (this.#others.size === 0 || index < 0) return;
		let mask = this.#selectedMask;
		if (mask.length < count) mask = this.#selectedMask = new Uint8Array(count);
		const selected = ids.length;
		for (let i = 0; i < selected; i++) mask[ids[i]] = 1;

		for (const [otherId, entries] of this.#others) {
			if (otherId >= count) continue;
			let lit = false;
			for (const entry of entries.values()) {
				if (entry.group !== index) continue;
				for (const row of entry.rows) {
					for (let i = 0; i < row.ids.length && !lit; i++) lit = mask[row.ids[i]] === 1;
					if (lit) break;
				}
				if (lit) break;
			}
			if (lit) ids.push(otherId);
		}
		// Unmark only what was marked: the selected ids, not the Others pushed after.
		for (let i = 0; i < selected; i++) mask[ids[i]] = 0;
	}

	/** Reused by #lightOthers: 1 at each selected id, 0 elsewhere between calls. */
	#selectedMask = new Uint8Array(0);
}
