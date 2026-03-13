/**
 * Creates a reactive channel that derives from a prop getter but can be
 * overridden via assignment. When the prop changes, the override is cleared
 * and the derived value re-evaluates.
 *
 * This is the building block for ChartConfig entries — each entry property
 * is an overridable channel backed by a writable $derived.
 */

export interface Overridable<T> {
	current: T;
	reset(): void;
}

export function createOverridable<T>(getProp: () => T): Overridable<T> {
	let value: T = $derived(getProp());
	return {
		get current(): T {
			return value;
		},
		set current(v: T) {
			value = v;
		},
		reset() {
			value = getProp();
		}
	};
}
