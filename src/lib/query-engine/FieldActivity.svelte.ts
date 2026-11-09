import type { ClockLoop } from '$lib/animation';
import {
	ActivityTable,
	DEFAULT_INACTIVE_OPACITY,
	selectionOpacity
} from '$lib/scales/ActivityTable';
import type { FieldIdentity } from './categorical-identity';

/** What a FieldActivity needs from the page around it. */
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

	/** How many ids the tables cover: the applied identity's, 0 without one. */
	get count(): number {
		return this.#identity ? this.#identity.values.length : 0;
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
			if (id != null && id < group.table.count) {
				return selectionOpacity(group.table.activityOf(id), inactiveOpacity);
			}
		}
		const values = group.values;
		return values == null || values.has(value) ? 1 : inactiveOpacity;
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
		const count = identity.values.length;
		const values = group.values;
		if (values == null) {
			group.table.resize(count, null);
			group.table.clear();
			return;
		}
		const ids = this.#ids;
		ids.length = 0;
		for (const value of values) {
			const id = identity.ids.get(value as never);
			if (id != null) ids.push(id);
		}
		group.table.resize(count, ids);
		group.table.setActive(ids);
	}
}
