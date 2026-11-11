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

	/**
	 * The groups in creation order, as a reactive reader sees them: the names and
	 * the groups, each a new array when a group is created (never mutated), so a
	 * reader re-renders. Written in a microtask, not by `get`: templates and
	 * deriveds call `get`, where writing state throws (`state_unsafe_mutation`). A
	 * reader of `has`, `isActive`, `names` or `groups` re-runs one microtask after a
	 * group appears; the plain `#groups` is current at once.
	 */
	#names = $state.raw<readonly string[]>([]);
	#all = $state.raw<readonly FilterGroup[]>([]);
	#announcing = false;
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
			this.#announce();
		}
		return g;
	}

	/** Publish the groups to reactive readers, once per microtask however many were created. */
	#announce(): void {
		if (this.#announcing) return;
		this.#announcing = true;
		queueMicrotask(() => {
			this.#announcing = false;
			this.#names = [...this.#groups.keys()];
			this.#all = [...this.#groups.values()];
		});
	}

	/**
	 * Whether a named group exists, without creating it. Reactive: a reader re-runs
	 * when the group is created. (`get` creates, and a group created inside the
	 * reading derived is state that derived cannot track.)
	 */
	has(name?: string | null): boolean {
		void this.#names;
		return this.#groups.has(name ?? 'default');
	}

	/**
	 * Whether a named group has a selection (a brush, a toggle, a legend), without
	 * creating it: false for a group no chart has made yet. Reactive in both the
	 * group appearing and its clauses changing, so `$derived(groups.isActive('brush'))`
	 * is safe before any chart exists.
	 */
	isActive(name?: string | null): boolean {
		void this.#names;
		const group = this.#groups.get(name ?? 'default');
		return group ? group.activeCount > 0 : false;
	}

	/**
	 * The names of the groups, in creation order. Reactive; a new array when a
	 * group is created. For app code that must reach every group the page's marks
	 * use, such as a clause that applies to the whole page.
	 */
	get names(): readonly string[] {
		return this.#names;
	}

	/** The groups, in the order of `names`. Reactive in the same way. */
	get groups(): readonly FilterGroup[] {
		return this.#all;
	}

	/** How many groups the page has: the packer writes one activity half per group. */
	get groupCount(): number {
		return this.#groups.size;
	}

	/**
	 * The selection state of a categorical field, by identity key. Created on
	 * first ask, by a selection or by the coordinator for a field a scale draws.
	 *
	 * Never removed: a session that switches through many categorical columns
	 * keeps every field it drew, each one step of the coordinator's per-frame
	 * reconcile loop. Their buffer space is freed (the packer gives a block only
	 * to fields a scale draws), so this costs a loop step, not memory on the GPU.
	 * Dropping a field once no scale draws it and no group selects on it is a
	 * possible follow-up.
	 */
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

	/**
	 * How visible the category with dim id `id` of field `key` is now: the id form
	 * of `opacityOfValue`, and the one a label for an Other bucket must use. The
	 * least visible over `groups`. Pure, so safe in a template.
	 */
	opacityOfId(key: string, groups: readonly number[], id: number): number {
		void this.#fieldsVersion;
		const activity = this.#fields.get(key);
		if (!activity) return 1;
		let opacity = 1;
		for (let i = 0; i < groups.length; i++) {
			opacity = Math.min(opacity, activity.opacityOfId(groups[i], id));
		}
		return opacity;
	}

	/** Every field's activity, in creation order. Read every frame; do not mutate. */
	get fields(): readonly FieldActivity[] {
		return this.#fieldList;
	}
}
