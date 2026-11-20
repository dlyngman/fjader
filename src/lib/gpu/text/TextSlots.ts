/**
 * A text layer's atlas slots, switched to new strings only once those are
 * painted.
 *
 * A new string's atlas entry is empty until the canvas's next paint uploads
 * it, a frame or two later. A layer that pointed its rows at the new slots at
 * once showed nothing in between: on a filter every count changes, so every
 * label blinked out and back, on every update of a brush. So new slots are
 * STAGED: acquired, but not handed out until every one is rasterized; the
 * rows keep the old strings until then, and the old ones are released only
 * when the new ones take over.
 *
 * Rows are matched by KEY (a bar's category id), not only by index: a row
 * whose key changed (a topN membership change, a reorder of rows) would show
 * another bar's string meanwhile, so `stage` returns interim slots with such
 * rows hidden, to write at once; only rows that are the same bar keep their
 * old string until the new one is painted.
 *
 * Plain class: its owner's effects decide when to call it (on new strings,
 * and on the atlas's `paintVersion`).
 */

import type { TextAtlas, TextStyle } from './TextAtlas.svelte';

export class TextSlots {
	readonly #atlas: TextAtlas;
	#held: number[] = [];
	#pending: { slots: Float32Array; acquired: number[]; keys: ArrayLike<number> | null } | null =
		null;
	/** The slots last committed: what the rows draw. */
	current: Float32Array | null = null;
	#currentKeys: ArrayLike<number> | null = null;

	constructor(atlas: TextAtlas) {
		this.#atlas = atlas;
	}

	/**
	 * New strings, one per row (null: no label), with each row's key (or null:
	 * rows matched by index). Acquires them; a stage not yet committed is
	 * dropped in favour of this one. Returns the slots to draw until the
	 * commit: the current ones, with every row whose key changed hidden (−1).
	 * Null when nothing is committed yet, or no row changed.
	 */
	stage(
		labels: readonly (string | null)[] | null,
		style: TextStyle,
		keys: ArrayLike<number> | null = null
	): Float32Array | null {
		this.#dropPending();
		const n = labels?.length ?? 0;
		const slots = new Float32Array(Math.max(1, n)).fill(-1);
		const acquired: number[] = [];
		for (let i = 0; i < n; i++) {
			const label = labels![i];
			if (label == null) continue;
			const slot = this.#atlas.acquire(label, style);
			slots[i] = slot;
			if (slot >= 0) acquired.push(slot);
		}
		this.#pending = { slots, acquired, keys };
		return this.#interim(n, keys);
	}

	/** The current slots for `n` rows, a row whose key changed hidden; null if none did. */
	#interim(n: number, keys: ArrayLike<number> | null): Float32Array | null {
		const current = this.current;
		const before = this.#currentKeys;
		if (!current) return null;
		let changed = n !== current.length;
		const out = new Float32Array(Math.max(1, n)).fill(-1);
		for (let i = 0; i < n; i++) {
			const same = i < current.length && (!keys || !before || keys[i] === before[i]);
			if (same) out[i] = current[i];
			else changed = true;
		}
		return changed ? out : null;
	}

	/**
	 * The staged slots once every new string is painted: commits them,
	 * releases the strings they replace and returns them, to be written. Null
	 * while nothing is staged or a string is still unpainted.
	 */
	commit(): Float32Array | null {
		const pending = this.#pending;
		if (!pending) return null;
		for (const slot of pending.acquired) if (!this.#atlas.isRasterized(slot)) return null;
		for (const slot of this.#held) this.#atlas.release(slot);
		this.#held = pending.acquired;
		this.current = pending.slots;
		this.#currentKeys = pending.keys;
		this.#pending = null;
		return this.current;
	}

	#dropPending(): void {
		if (!this.#pending) return;
		for (const slot of this.#pending.acquired) this.#atlas.release(slot);
		this.#pending = null;
	}

	destroy(): void {
		this.#dropPending();
		for (const slot of this.#held) this.#atlas.release(slot);
		this.#held = [];
		this.current = null;
		this.#currentKeys = null;
	}
}

/**
 * Row keys for a facet grid: a row's category id is the same in every cell, so
 * a key that is only the category would match a row that moved to another
 * cell, and show that cell the old cell's string until the new one is
 * painted. Facet and category together, as one exact number (facet × 2³² +
 * category: facet and category ids are integers well inside 2²¹ and 2³²).
 * The keys as they are outside a facet grid.
 */
export function withFacetKeys(
	keys: ArrayLike<number> | null,
	facets: ArrayLike<number> | null | undefined
): ArrayLike<number> | null {
	if (!keys || !facets) return keys;
	const n = Math.min(keys.length, facets.length);
	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) out[i] = facets[i] * 4294967296 + keys[i];
	return out;
}
