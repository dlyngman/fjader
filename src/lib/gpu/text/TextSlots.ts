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
 * Plain class: its owner's effects decide when to call it (on new strings,
 * and on the atlas's `paintVersion`).
 */

import type { TextAtlas, TextStyle } from './TextAtlas.svelte';

export class TextSlots {
	readonly #atlas: TextAtlas;
	#held: number[] = [];
	#pending: { slots: Float32Array; acquired: number[] } | null = null;
	/** The slots last committed: what the rows draw. */
	current: Float32Array | null = null;

	constructor(atlas: TextAtlas) {
		this.#atlas = atlas;
	}

	/**
	 * New strings, one per row (null: no label). Acquires them; a stage not yet
	 * committed is dropped in favour of this one.
	 */
	stage(labels: readonly (string | null)[] | null, style: TextStyle): void {
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
		this.#pending = { slots, acquired };
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
	}
}
