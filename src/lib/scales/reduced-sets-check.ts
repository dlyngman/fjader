/**
 * Whether the marks that each decide a band axis's categories (a `topN` per
 * mark) agree on them.
 *
 * Every mark on a band axis adds its categories to it, and the axis shows the
 * union. Two marks that each keep their own top N and keep DIFFERENT sets put
 * categories on the axis that only one of them draws: bars without labels,
 * labels without bars, a back layer's totals without the front layer's parts.
 * That is by design when the sets differ for a reason, such as a layer that
 * ignores the selection behind one that re-ranks within it, and the answer is
 * for one of them to rank and the others to follow (`contributeDomain={false}`).
 * Nothing said so; this does, once per axis.
 *
 * Checked after the axis has been quiet for a while, not on each registration:
 * after a filter, one mark's re-ranked result lands before the other's, and
 * the sets differ for that moment without anything being wrong.
 */

/** How long the axis must go without a reducing mark's registration before checking. */
export const REDUCED_SETS_QUIET_MS = 1500;

/** The space a mark's categories were registered in: dim ids, or source values. */
type Space = 'ids' | 'values';

export class ReducedSetsCheck {
	readonly #sets = new Map<string, { space: Space; key: string }>();
	#timer: ReturnType<typeof setTimeout> | null = null;
	#warned = false;
	readonly #axisName: () => string;
	readonly #warn: (message: string) => void;

	constructor(axisName: () => string, warn: (message: string) => void = console.warn) {
		this.#axisName = axisName;
		this.#warn = warn;
	}

	/** A reducing mark registered `values` (its whole category set) in `space`. */
	note(markId: string, space: Space, values: readonly unknown[]): void {
		if (this.#warned) return;
		const key = values
			.map((v) => (v === null ? '\u0000null' : String(v)))
			.sort()
			.join('\u0001');
		this.#sets.set(markId, { space, key });
		this.#schedule();
	}

	/** The mark left the axis, or stopped reducing. */
	remove(markId: string): void {
		this.#sets.delete(markId);
	}

	#schedule(): void {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.check();
		}, REDUCED_SETS_QUIET_MS);
	}

	/** Compare now. Public for tests; the quiet period calls it otherwise. */
	check(): void {
		if (this.#warned || this.#sets.size < 2) return;
		const entries = [...this.#sets.values()];
		// One mark's dim not having arrived yet registers source values while
		// another's ids are in: not comparable, and transient.
		if (entries.some((e) => e.space !== entries[0].space)) return;
		if (entries.every((e) => e.key === entries[0].key)) return;
		this.#warned = true;
		this.#warn(
			`[fjader] Band axis "${this.#axisName()}": marks ${[...this.#sets.keys()].join(', ')} ` +
				`each keep their own top N categories, and the sets differ, so the axis shows ` +
				`categories that only some of them draw. Rank in one mark and give the others ` +
				`contributeDomain={false}, so they follow its categories.`
		);
	}

	destroy(): void {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		this.#sets.clear();
	}
}
