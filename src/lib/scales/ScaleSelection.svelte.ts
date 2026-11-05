import type { ClockLoop } from '$lib/animation';
import { ActivityTable, selectionOpacity, DEFAULT_INACTIVE_OPACITY } from './ActivityTable';

/**
 * A categorical scale's selection: which values are selected, and how far each
 * category's fade has got.
 *
 * The scale decides WHAT is selected (FilterGroup projects values onto it) and
 * how a value becomes an identity id; this keeps the state. The same split as
 * SlotTransition, and for the same reason: band and ordinal colour scales need
 * exactly the same bookkeeping, and differ only in that lookup.
 *
 * Owns the ActivityTable the packer uploads as the activity half of the
 * scale's block, the values last selected (to re-apply when identity lands or
 * the dim grows), and the frame counter CPU consumers (band labels, legend
 * entries) read to follow the fade.
 */
export class ScaleSelection<V> {
	readonly table: ActivityTable;

	/** The values last selected, or null for none. $state for the no-identity fallback. */
	#values: Set<V> | null = $state(null);

	/** Bumped on every frame the fade is driven, and once at rest. */
	#frame = $state(0);

	/** Reused id list, since selections are applied on every filter update. */
	#ids: number[] = [];

	#idOf: (value: V) => number | null | undefined;
	#ready: () => boolean;
	#count: () => number;
	#identity: () => object | null;

	/**
	 * The identity the table's ids belong to. A different one is a rebuilt dim
	 * (a reload), where the same id can name another category.
	 */
	#tableIdentity: object | null = null;

	/**
	 * `idOf` turns a value into its identity id, `ready` says whether the scale
	 * has identity yet, `identity` is the FieldIdentity its ids come from, and
	 * `count` is how many ids its slots cover. `charts` is the redraw list for
	 * the fade's clock.
	 */
	constructor(
		loop: ClockLoop | null,
		options: {
			charts: () => string[];
			idOf: (value: V) => number | null | undefined;
			ready: () => boolean;
			identity: () => object | null;
			count: () => number;
		}
	) {
		this.#idOf = options.idOf;
		this.#ready = options.ready;
		this.#count = options.count;
		this.#identity = options.identity;
		this.table = new ActivityTable(loop, {
			charts: options.charts,
			onFrame: () => this.#frame++
		});
	}

	set(values: Iterable<V>): void {
		const set = values instanceof Set ? (values as Set<V>) : new Set(values);
		this.#values = set;
		this.#apply(set);
	}

	clear(): void {
		this.#values = null;
		this.table.clear();
	}

	/**
	 * After the scale's ids changed (identity landed or went, the dim grew, a
	 * reload rebuilt it): cover them, and apply a selection made before they
	 * existed.
	 *
	 * Without identity the table is emptied, so the GPU reads every position
	 * as active instead of the per-id state of a numbering that is gone.
	 */
	reapply(): void {
		if (!this.#ready()) {
			this.table.resize(0);
			this.#tableIdentity = null;
			return;
		}
		this.#apply(this.#values);
	}

	/**
	 * How visible one category id is now. Per frame while a fade runs, O(1).
	 * Fully visible for a scale without identity, whose keys are not ids.
	 */
	opacityOf(id: number, inactiveOpacity: number = DEFAULT_INACTIVE_OPACITY): number {
		// Read first, before any early return: whether the scale has identity is
		// not reactive, so a consumer that ran before identity landed must
		// already depend on the frame counter for the fade that follows to reach it.
		void this.#frame;
		if (!this.#ready()) return 1;
		return selectionOpacity(this.table.activityOf(id), inactiveOpacity);
	}

	/**
	 * How visible one category is now, by value: its fade when the value has an
	 * id, and otherwise simply selected or not, from the values alone (a scale
	 * without identity yet has no table to fade).
	 */
	opacityOfValue(value: V, inactiveOpacity: number = DEFAULT_INACTIVE_OPACITY): number {
		void this.#frame; // first, for the reason in opacityOf
		if (this.#ready()) {
			const id = this.#idOf(value);
			if (id != null) return this.opacityOf(id, inactiveOpacity);
		}
		const values = this.#values;
		return values == null || values.has(value) ? 1 : inactiveOpacity;
	}

	/** Leave the animation loop, for a scale being torn down. */
	destroy(): void {
		this.table.destroy();
	}

	/**
	 * Point the table at `values`, or at nothing selected for null.
	 *
	 * Ids are only comparable within one identity: across a reload the same id
	 * can name another category, so a fade from it would start from the wrong
	 * state. The table is dropped then and rebuilt at rest, the selection
	 * snapping into place as it does when identity first lands. A dim that only
	 * grew keeps its ids and their fades; the new ids start at their state.
	 */
	#apply(values: Set<V> | null): void {
		if (!this.#ready()) return;
		const identity = this.#identity();
		if (identity !== this.#tableIdentity) {
			this.table.resize(0);
			this.#tableIdentity = identity;
		}
		if (values == null) {
			this.table.resize(this.#count(), null);
			this.table.clear();
			return;
		}
		const ids = this.#ids;
		ids.length = 0;
		for (const value of values) {
			const id = this.#idOf(value);
			if (id != null) ids.push(id);
		}
		this.table.resize(this.#count(), ids);
		this.table.setActive(ids);
	}
}
