import { createSelectionRegistry } from './selection-registry.js';

export class FilterBridge {
	items = $state([]);
	activeCount = $derived(this.items.length);

	registry; // Underlying non-reactive registry

	constructor(Selection, baseSel) {
		this.registry = createSelectionRegistry({
			Selection,
			base: baseSel,
			makeFilterSel: (base) => Selection.intersect({ cross: true, include: base })
		});

		// Sync reactive state
		const sync = () => {
			this.items = this.registry.snapshot();
		};
		this.registry.subscribe(sync);
		sync();
	}

	get filterSel() {
		return this.registry.filterSel;
	}

	createLocal(kind, opts) {
		return this.registry.createLocal(kind, opts);
	}

	clear(source) {
		this.registry.clear(source);
	}

	remove(source) {
		this.registry.remove(source);
	}

	upsertManual(key, clause, schema) {
		this.registry.upsertManual(key, clause, schema);
	}

	isNeutral(clause) {
		return this.registry.isNeutral(clause);
	}
}
