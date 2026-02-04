// No need for TRUE_PREDICATE - use null for cleared states

/**
 * Checks if a clause is neutral/cleared (Mosaic standard: predicate is null).
 */
export function isNeutral(clause) {
	return !clause || clause.predicate == null;
}

export class FilterBridge {
	// Reactive storage - Map tracks all filter sources
	#entries = $state(new Map());

	// Public reactive state - components subscribe to this
	items = $state([]);
	activeCount = $derived(this.items.length);

	constructor(Selection, baseSel) {
		this.Selection = Selection;
		const base = Array.isArray(baseSel) ? baseSel : baseSel ? [baseSel] : [];
		this.filterSel = Selection.intersect({ cross: true, include: base });
	}

	// Sync items from entries to public state
	#syncItems() {
		this.items = Array.from(this.#entries.values())
			.filter((e) => e.enabled && !isNeutral(e.clause))
			.map(({ source, clause, enabled }) => ({
				source,
				enabled,
				clause,
				schema: clause?.schema
			}));
	}

	createLocal(kind = 'single', opts = {}) {
		const { source, augment, onVisualClear } = opts;

		const sel =
			kind === 'union'
				? this.Selection.union()
				: kind === 'intersect'
					? this.Selection.intersect()
					: this.Selection.single();

		// Listener: Mosaic Selection -> Svelte State
		const onValue = () => {
			let clause = sel.active;

			// Augment with metadata for UI display
			if (clause && augment) {
				const schema = augment(clause);
				if (schema) clause = { ...clause, schema };
			}

			if (isNeutral(clause)) {
				// Neutral/cleared state
				const entry = this.#entries.get(source);

				// Update internal state
				if (entry) {
					entry.enabled = false;
					entry.clause = clause;
				} else {
					this.#entries.set(source, {
						source,
						sel,
						clause,
						enabled: false
					});
				}

				// Update Mosaic output - pass through the clause as-is
				this.filterSel.update(clause);

				// Sync UI visuals
				onVisualClear?.();
			} else {
				// Active filter - pass through
				this.#entries.set(source, {
					source,
					sel,
					clause,
					enabled: true
				});

				this.filterSel.update(clause);
			}

			// Sync public reactive state
			this.#syncItems();
		};

		const onActivate = (clause) => {
			if (clause && !isNeutral(clause)) {
				this.filterSel.activate?.({ ...clause, source });
			}
		};

		// Bind listeners
		sel.addEventListener('value', onValue);
		sel.addEventListener('activate', onActivate);

		// Note: We don't pre-initialize entries - they're created on first value event

		return {
			sel,
			off: () => {
				sel.removeEventListener('value', onValue);
				sel.removeEventListener('activate', onActivate);
				this.remove(source);
			}
		};
	}

	/**
	 * Manually clears a specific source.
	 * Delegates to Mosaic Selection which triggers onValue callback.
	 */
	clear(source) {
		const entry = this.#entries.get(source);
		if (!entry?.sel) return;

		// Send neutral clause to Mosaic - onValue callback handles our state
		entry.sel.update({
			predicate: null,
			source,
			clients: entry.clause?.clients,
			value: null
		});
	}

	/**
	 * Completely removes a source from the registry
	 */
	remove(source) {
		this.clear(source); // Trigger clear first
		this.#entries.delete(source);
		this.#syncItems();
	}

	/**
	 * For manual clauses (not attached to a Mosaic Selection object)
	 */
	upsertManual(key, clause, schema) {
		const source = `manual:${key}`;
		const c = { ...clause, source, schema };

		this.#entries.set(source, {
			source,
			sel: null,
			clause: c,
			enabled: true
		});

		this.filterSel.update(c);
		this.#syncItems();
	}
}
