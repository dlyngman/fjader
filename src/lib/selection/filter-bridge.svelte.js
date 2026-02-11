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

	// Scale states that have been projected to (for cleanup on clear)
	#projectedScales = new Set();

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

		this.#projectToScales();
	}

	/**
	 * Project toggle selection state onto scale activeValues.
	 * Reads selected values directly from clause.value (array of tuples from clausePoints).
	 * Scale state refs are resolved lazily via getter functions passed at registration.
	 */
	#projectToScales() {
		const activeByScale = new Map();

		for (const entry of this.#entries.values()) {
			if (!entry.scaleStates || !entry.enabled || isNeutral(entry.clause)) continue;

			const tuples = entry.clause?.value;
			if (!tuples?.length) continue;

			for (const scale of entry.scaleStates()) {
				if (!activeByScale.has(scale)) {
					activeByScale.set(scale, new Set());
				}
				const set = activeByScale.get(scale);
				for (const t of tuples) set.add(t[0]);
			}
		}

		for (const [scale, values] of activeByScale) {
			scale.setActiveValues(values);
		}

		for (const scale of this.#projectedScales) {
			if (!activeByScale.has(scale)) {
				scale.clearActiveValues();
			}
		}

		this.#projectedScales = new Set(activeByScale.keys());
	}

	createLocal(kind = 'single', opts = {}) {
		const { source, augment, onVisualClear, scaleStates } = opts;

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
						enabled: false,
						scaleStates: scaleStates || null
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
					enabled: true,
					scaleStates: scaleStates || null
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
	 * Clear all toggle entries matching a column name.
	 * Used by Toggle's click-outside to clear selections regardless of source
	 * (e.g., clearing a Legend-initiated selection from the bar chart).
	 */
	clearByColumn(column) {
		for (const [source, entry] of this.#entries) {
			if (entry.clause?.schema?.column === column) {
				this.clear(source);
			}
		}
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
			enabled: true,
			scaleStates: null
		});

		this.filterSel.update(c);
		this.#syncItems();
	}
}
