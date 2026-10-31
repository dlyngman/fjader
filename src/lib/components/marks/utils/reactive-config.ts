/**
 * Shared helper for building ReactiveConfig from a mark entry.
 *
 * ReactiveConfig provides getters that lazily read the mark's reactive state.
 * Changes to these values trigger re-query or side effects without lifecycle teardown.
 */

import type { ReactiveConfig } from '../lifecycle/MarkLifecycleV2.svelte';
import type { MarkEntry } from '$lib/config/ChartConfig.svelte';
import { normalizeSortConfig } from './index';

/**
 * Build a ReactiveConfig from a mark entry and optional overrides.
 *
 * @param entry - The mark entry (reactive props from ChartConfig)
 * @param opts.resolveFitDomain - Getter for resolved fitDomain (deferred read)
 */
export function buildReactiveConfig(
	entry: Partial<Pick<MarkEntry, 'sort' | 'limit' | 'domain' | 'tooltip' | 'tip' | 'fitDomain'>>,
	opts?: {
		resolveFitDomain?: () => 'x' | 'y' | boolean | undefined;
	}
): ReactiveConfig {
	return {
		get sort() {
			return normalizeSortConfig(entry.sort ?? null);
		},
		get limit() {
			return entry.limit;
		},
		get domain() {
			return entry.domain ?? null;
		},
		get tooltip() {
			return entry.tip === false ? false : entry.tooltip;
		},
		get fitDomain() {
			return opts?.resolveFitDomain?.() ?? entry.fitDomain;
		},
		get tip() {
			return entry.tip;
		}
	};
}
