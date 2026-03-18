/**
 * SelectionRegistry — context-based singleton for managing named selection groups.
 *
 * Context-based singleton for managing named selection groups. Groups are auto-created
 * on first reference and shared across all components in the render tree.
 */

import { getContext, setContext } from 'svelte';
import type { Selection, SelectionClause } from '@uwdata/mosaic-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Narrow protocol for scale states that support active-value projection.
 * Implemented by ColorScaleState and BandScaleState.
 */
export interface ActiveValueScale {
	setActiveValues(values: Set<unknown>): void;
	clearActiveValues(): void;
}

export interface FilterSchema {
	kind?: string;
	column?: string;
	label?: string;
	values?: unknown[];
	[key: string]: unknown;
}

/** A clause augmented with DivePlot-specific schema metadata. */
export interface AugmentedClause extends SelectionClause {
	schema?: FilterSchema;
}

interface FilterEntry {
	source: string;
	sel: Selection;
	clause: AugmentedClause | null;
	enabled: boolean;
	scaleStates: (() => ActiveValueScale[]) | null;
}

export interface FilterItem {
	source: string;
	enabled: boolean;
	clause: AugmentedClause | null;
	schema?: FilterSchema;
}

export interface CreateLocalOpts {
	source?: string;
	augment?: (clause: SelectionClause) => FilterSchema | null;
	onVisualClear?: () => void;
	scaleStates?: () => ActiveValueScale[];
}

interface ToggleEntry {
	sel: Selection;
	off: () => void;
	refCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Checks if a clause is neutral/cleared (Mosaic standard: predicate is null). */
export function isNeutral(clause: SelectionClause | AugmentedClause | null | undefined): boolean {
	return !clause || clause.predicate == null;
}

// ---------------------------------------------------------------------------
// SelectionGroup
// ---------------------------------------------------------------------------

/**
 * A named crossfilter group. Manages Mosaic Selections for a set of linked
 * marks, interactors, and legends that share a common selection name.
 */
export class SelectionGroup {
	SelectionClass: typeof Selection;
	filterSel: Selection;

	#entries: Map<string, FilterEntry> = $state(new Map());
	items: FilterItem[] = $state([]);
	activeCount: number = $derived(this.items.length);
	#projectedScales: Set<ActiveValueScale> = new Set();
	#toggleSelections: Map<string, ToggleEntry> = new Map();

	constructor(SelectionClass: typeof Selection) {
		this.SelectionClass = SelectionClass;
		this.filterSel = SelectionClass.intersect({ cross: true });
	}

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

	#projectToScales(): void {
		const activeByScale = new Map<ActiveValueScale, Set<unknown>>();

		for (const entry of this.#entries.values()) {
			if (!entry.scaleStates || !entry.enabled || isNeutral(entry.clause)) continue;
			const tuples = entry.clause?.value as unknown[][] | undefined;
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
	): { sel: Selection; off: () => void } {
		const { source, augment, onVisualClear, scaleStates } = opts;

		const sel =
			kind === 'union'
				? this.SelectionClass.union()
				: kind === 'intersect'
					? this.SelectionClass.intersect()
					: this.SelectionClass.single();

		const onValue = (): void => {
			let clause: AugmentedClause = sel.active;
			if (clause && augment) {
				const schema = augment(clause);
				if (schema) clause = { ...clause, schema };
			}

			if (isNeutral(clause)) {
				const entry = this.#entries.get(source!);
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
				this.filterSel.update(clause);
				onVisualClear?.();
			} else {
				this.#entries.set(source!, {
					source: source!,
					sel,
					clause,
					enabled: true,
					scaleStates: scaleStates || null
				});
				this.filterSel.update(clause);
			}

			this.#syncItems();
		};

		const onActivate = (clause: SelectionClause): void => {
			if (clause && !isNeutral(clause)) {
				this.filterSel.activate?.({
					...clause,
					source: source as unknown as SelectionClause['source']
				});
			}
		};

		sel.addEventListener('value', onValue);
		sel.addEventListener('activate', onActivate as unknown as typeof onValue);

		return {
			sel,
			off: () => {
				sel.removeEventListener('value', onValue);
				sel.removeEventListener('activate', onActivate as unknown as typeof onValue);
				this.remove(source!);
			}
		};
	}

	createToggle(
		column: string,
		opts: { scaleStates?: () => ActiveValueScale[] } = {}
	): { sel: Selection; source: string; off: () => void } {
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
				values: clause?.value ? (clause.value as unknown[][]).map((v) => v[0]) : []
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

	clearToggle(column: string): void {
		this.clear(`toggle-${column}`);
	}

	clear(source: string): void {
		const entry = this.#entries.get(source);
		if (!entry?.sel) return;
		entry.sel.update({
			predicate: null,
			source: source as unknown as SelectionClause['source'],
			clients: entry.clause?.clients,
			value: null
		} as SelectionClause);
	}

	remove(source: string): void {
		this.clear(source);
		this.#entries.delete(source);
		this.#syncItems();
	}

	upsertManual(key: string, clause: SelectionClause, schema: FilterSchema): void {
		const source = `manual:${key}`;
		const c: AugmentedClause = {
			...clause,
			source: source as unknown as SelectionClause['source'],
			schema
		};
		this.#entries.set(source, {
			source,
			sel: null as unknown as Selection,
			clause: c,
			enabled: true,
			scaleStates: null
		});
		this.filterSel.update(c);
		this.#syncItems();
	}

	removeManual(key: string): void {
		const source = `manual:${key}`;
		const entry = this.#entries.get(source);
		if (!entry) return;
		// Clear the predicate from the Mosaic filterSel (clear() can't do this
		// for manual entries because sel is null)
		this.filterSel.update({
			predicate: null,
			source: source as unknown as SelectionClause['source'],
			clients: entry.clause?.clients,
			value: null
		} as SelectionClause);
		this.#entries.delete(source);
		this.#syncItems();
	}
}

// ---------------------------------------------------------------------------
// SelectionRegistry
// ---------------------------------------------------------------------------

const CONTEXT_KEY = 'selection-registry';

/**
 * Singleton that manages named SelectionGroups. Lives in Svelte context.
 * Groups are auto-created on first reference as crossfilter selections.
 */
export class SelectionRegistry {
	#SelectionClass: typeof Selection;
	#groups = new Map<string, SelectionGroup>();

	constructor(SelectionClass: typeof Selection) {
		this.#SelectionClass = SelectionClass;
	}

	/** Get (or auto-create) a named selection group. */
	getGroup(name: string): SelectionGroup {
		let group = this.#groups.get(name);
		if (!group) {
			group = new SelectionGroup(this.#SelectionClass);
			this.#groups.set(name, group);
		}
		return group;
	}

	/** Shortcut: get the Mosaic Selection for a named group (for marks). */
	getSelection(name: string): Selection {
		return this.getGroup(name).filterSel;
	}
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

export function setSelectionRegistry(SelectionClass: typeof Selection): SelectionRegistry {
	const registry = new SelectionRegistry(SelectionClass);
	return setContext(CONTEXT_KEY, registry);
}

export function getSelectionRegistry(): SelectionRegistry | null {
	return getContext<SelectionRegistry | null>(CONTEXT_KEY) ?? null;
}
