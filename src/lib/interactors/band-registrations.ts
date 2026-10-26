import type { ToggleHandle } from '$lib/query-engine/FilterGroup.svelte';

type Axis = 'x' | 'y';

/**
 * A Toggle's registrations for its chart's band axis fields, one per axis, so
 * label clicks toggle the axis's own field.
 *
 * Synced on every hover and click rather than on the first label click, so a
 * field activates before it is clicked and follows a band channel reassigned
 * at runtime. Destroying a registration clears its selection when it was the
 * last control for it, so a registration is dropped only when its axis has a
 * band scale for a different field. An axis with no band scale right now (a
 * scale being rebuilt after a reload, a channel mid-reassignment) keeps what
 * it has: a hover at that moment must not clear a selection.
 */
export class BandRegistrations {
	#byAxis = new Map<Axis, { field: string; handle: ToggleHandle }>();
	#register: (field: string) => ToggleHandle;
	#ownedElsewhere: (field: string) => boolean;

	/**
	 * @param register creates a registration for a band field
	 * @param ownedElsewhere true for a field the Toggle already registers itself
	 *   (its declared field), which needs no second registration
	 */
	constructor(
		register: (field: string) => ToggleHandle,
		ownedElsewhere: (field: string) => boolean
	) {
		this.#register = register;
		this.#ownedElsewhere = ownedElsewhere;
	}

	/** Bring registrations in line with each axis's band field, or null where it has none now. */
	sync(fields: Record<Axis, string | null>): void {
		const dropped: ToggleHandle[] = [];
		for (const axis of ['x', 'y'] as const) {
			const field = fields[axis];
			if (field == null) continue;
			const current = this.#byAxis.get(axis);
			if (current?.field === field) continue;
			if (current) dropped.push(current.handle);
			this.#byAxis.delete(axis);
			if (!this.#ownedElsewhere(field)) {
				this.#byAxis.set(axis, { field, handle: this.#register(field) });
			}
		}
		// After the new registrations, so a field that only moved axes (a
		// transpose) never loses its last one and with it its selection.
		for (const handle of dropped) handle.destroy();
	}

	handleFor(field: string): ToggleHandle | null {
		for (const entry of this.#byAxis.values()) if (entry.field === field) return entry.handle;
		return null;
	}

	/** Each registered field with its handle. */
	entries(): Array<[string, ToggleHandle]> {
		return [...this.#byAxis.values()].map(({ field, handle }) => [field, handle]);
	}

	destroy(): void {
		for (const { handle } of this.#byAxis.values()) handle.destroy();
		this.#byAxis.clear();
	}
}
