import { sql } from '@uwdata/mosaic-sql';

const TRUE_PREDICATE = sql`TRUE`;

// Neutral clause detection
export function isNeutral(clause) {
	if (!clause) return true;
	if (clause.predicate === TRUE_PREDICATE) return true;
	if (clause.predicate?.type === 'TRUE') return true;

	// Check schema if present
	const schema = clause.schema;
	if (!schema) return false;

	if (schema.kind === 'eq') {
		return !schema.values || schema.values.length === 0 || schema.values[0] == null;
	}
	if (schema.kind === 'in') {
		return !schema.values || schema.values.length === 0;
	}
	if (schema.kind === 'range') {
		// Handle 1D range (values) or 2D range (xValues/yValues)
		if (schema.xValues !== undefined && schema.yValues !== undefined) {
			// 2D range - check if both dimensions have valid values
			const xEmpty = !schema.xValues || schema.xValues.length === 0 || (schema.xValues[0] == null && schema.xValues[1] == null);
			const yEmpty = !schema.yValues || schema.yValues.length === 0 || (schema.yValues[0] == null && schema.yValues[1] == null);
			return xEmpty || yEmpty;
		} else {
			// 1D range - check values array
			const [a, b] = Array.isArray(schema.values) ? schema.values : [undefined, undefined];
			return a == null && b == null;
		}
	}

	return false;
}

export function createSelectionRegistry(opts) {
	const { Selection } = opts;
	const base = Array.isArray(opts.base) ? opts.base : opts.base ? [opts.base] : [];
	const filterSel =
		opts.makeFilterSel?.(base) ?? Selection.intersect({ cross: true, include: base });

	// Track registered selections and their metadata
	const listeners = new Map(); // Selection -> { sel, onValue, onActivate, source, augment, onVisualClear }
	const entries = new Map(); // source -> { clause, enabled }

	// Reactive pub/sub for UI updates
	const subs = new Set();
	let notifyTimer;
	const notify = () => {
		clearTimeout(notifyTimer);
		notifyTimer = setTimeout(() => {
			subs.forEach((fn) => fn());
		}, 0);
	};

	function snapshot(opts) {
		const includeDisabled = !!opts?.includeDisabled;
		const list = Array.from(entries.entries()).map(([source, { clause, enabled }]) => ({
			source,
			enabled,
			clause,
			schema: clause?.schema
		}));
		return includeDisabled ? list : list.filter((it) => it.enabled && !isNeutral(it.clause));
	}

	function subscribe(fn) {
		subs.add(fn);
		return () => subs.delete(fn);
	}

	function unregister(sel) {
		const rec = listeners.get(sel);
		if (!rec) return;

		const { sel: s, onValue, onActivate, source } = rec;
		s.removeEventListener?.('value', onValue);
		s.removeEventListener?.('activate', onActivate);
		listeners.delete(sel);

		// Neutralize & hide
		if (entries.has(source)) {
			const e = entries.get(source);
			e.enabled = false;
			e.clause = {
				source,
				predicate: TRUE_PREDICATE,
				clients: new Set(),
				schema: { kind: 'custom', label: 'neutralized' }
			};
			filterSel.update(e.clause);
			notify();
		}
	}

	function register(sel, opts) {
		if (listeners.has(sel)) return () => unregister(sel);

		const source = opts?.source ?? sel;
		const { augment, onVisualClear } = opts || {};

		const onValue = () => {
			let clause = sel.active;

			// Apply augment if provided
			if (clause && augment) {
				const schema = augment(clause);
				if (schema) {
					clause = { ...clause, schema };
				}
			}

			if (clause && !isNeutral(clause)) {
				// Forward real clause
				entries.set(source, { clause, enabled: true });
				filterSel.update(clause);
			} else {
				// Selection cleared or neutral: hide it
				const neutral = {
					source,
					predicate: TRUE_PREDICATE,
					clients: new Set(),
					schema: { kind: 'custom', label: '(cleared)' }
				};
				entries.set(source, { clause: neutral, enabled: false });
				filterSel.update(neutral);

				// Sync visual state (e.g., clear brush overlay)
				onVisualClear?.();
			}
			notify();
		};

		const onActivate = () => {
			const clause = sel.active;
			if (clause && !isNeutral({ ...clause, schema: augment?.(clause) ?? clause?.schema })) {
				filterSel.activate?.({ ...clause, source });
			}
		};

		sel.addEventListener?.('value', onValue);
		sel.addEventListener?.('activate', onActivate);
		listeners.set(sel, { sel, onValue, onActivate, source, augment, onVisualClear });

		return () => unregister(sel);
	}

	function createLocal(kind = 'single', opts) {
		const sel =
			kind === 'union'
				? Selection.union()
				: kind === 'intersect'
					? Selection.intersect()
					: Selection.single();
		const off = register(sel, opts);
		return { sel, off };
	}

	function clear(source) {
		// Clear any registered selection(s) associated with this source
		for (const rec of listeners.values()) {
			if (rec.source === source) {
				// Mosaic selections typically expose clear(); fallback to pushing TRUE
				rec.sel.clear?.() ?? rec.sel.update?.({ predicate: TRUE_PREDICATE });
			}
		}

		// Neutralize & hide in registry regardless
		const neutral = {
			source,
			predicate: TRUE_PREDICATE,
			clients: new Set(),
			schema: { kind: 'custom', label: '(cleared)' }
		};
		entries.set(source, { clause: neutral, enabled: false });
		filterSel.update(neutral);
		notify();
	}

	function remove(source) {
		// Clear first so downstream predicate is TRUE
		clear(source);
		// Then drop it from the list
		entries.delete(source);
		notify();
	}

	function upsertManual(sourceKey, clause, schema) {
		const source = `manual:${sourceKey}`;
		const c = { ...clause, source, schema };
		entries.set(source, { clause: c, enabled: true });
		filterSel.update(c);
		notify();
	}

	return {
		filterSel,
		register,
		unregister,
		createLocal,
		clear,
		remove,
		upsertManual,
		subscribe,
		snapshot,
		isNeutral
	};
}
