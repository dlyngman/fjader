/**
 * FilterGroupRegistry — named FilterGroups with lazy creation.
 *
 * Marks and interactors specify which group to use via their `selection`
 * prop (e.g. selection="brush"). Groups are created on first access.
 * Routes that don't use named selections get the "default" group.
 *
 * Also owns what is shared between the groups: each group's page-wide index,
 * and one FieldActivity per categorical field, which holds every group's
 * selection fade on that field.
 */

import type { ClockLoop } from '$lib/animation';
import { FilterGroup } from './FilterGroup.svelte';
import { FieldActivity, type FieldActivityHost } from './FieldActivity.svelte';
import type { QueryEngine } from './QueryEngine';

export class FilterGroupRegistry {
	#groups = new Map<string, FilterGroup>();
	#engine: QueryEngine | null = null;

	#fields = new Map<string, FieldActivity>();
	/**
	 * Bumped when a field is created, so a reader that found none (and so read
	 * no fade) runs again once it exists. Fields are created by selections and by
	 * the coordinator for every field a scale draws, never while a template
	 * renders.
	 */
	#fieldsVersion = $state(0);
	/** The same activities as an array, for the packer's per-frame loop. */
	#fieldList: FieldActivity[] = [];

	#loop: ClockLoop | null = null;
	#chartsFor: (key: string, out: string[]) => string[] = (_key, out) => out;

	/** Shared by every FieldActivity: reads the registry's current wiring. */
	#host: FieldActivityHost;

	constructor() {
		const registry = this;
		this.#host = {
			get loop() {
				return registry.#loop;
			},
			chartsFor: (key, out) => this.#chartsFor(key, out),
			identityOf: (key) => this.#engine?.peekIdentity(key) ?? null
		};
	}

	/** Wire the engine to all existing and future groups. */
	setEngine(engine: QueryEngine): void {
		this.#engine = engine;
		for (const group of this.#groups.values()) {
			group.setEngine(engine);
		}
	}

	/**
	 * Wire the fades to the animation loop and to the charts to redraw while
	 * they run. Called by the GPU coordinator. A fade created before this lands
	 * at once.
	 */
	setAnimation(loop: ClockLoop, chartsFor: (key: string, out: string[]) => string[]): void {
		this.#loop = loop;
		this.#chartsFor = chartsFor;
	}

	/** Get or create a FilterGroup by name. Undefined/null → "default". */
	get(name?: string | null): FilterGroup {
		const key = name ?? 'default';
		let g = this.#groups.get(key);
		if (!g) {
			// Indices are never reused or compacted: a mark keeps its group's
			// index from mount, so renumbering would point it at another group.
			g = new FilterGroup(this.#groups.size, (field) => this.field(field));
			if (this.#engine) g.setEngine(this.#engine);
			this.#groups.set(key, g);
		}
		return g;
	}

	/** Check if a named group exists (without creating it). */
	has(name: string): boolean {
		return this.#groups.has(name);
	}

	/** How many groups the page has: the packer writes one activity half per group. */
	get groupCount(): number {
		return this.#groups.size;
	}

	/** The selection state of a categorical field, by identity key. Created on first ask. */
	field(key: string): FieldActivity {
		let activity = this.#fields.get(key);
		if (!activity) {
			activity = new FieldActivity(key, this.#host);
			this.#fields.set(key, activity);
			this.#fieldList.push(activity);
			this.#fieldsVersion++;
		}
		return activity;
	}

	/**
	 * How visible `value` of field `key` is now, for a label shown for marks of
	 * several groups: the least visible over `groups`, so it dims when any of
	 * those groups dims it. 1 for a field no group ever selected on. Pure, so
	 * safe in a template: it creates nothing and reconciles nothing.
	 */
	opacityOfValue(key: string, groups: readonly number[], value: unknown): number {
		void this.#fieldsVersion;
		const activity = this.#fields.get(key);
		if (!activity) return 1;
		let opacity = 1;
		for (let i = 0; i < groups.length; i++) {
			opacity = Math.min(opacity, activity.opacityOfValue(groups[i], value));
		}
		return opacity;
	}

	/** Every field's activity, in creation order. Read every frame; do not mutate. */
	get fields(): readonly FieldActivity[] {
		return this.#fieldList;
	}
}
