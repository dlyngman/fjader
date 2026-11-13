/**
 * A debug record of every transition that starts, and whether it animates.
 *
 * For test pages that check an animation claim, such as "a chart catching up
 * on its return animates nothing of its own", without reading it off the
 * screen: a spring that plays off screen and two springs to one place both
 * look like nothing happened. Reported where a transition actually starts:
 *
 * - `domain`: a continuous scale's domain (data extents and fitDomain alike)
 * - `morph`: a mark's morphed values (bars, dots on a band axis)
 * - `slots`: a band axis's categories moving to new slots
 *
 * The cause is not recorded: the emitters do not know it, and the page does
 * (it knows what it just did).
 *
 * MODULE-GLOBAL: one log per page (per module instance), not per coordinator.
 * Two coordinators in one document (notebook cells, Streamlit iframes sharing
 * it) see each other's records; filter by chart id. Fine for a debug hook.
 *
 * Free while nothing observes: each emitter asks `transitionsObserved()`
 * before building a record.
 */

import { untrack } from 'svelte';

export type TransitionPart = 'domain' | 'morph' | 'slots';

export interface TransitionRecord {
	part: TransitionPart;
	/** True when it landed at once, false when it animates. */
	snap: boolean;
	/** The charts it moves something in. */
	charts: readonly string[];
	/** What moved: a scale name, a renderer label. */
	label: string;
	/** performance.now() */
	time: number;
}

const observers = new Set<(record: TransitionRecord) => void>();
/** Noted and not yet delivered: see noteTransition. */
let queued: TransitionRecord[] = [];

/** Listen to every transition started; returns the unsubscribe. */
export function observeTransitions(listener: (record: TransitionRecord) => void): () => void {
	observers.add(listener);
	return () => observers.delete(listener);
}

/** Whether anything listens: emitters check this before building a record. */
export function transitionsObserved(): boolean {
	return observers.size > 0;
}

export function noteTransition(
	part: TransitionPart,
	snap: boolean,
	/** Read untracked, now: the emitter is usually inside an effect. */
	charts: () => readonly string[],
	label: string
): void {
	if (observers.size === 0) return;
	const list = untrack(() => [...charts()]);
	queued.push({ part, snap, charts: list, label, time: performance.now() });
	// Delivered in a microtask, never in the emitter's own call: transitions
	// start inside effects (a renderer's write, a scale update), and a
	// listener run there that reads state makes that effect depend on it. A
	// page appending to a $state log then re-ran the emitting effect on every
	// record, which logged again, and never stopped.
	if (queued.length === 1) queueMicrotask(deliver);
}

function deliver(): void {
	const records = queued;
	queued = [];
	for (const record of records) for (const observe of observers) observe(record);
}
