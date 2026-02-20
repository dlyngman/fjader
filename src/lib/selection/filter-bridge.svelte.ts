// No need for TRUE_PREDICATE - use null for cleared states

interface FilterClause {
	predicate: any;
	source?: string;
	clients?: any[];
	value?: any[][];
	schema?: FilterSchema;
	[key: string]: any;
}

interface FilterSchema {
	kind?: string;
	column?: string;
	label?: string;
	values?: any[];
	[key: string]: any;
}

interface FilterEntry {
	source: string;
	sel: any;
	clause: FilterClause | null;
	enabled: boolean;
	scaleStates: (() => any[]) | null;
}

interface FilterItem {
	source: string;
	enabled: boolean;
	clause: FilterClause | null;
	schema?: FilterSchema;
}

interface CreateLocalOpts {
	source?: string;
	augment?: (clause: FilterClause) => FilterSchema | null;
	onVisualClear?: () => void;
	scaleStates?: () => any[];
}

interface ToggleEntry {
	sel: any;
	off: () => void;
	refCount: number;
}

/**
 * Checks if a clause is neutral/cleared (Mosaic standard: predicate is null).
 */
export function isNeutral(clause: FilterClause | null | undefined): boolean {
	return !clause || clause.predicate == null;
}

export class FilterBridge {
	Selection: any;
	filterSel: any;

	// Reactive storage - Map tracks all filter sources
	#entries: Map<string, FilterEntry> = $state(new Map());

	// Public reactive state - components subscribe to this
	items: FilterItem[] = $state([]);
	activeCount: number = $derived(this.items.length);

	// Scale states that have been projected to (for cleanup on clear)
	#projectedScales: Set<any> = new Set();

	// Shared toggle selections keyed by column (deduplicated, ref-counted)
	#toggleSelections: Map<string, ToggleEntry> = new Map();

	constructor(Selection: any, baseSel: any | any[]) {
		this.Selection = Selection;
		const base = Array.isArray(baseSel) ? baseSel : baseSel ? [baseSel] : [];
		this.filterSel = Selection.intersect({ cross: true, include: base });
	}

	// Sync items from entries to public state
	#syncItems(): void {
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
	#projectToScales(): void {
		const activeByScale = new Map<any, Set<any>>();

		for (const entry of this.#entries.values()) {
			if (!entry.scaleStates || !entry.enabled || isNeutral(entry.clause)) continue;

			const tuples = entry.clause?.value;
			if (!tuples?.length) continue;

			for (const scale of entry.scaleStates()) {
				if (!activeByScale.has(scale)) {
					activeByScale.set(scale, new Set());
				}
				const set = activeByScale.get(scale)!;
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

	createLocal(
		kind: 'single' | 'union' | 'intersect' = 'single',
		opts: CreateLocalOpts = {}
	): { sel: any; off: () => void } {
		const { source, augment, onVisualClear, scaleStates } = opts;

		const sel =
			kind === 'union'
				? this.Selection.union()
				: kind === 'intersect'
					? this.Selection.intersect()
					: this.Selection.single();

		// Listener: Mosaic Selection -> Svelte State
		const onValue = (): void => {
			let clause = sel.active;

			// Augment with metadata for UI display
			if (clause && augment) {
				const schema = augment(clause);
				if (schema) clause = { ...clause, schema };
			}

			if (isNeutral(clause)) {
				// Neutral/cleared state
				const entry = this.#entries.get(source!);

				// Update internal state
				if (entry) {
					entry.enabled = false;
					entry.clause = clause;
				} else {
					this.#entries.set(source!, {
						source: source!,
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
				this.#entries.set(source!, {
					source: source!,
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

		const onActivate = (clause: FilterClause): void => {
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
				this.remove(source!);
			}
		};
	}

	/**
	 * Get or create a shared toggle Selection for a column.
	 * Multiple components (Toggle, Legend) on the same field share one Selection,
	 * avoiding conflicting entries in filterSel.intersect().
	 */
	createToggle(
		column: string,
		opts: { scaleStates?: () => any[] } = {}
	): { sel: any; source: string; off: () => void } {
		const { scaleStates } = opts;

		if (this.#toggleSelections.has(column)) {
			const entry = this.#toggleSelections.get(column)!;
			entry.refCount++;
			return { sel: entry.sel, source: `toggle-${column}`, off: this.#toggleOff(column) };
		}

		const source = `toggle-${column}`;
		const { sel, off } = this.createLocal('single', {
			source,
			scaleStates,
			augment: (clause) => ({
				kind: 'toggle',
				column,
				label: column,
				values: clause?.value?.map((v: any[]) => v[0]) ?? []
			})
		});

		this.#toggleSelections.set(column, { sel, off, refCount: 1 });
		return { sel, source, off: this.#toggleOff(column) };
	}

	#toggleOff(column: string): () => void {
		return () => {
			const entry = this.#toggleSelections.get(column);
			if (!entry) return;
			if (--entry.refCount === 0) {
				entry.off();
				this.#toggleSelections.delete(column);
			}
		};
	}

	/**
	 * Clear the shared toggle Selection for a column.
	 */
	clearToggle(column: string): void {
		this.clear(`toggle-${column}`);
	}

	/**
	 * Manually clears a specific source.
	 * Delegates to Mosaic Selection which triggers onValue callback.
	 */
	clear(source: string): void {
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
	remove(source: string): void {
		this.clear(source); // Trigger clear first
		this.#entries.delete(source);
		this.#syncItems();
	}

	/**
	 * For manual clauses (not attached to a Mosaic Selection object)
	 */
	upsertManual(key: string, clause: FilterClause, schema: FilterSchema): void {
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
