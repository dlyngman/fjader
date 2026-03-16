<script lang="ts">
	import { getContext, onDestroy, tick } from 'svelte';
	import type { ChartContext } from '$lib/types';
	import type { MarkEntry } from '$lib/config/ChartConfig.svelte';
	import { tableSchemaService } from '$lib/data/TableSchemaService.svelte';
	import {
		getAssignableChannels,
		getCompatibleColumns,
		getCompatibleScaleTypes,
		getOptionChannels,
		getNumericChannels,
		channelSupportsConstant,
		getConstantDef,
		CHART_CHANNELS,
		CHART_CHANNEL_DEFS,
		CHART_NUMERIC_DEFS,
		CHART_NUMERIC_GROUPS
	} from './palette-channels';
	import type {
		ChartChannel,
		OptionChannelDef,
		NumericChannelDef,
		NumericGroupDef
	} from './palette-channels';
	import { exportSpecJSON } from '$lib/spec/export';
	import type { LODState } from '$lib/lod/LODController.svelte';
	import type { LODController } from '$lib/lod/LODController.svelte';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();

	const chartContext = getContext<ChartContext>('chart');

	// ---- Tab types ----
	type TabItem = { kind: 'mark'; entry: MarkEntry } | { kind: 'chart' };

	// ---- State ----
	let activeTabIndex = $state(
		(() => {
			const hoveredId = chartContext.tooltipManager?.currentMarkId;
			if (!hoveredId) return 0;
			let i = 0;
			for (const entry of chartContext.config.entries.values()) {
				if (entry.id === hoveredId) return i;
				i++;
			}
			return 0;
		})()
	);

	let focusZone: 'tabs' | 'channels' | 'values' = $state('channels');
	let channelHighlightRaw = $state(0);
	let expandedChannel: string | null = $state(null);
	let valueHighlightRaw = $state(0);
	let filterText = $state('');
	let checkpointed = false;
	let originalColumnName: string | null = $state(null);
	let keyboardNav = $state(false);
	let filterRevealed = $state(false);
	/** When true, the value panel shows a numeric scrubber instead of a list. */
	let numericMode = $state(false);
	/** Current numeric scrubber value (live-updated). */
	let scrubberValue = $state(0);
	/** String representation for bind:value on the input — kept in sync with scrubberValue. */
	let scrubberText = $state('0');
	/** Drag state for mouse scrubbing. */
	let scrubDragState: { startY: number; startValue: number } | null = $state(null);
	/** Remembered constant values per channel (survives column↔constant switches). */
	const lastConstantValues = new Map<string, number>();
	/** Focused item index within a numeric group. */
	let groupFocusIndex = $state(0);
	/** Whether we're editing the focused group input (vs navigating rows). */
	let groupEditing = $state(false);
	/** Brief feedback after copying spec to clipboard. */
	let copyFeedback = $state(false);

	// DOM refs
	let filterInput: HTMLInputElement | null = $state(null);
	let scrubberInput: HTMLInputElement | null = $state(null);
	let groupInputs: (HTMLInputElement | HTMLSpanElement)[] = $state([]);
	let valueListEl: HTMLDivElement | null = $state(null);
	let channelListEl: HTMLDivElement | null = $state(null);
	let panelEl: HTMLDivElement | null = $state(null);

	// Initial focus — tick() waits for DOM, then focuses the panel
	updateFocus();

	// ---- Derived: tabs ----
	const tabList: TabItem[] = $derived.by(() => {
		const tabs: TabItem[] = [];
		for (const entry of chartContext.config.entries.values()) {
			tabs.push({ kind: 'mark', entry });
		}
		tabs.push({ kind: 'chart' });
		return tabs;
	});

	const activeTab: TabItem | undefined = $derived(
		tabList[Math.min(activeTabIndex, tabList.length - 1)]
	);

	const isChartTab: boolean = $derived(activeTab?.kind === 'chart');

	const targetEntry: MarkEntry | null = $derived(
		activeTab?.kind === 'mark' ? activeTab.entry : null
	);

	const firstEntry: MarkEntry | null = $derived.by(() => {
		const entries = chartContext.config.entries;
		if (entries.size === 0) return null;
		return [...entries.values()][0];
	});

	// ---- Derived: channels ----
	const currentChannels: string[] = $derived.by(() => {
		if (isChartTab) return [...CHART_CHANNELS];
		if (!targetEntry) return [];
		const cols = getAssignableChannels(targetEntry.markType);
		const opts = Object.keys(getOptionChannels(targetEntry.markType));
		const nums = Object.keys(getNumericChannels(targetEntry.markType)).filter(
			(n) => !cols.includes(n)
		); // exclude channels already in column list (e.g. 'r')
		const result = [...cols, ...opts, ...nums];
		if (lodState) result.push('lod');
		return result;
	});

	const expandedOptionDef: OptionChannelDef | null = $derived.by(() => {
		if (!expandedChannel || numericMode) return null;
		if (isChartTab) {
			return CHART_CHANNEL_DEFS[expandedChannel as ChartChannel] ?? null;
		}
		if (!targetEntry) return null;
		return getOptionChannels(targetEntry.markType)[expandedChannel] ?? null;
	});

	/** Active numeric channel definition (mark or chart level). */
	const expandedNumericDef: NumericChannelDef | null = $derived.by(() => {
		if (!expandedChannel) return null;
		// Chart-level single numeric channels
		if (isChartTab) return CHART_NUMERIC_DEFS[expandedChannel] ?? null;
		if (!targetEntry) return null;
		// Direct mark-level numeric channel (pure numeric, not a column channel)
		const numDef = getNumericChannels(targetEntry.markType)[expandedChannel];
		if (numDef && !getAssignableChannels(targetEntry.markType).includes(expandedChannel)) {
			return numDef;
		}
		// "constant" sub-mode of a column channel (e.g. r → constant)
		if (numericMode) {
			return getConstantDef(targetEntry.markType, expandedChannel);
		}
		return null;
	});

	/** Active numeric group (e.g. margins — multiple inputs in one panel). */
	const expandedNumericGroup: NumericGroupDef | null = $derived.by(() => {
		if (!expandedChannel) return null;
		if (isChartTab) return CHART_NUMERIC_GROUPS[expandedChannel] ?? null;
		return null;
	});

	// ---- Derived: LOD for active mark tab ----
	const lodController: LODController | null = $derived.by(() => {
		if (!targetEntry) return null;
		return chartContext.config.getLodController(targetEntry.id) ?? null;
	});

	const lodState: LODState | null = $derived(lodController?.state ?? null);

	/** LOD editable items as a virtual numeric group (reuses group keyboard navigation). */
	interface LodGroupItem {
		label: string;
		key: 'smoothWindow' | 'dotsThreshold' | 'baseRadius' | 'multiplier' | 'smoothMode';
		min: number;
		max: number;
		step: number;
		bigStep?: number;
		getValue: () => number | string;
		/** If set, this item cycles between options instead of numeric stepping. */
		options?: string[];
	}
	const lodGroupItems: LodGroupItem[] = $derived.by(() => {
		if (!lodState) return [];
		if (lodState.mode === 'line') {
			return [
				{ label: 'smooth', key: 'smoothWindow', min: 0, max: 100, step: 1, bigStep: 5, getValue: () => lodState.smoothWindow },
				{ label: 'mode', key: 'smoothMode', min: 0, max: 1, step: 1, getValue: () => lodState.smoothMode, options: ['centered', 'trailing', 'leading'] },
				{ label: 'dots threshold', key: 'dotsThreshold', min: 10, max: 100, step: 1, bigStep: 5, getValue: () => lodState.dotsThreshold },
				{ label: 'dot radius', key: 'baseRadius', min: 0.5, max: 20, step: 0.5, bigStep: 2, getValue: () => lodState.baseRadius }
			];
		}
		return [
			{ label: 'multiplier', key: 'multiplier', min: 0.1, max: 20, step: 0.1, bigStep: 0.5, getValue: () => lodState.binMultiplier }
		];
	});

	/** Update an LOD tunable via ChartConfig (persists for undo/redo + spec export). */
	function setLodTunable(key: 'dotsThreshold' | 'baseRadius' | 'multiplier' | 'smoothWindow' | 'smoothMode', value: number | string): void {
		if (!targetEntry) return;
		const current = targetEntry.lod;
		const cfg = typeof current === 'object' && current ? current : {};
		let updated: Record<string, unknown>;

		if (key === 'dotsThreshold') {
			const dots = typeof cfg.dots === 'object' && cfg.dots ? { ...cfg.dots } : {};
			dots.threshold = value as number;
			updated = { ...cfg, dots };
		} else if (key === 'baseRadius') {
			const dots = typeof cfg.dots === 'object' && cfg.dots ? { ...cfg.dots } : {};
			dots.r = value as number;
			updated = { ...cfg, dots };
		} else if (key === 'smoothWindow' || key === 'smoothMode') {
			const smooth = typeof cfg.smooth === 'object' && cfg.smooth ? { ...cfg.smooth } : {};
			if (key === 'smoothWindow') smooth.window = value as number;
			else smooth.mode = value as 'centered' | 'trailing' | 'leading';
			updated = { ...cfg, smooth };
		} else {
			updated = { ...cfg, multiplier: value as number };
		}

		chartContext.config.setMarkProp(targetEntry.id, 'lod', updated);
	}

	const channelListSize: number = $derived(currentChannels.length + 1);

	// ---- Clamped highlights (derived, not effects) ----
	const channelHighlight = $derived(
		channelHighlightRaw >= channelListSize && channelListSize > 0
			? channelListSize - 1
			: channelHighlightRaw
	);

	// ---- Derived: schema ----
	const schema = $derived.by(() => {
		tableSchemaService.version;
		const entry = isChartTab ? firstEntry : targetEntry;
		return entry ? tableSchemaService.getSchema(entry.table) : null;
	});

	// ---- Derived: value list for expanded channel ----
	const allValues: Array<{
		name: string;
		value?: string | number | null;
		jsType?: string;
		isConstantEntry?: boolean;
	}> = $derived.by(() => {
		if (!expandedChannel || numericMode || expandedNumericDef || expandedNumericGroup) return [];

		if (expandedOptionDef) {
			const def = expandedOptionDef;
			let options = def.options;

			if (def.dynamic === 'scaleType' && schema) {
				const axis = expandedChannel === 'x scale' ? 'x' : 'y';
				const entry = firstEntry;
				if (entry) options = getCompatibleScaleTypes(schema, axis as 'x' | 'y', entry);
			}

			return options.map((o) => ({
				name: o.label,
				value: o.value
			}));
		}

		if (!targetEntry || !schema) return [];
		const cols = getCompatibleColumns(schema, expandedChannel, chartContext.scaleTypes);
		const result: typeof allValues = cols.map((c) => ({
			name: c.name,
			jsType: c.jsType
		}));

		// Add "constant" entry for channels that support both column and constant values
		if (channelSupportsConstant(targetEntry.markType, expandedChannel)) {
			const currentVal = targetEntry[expandedChannel as keyof MarkEntry];
			result.unshift({
				name: typeof currentVal === 'number' ? `constant (${currentVal})` : 'constant',
				isConstantEntry: true
			});
		}

		return result;
	});

	const filteredValues = $derived.by(() => {
		if (!filterText) return allValues;
		const lower = filterText.toLowerCase();
		return allValues.filter((v) => v.name.toLowerCase().includes(lower));
	});

	const canClear: boolean = $derived(originalColumnName != null);
	const showClear: boolean = $derived(canClear && !filterText && !expandedOptionDef);
	const valueListSize: number = $derived(filteredValues.length + (showClear ? 1 : 0));

	const valueHighlight = $derived(
		valueHighlightRaw >= valueListSize && valueListSize > 0 ? valueListSize - 1 : valueHighlightRaw
	);

	// ---- Current value display for channel rows ----
	function currentValue(channel: string): string {
		// LOD summary
		if (channel === 'lod' && lodState) {
			if (lodState.mode === 'line') {
				const suffix = lodState.smoothActive
					? ` ${lodState.smoothMode === 'trailing' ? '←' : lodState.smoothMode === 'leading' ? '→' : '±'}${lodState.smoothWindow}`
					: '';
				return `${lodState.density.toFixed(1)} pt/px${suffix}`;
			}
			return `${Math.round(lodState.numVisibleBins)} bins`;
		}

		// Chart-level numeric group (margins)
		if (isChartTab && CHART_NUMERIC_GROUPS[channel]) {
			const cp = chartContext.config.chartProps;
			if (!cp) return '\u2014';
			const group = CHART_NUMERIC_GROUPS[channel];
			return group.items.map((item) => cp[item.def.prop as keyof typeof cp] ?? '\u2014').join(' ');
		}
		// Chart-level single numeric channels
		if (isChartTab && CHART_NUMERIC_DEFS[channel]) {
			const cp = chartContext.config.chartProps;
			if (!cp) return '\u2014';
			const val = cp[CHART_NUMERIC_DEFS[channel].prop as keyof typeof cp];
			return val != null ? String(val) : '\u2014';
		}

		const optDef = isChartTab
			? CHART_CHANNEL_DEFS[channel as ChartChannel]
			: targetEntry
				? getOptionChannels(targetEntry.markType)[channel]
				: null;

		if (optDef) {
			const entry = isChartTab ? firstEntry : targetEntry;
			if (!entry) return '\u2014';
			const val = entry[optDef.prop as keyof MarkEntry];
			if (val == null) return 'auto';
			return String(val);
		}

		// Mark-level numeric channels
		if (targetEntry) {
			const numDef = getNumericChannels(targetEntry.markType)[channel];
			if (numDef && !getAssignableChannels(targetEntry.markType).includes(channel)) {
				const val = targetEntry[numDef.prop as keyof MarkEntry];
				return val != null ? String(val) : 'auto';
			}
		}

		if (!targetEntry) return '';
		const val = targetEntry[channel as keyof MarkEntry];
		if (val == null) return '\u2014';
		if (typeof val === 'string') return val;
		if (typeof val === 'number') return String(val);
		return '(expr)';
	}

	// ---- Tab labels (disambiguate duplicate mark types) ----
	const tabLabels: string[] = $derived.by(() => {
		const typeTotal = new Map<string, number>();
		for (const tab of tabList) {
			if (tab.kind === 'mark') {
				typeTotal.set(tab.entry.markType, (typeTotal.get(tab.entry.markType) ?? 0) + 1);
			}
		}
		const seen = new Map<string, number>();
		return tabList.map((tab) => {
			if (tab.kind === 'chart') return 'Chart';
			const t = tab.entry.markType;
			const n = (seen.get(t) ?? 0) + 1;
			seen.set(t, n);
			return (typeTotal.get(t) ?? 0) > 1 ? `${t} ${n}` : t;
		});
	});

	// ---- Focus helper (replaces focus management effect) ----
	async function updateFocus() {
		await tick();
		if (focusZone === 'values' && expandedChannel === 'lod' && groupEditing && groupInputs[groupFocusIndex]) {
			const el = groupInputs[groupFocusIndex];
			el.focus();
			if ('select' in el) el.select();
		} else if (focusZone === 'values' && expandedNumericGroup && groupEditing && groupInputs[groupFocusIndex]) {
			const el = groupInputs[groupFocusIndex];
			el.focus();
			if ('select' in el) el.select();
		} else if (focusZone === 'values' && expandedNumericDef && scrubberInput) {
			scrubberInput.focus();
			scrubberInput.select();
		} else if (focusZone === 'values' && valueHighlightRaw === -1 && filterInput) {
			filterInput.focus();
		} else if (panelEl) {
			panelEl.focus();
		}
	}

	// ---- Actions ----
	function close() {
		if (chartContext.config.previewing) {
			chartContext.config.cancelPreview();
		}
		if (checkpointed) {
			chartContext.config.undo();
			checkpointed = false;
		}
		onclose();
	}

	function resetAll() {
		if (isChartTab) {
			chartContext.config.checkpoint('palette reset chart');
			for (const entry of chartContext.config.entries.values()) {
				for (const def of Object.values(CHART_CHANNEL_DEFS)) {
					chartContext.config.setMarkProp(entry.id, def.prop, null);
				}
			}
			chartContext.config.revertChart();
		} else if (targetEntry) {
			chartContext.config.checkpoint('palette reset all');
			chartContext.config.revertMark(targetEntry.id);
		}
		onclose();
	}

	function expandChannel(channel: string) {
		if (expandedChannel != null) {
			collapseCommit();
		}
		expandedChannel = channel;

		// LOD panel — edits apply immediately, no checkpoint/preview needed
		// Uses group navigation (same as margins)
		if (channel === 'lod') {
			groupFocusIndex = 0;
			groupEditing = false;
			focusZone = 'values';
			tick().then(() => panelEl?.focus());
			return;
		}

		// Numeric group (e.g. margins) — checkpoint and show group panel
		if (isChartTab && CHART_NUMERIC_GROUPS[channel]) {
			chartContext.config.checkpoint('palette');
			checkpointed = true;
			groupFocusIndex = 0;
			groupEditing = false;
			focusZone = 'values';
			// Keep focus on panel for keyboard nav (not on input)
			tick().then(() => panelEl?.focus());
			return;
		}

		// Check if this is a direct numeric channel (not a column channel)
		const numDef = isChartTab
			? (CHART_NUMERIC_DEFS[channel] ?? null)
			: targetEntry
				? getNumericChannels(targetEntry.markType)[channel] &&
					!getAssignableChannels(targetEntry.markType).includes(channel)
					? getNumericChannels(targetEntry.markType)[channel]
					: null
				: null;

		if (numDef) {
			// Enter numeric scrubber mode directly
			chartContext.config.checkpoint('palette');
			checkpointed = true;
			numericMode = true;
			const cp = chartContext.config.chartProps;
			const currentVal = isChartTab
				? cp
					? (cp as Record<string, unknown>)[numDef.prop]
					: undefined
				: targetEntry?.[numDef.prop as keyof MarkEntry];
			scrubberValue = typeof currentVal === 'number' ? currentVal : numDef.min;
			scrubberText = String(scrubberValue);
			focusZone = 'values';
			updateFocus();
			return;
		}

		const entry = isChartTab ? firstEntry : targetEntry;
		if (entry) {
			const optDef = isChartTab
				? CHART_CHANNEL_DEFS[channel as ChartChannel]
				: getOptionChannels(entry.markType)[channel];
			const prop = optDef ? optDef.prop : channel;
			const val = entry[prop as keyof MarkEntry];
			originalColumnName = typeof val === 'string' ? val : null;
		}

		chartContext.config.checkpoint('palette');
		checkpointed = true;
		filterText = '';
		filterRevealed = false;
		valueHighlightRaw = 0;
		focusZone = 'values';
		updateFocus();
	}

	/** Clean up expanded state without undoing — values stick. */
	function collapseCommit() {
		if (chartContext.config.previewing) {
			chartContext.config.commitPreview();
		}
		checkpointed = false;
		expandedChannel = null;
		originalColumnName = null;
		filterText = '';
		filterRevealed = false;
		valueHighlightRaw = 0;
		numericMode = false;
		scrubDragState = null;
		groupEditing = false;
	}

	/** Revert previewed changes and undo checkpoint. */
	function collapseRevert() {
		if (chartContext.config.previewing) {
			chartContext.config.cancelPreview();
		}
		if (checkpointed) {
			chartContext.config.undo();
			checkpointed = false;
		}
		checkpointed = false;
		expandedChannel = null;
		originalColumnName = null;
		filterText = '';
		filterRevealed = false;
		valueHighlightRaw = 0;
		numericMode = false;
		scrubDragState = null;
		groupEditing = false;
	}

	function collapseToChannels(revert = false) {
		if (revert) {
			collapseRevert();
		} else {
			collapseCommit();
		}
		focusZone = 'channels';
		updateFocus();
	}

	function resolveExpandedProp(): string | null {
		if (!expandedChannel) return null;
		if (expandedNumericDef) return expandedNumericDef.prop;
		if (expandedOptionDef) return expandedOptionDef.prop;
		return expandedChannel;
	}

	// ---- Numeric helpers ----

	function getGroupValue(prop: string, fallback: number): number {
		const cp = chartContext.config.chartProps;
		if (!cp) return fallback;
		const v = (cp as Record<string, unknown>)[prop];
		return typeof v === 'number' ? v : fallback;
	}

	function getActiveNumericDef(): NumericChannelDef | null {
		return expandedNumericDef;
	}

	function clampScrubber(val: number, def: NumericChannelDef): number {
		const decimals = def.decimals ?? 2;
		const clamped = Math.max(def.min, Math.min(def.max, val));
		return Number(clamped.toFixed(decimals));
	}

	function applyScrubberValue(val: number) {
		const def = getActiveNumericDef();
		if (!def) return;
		const clamped = clampScrubber(val, def);
		scrubberValue = clamped;
		scrubberText = String(clamped);

		// Remember constant value for channels that toggle between column/constant
		if (expandedChannel && numericMode) {
			lastConstantValues.set(expandedChannel, clamped);
		}

		const prop = def.prop;
		if (isChartTab) {
			chartContext.config.setChartProp(prop, clamped);
		} else if (targetEntry) {
			chartContext.config.setMarkProp(targetEntry.id, prop, clamped);
		}
	}

	function commitScrubber() {
		checkpointed = false;
		expandedChannel = null;
		numericMode = false;
		scrubDragState = null;
		focusZone = 'channels';
		updateFocus();
	}

	function enterConstantMode() {
		if (!expandedChannel || !targetEntry) return;
		const def = getConstantDef(targetEntry.markType, expandedChannel);
		if (!def) return;
		numericMode = true;
		scrubberValue = resolveConstantValue(expandedChannel, def);
		scrubberText = String(scrubberValue);
		updateFocus();
	}

	function previewValue(valueName: string | number | null) {
		if (chartContext.config.previewing) {
			chartContext.config.cancelPreview();
		}

		const prop = resolveExpandedProp();
		if (!prop) return;

		if (isChartTab) {
			for (const entry of chartContext.config.entries.values()) {
				chartContext.config.beginPreview(entry.id, prop, valueName);
			}
		} else if (targetEntry) {
			chartContext.config.beginPreview(targetEntry.id, prop, valueName);
		}
	}

	function commitValue(valueName: string | number | null) {
		const prop = resolveExpandedProp();

		if (chartContext.config.previewing) {
			chartContext.config.commitPreview();
		} else if (prop && isChartTab) {
			for (const entry of chartContext.config.entries.values()) {
				chartContext.config.setMarkProp(entry.id, prop, valueName);
			}
		} else if (prop && targetEntry) {
			chartContext.config.setMarkProp(targetEntry.id, prop, valueName);
		}

		checkpointed = false;
		expandedChannel = null;
		originalColumnName = null;
		filterText = '';
		filterRevealed = false;
		valueHighlightRaw = 0;
		numericMode = false;
		scrubDragState = null;
		focusZone = 'channels';
		updateFocus();
	}

	const tabChannelMemory = new Map<number, number>();

	function switchTab(index: number) {
		if (expandedChannel != null) {
			collapseCommit();
		}
		tabChannelMemory.set(activeTabIndex, channelHighlightRaw);
		activeTabIndex = index;
		channelHighlightRaw = tabChannelMemory.get(index) ?? 0;
	}

	// ---- Resolve value from highlight index ----
	function getValueAtIndex(
		idx: number
	): { name: string; isNull: boolean; isConstantEntry?: boolean } | null {
		if (showClear && idx === filteredValues.length) {
			return { name: 'clear', isNull: true };
		}
		const v = filteredValues[idx];
		if (!v) return null;
		if (v.isConstantEntry) {
			return { name: v.name, isNull: false, isConstantEntry: true };
		}
		if (expandedOptionDef && (v as { value?: string | number | null }).value === null) {
			return { name: v.name, isNull: true };
		}
		return { name: v.name, isNull: false };
	}

	// ---- Keyboard ----
	function handleKeydown(event: KeyboardEvent) {
		keyboardNav = true;

		event.stopPropagation();

		// Cmd+E: copy spec to clipboard
		if ((event.metaKey || event.ctrlKey) && event.key === 'e') {
			event.preventDefault();
			copySpec();
			return;
		}

		// [/] cycle tabs
		if (event.key === '[' || event.key === ']') {
			event.preventDefault();
			const delta = event.key === ']' ? 1 : -1;
			const newIdx = (activeTabIndex + delta + tabList.length) % tabList.length;
			switchTab(newIdx);
			focusZone = 'channels';
			updateFocus();
			return;
		}

		// Cmd+Up jumps to tab bar, Cmd+Down jumps back to channels
		if ((event.metaKey || event.ctrlKey) && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
			event.preventDefault();
			if (event.key === 'ArrowUp') {
				if (focusZone === 'values') collapseCommit();
				focusZone = 'tabs';
			} else {
				focusZone = 'channels';
			}
			updateFocus();
			return;
		}

		if ((event.metaKey || event.ctrlKey) && event.key === 'z') {
			event.preventDefault();
			if (focusZone === 'channels' && chartContext.config.canUndo) {
				chartContext.config.undo();
			}
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			if (focusZone === 'values') {
				collapseToChannels(true);
			} else if (focusZone === 'tabs') {
				focusZone = 'channels';
				updateFocus();
			} else {
				close();
			}
			return;
		}

		if (focusZone === 'tabs') {
			handleTabKeys(event);
		} else if (focusZone === 'channels') {
			handleChannelKeys(event);
		} else if (focusZone === 'values') {
			handleValueKeys(event);
		}
	}

	function handleTabKeys(event: KeyboardEvent) {
		const key = event.key;
		if (key === 'ArrowLeft' || key === 'h') {
			event.preventDefault();
			const newIdx = (activeTabIndex - 1 + tabList.length) % tabList.length;
			switchTab(newIdx);
		} else if (key === 'ArrowRight' || key === 'l') {
			event.preventDefault();
			const newIdx = (activeTabIndex + 1) % tabList.length;
			switchTab(newIdx);
		} else if (key === 'ArrowDown' || key === 'j' || key === 'Enter') {
			event.preventDefault();
			focusZone = 'channels';
			updateFocus();
		}
	}

	function handleChannelKeys(event: KeyboardEvent) {
		const key = event.key;
		if (key === 'ArrowLeft' || key === 'h') {
			event.preventDefault();
			close();
			return;
		}
		if (key === 'ArrowUp' || key === 'k') {
			event.preventDefault();
			if (channelHighlight === 0) {
				focusZone = 'tabs';
			} else {
				channelHighlightRaw = channelHighlight - 1;
			}
		} else if (key === 'ArrowDown' || key === 'j') {
			event.preventDefault();
			if (channelListSize > 0) {
				channelHighlightRaw = (channelHighlight + 1) % channelListSize;
			}
		} else if (key === 'ArrowRight' || key === 'l' || key === 'Enter') {
			event.preventDefault();
			if (channelHighlight === currentChannels.length) {
				resetAll();
			} else if (currentChannels[channelHighlight]) {
				expandChannel(currentChannels[channelHighlight]);
			}
		}
	}

	function scrollHighlightIntoView() {
		if (!valueListEl) return;
		const el = valueListEl.querySelector('.val-row.highlighted') as HTMLElement | null;
		if (el) el.scrollIntoView({ block: 'nearest' });
	}

	function resolveConstantValue(channel: string, def: NumericChannelDef): number {
		if (!targetEntry) return def.min;
		const currentVal = targetEntry[def.prop as keyof MarkEntry];
		if (typeof currentVal === 'number') return currentVal;
		return lastConstantValues.get(channel) ?? def.min;
	}

	function previewConstantValue() {
		if (!expandedChannel || !targetEntry) return;
		const def = getConstantDef(targetEntry.markType, expandedChannel);
		if (!def) return;
		previewValue(resolveConstantValue(expandedChannel, def));
	}

	function previewAtHighlight() {
		const item = getValueAtIndex(valueHighlight);
		if (!item) return;
		if (item.isConstantEntry) {
			previewConstantValue();
		} else if (item.isNull && !expandedOptionDef) {
			if (chartContext.config.previewing) {
				chartContext.config.cancelPreview();
			}
		} else {
			previewValue(item.isNull ? null : item.name);
		}
	}

	function handleValueKeys(event: KeyboardEvent) {
		// Numeric group mode — up/down navigates items, left/escape exits
		// LOD panel reuses the same group navigation pattern
		if (expandedNumericGroup) {
			handleGroupKeys(event);
			return;
		}
		if (expandedChannel === 'lod' && lodGroupItems.length > 0) {
			handleLodGroupKeys(event);
			return;
		}
		// Numeric scrubber mode — arrow keys step value
		if (expandedNumericDef) {
			handleScrubberKeys(event);
			return;
		}

		const key = event.key;
		if (key === 'ArrowUp') {
			event.preventDefault();
			if (valueHighlight === -1) {
				// Already at filter, stay
			} else if (valueHighlight === 0) {
				filterRevealed = true;
				valueHighlightRaw = -1;
				updateFocus();
			} else {
				valueHighlightRaw = valueHighlight - 1;
				previewAtHighlight();
				scrollHighlightIntoView();
			}
		} else if (key === 'ArrowDown') {
			event.preventDefault();
			if (valueHighlight === -1) {
				valueHighlightRaw = 0;
				updateFocus();
				previewAtHighlight();
				scrollHighlightIntoView();
			} else if (valueListSize > 0) {
				valueHighlightRaw = (valueHighlight + 1) % valueListSize;
				previewAtHighlight();
				scrollHighlightIntoView();
			}
		} else if (key === 'Escape') {
			event.preventDefault();
			collapseToChannels(true);
		} else if (key === 'ArrowLeft') {
			event.preventDefault();
			collapseToChannels();
		} else if ((key === 'Enter' && !event.repeat) || key === 'ArrowRight') {
			event.preventDefault();
			if (valueHighlight >= 0) {
				const item = getValueAtIndex(valueHighlight);
				if (item) {
					if ((item as { isConstantEntry?: boolean }).isConstantEntry) {
						enterConstantMode();
					} else {
						commitValue(item.isNull ? null : item.name);
					}
				}
			}
		} else if (valueHighlight !== -1 && key.length === 1 && !event.metaKey && !event.ctrlKey) {
			event.preventDefault();
			filterRevealed = true;
			filterText += key;
			valueHighlightRaw = -1;
			updateFocus();
		}
	}

	function handleScrubberKeys(event: KeyboardEvent) {
		const def = expandedNumericDef;
		if (!def) return;
		const key = event.key;
		const step = event.shiftKey ? (def.bigStep ?? def.step * 10) : def.step;

		if (key === 'ArrowUp') {
			event.preventDefault();
			applyScrubberValue(scrubberValue + step);
		} else if (key === 'ArrowDown') {
			event.preventDefault();
			applyScrubberValue(scrubberValue - step);
		} else if (key === 'Escape') {
			event.preventDefault();
			collapseToChannels(true);
		} else if (key === 'ArrowLeft') {
			event.preventDefault();
			commitScrubber();
		} else if (key === 'Enter' && !event.repeat) {
			event.preventDefault();
			commitScrubber();
		}
	}

	function handleLodGroupKeys(event: KeyboardEvent) {
		const items = lodGroupItems;
		if (!items.length) return;
		const key = event.key;
		const count = items.length;

		if (groupEditing) {
			const item = items[groupFocusIndex];
			if (key === 'Escape' || key === 'ArrowLeft') {
				event.preventDefault();
				groupEditing = false;
				panelEl?.focus();
			} else if (key === 'Enter' && !event.repeat) {
				event.preventDefault();
				groupEditing = false;
				panelEl?.focus();
			} else if (key === 'Tab') {
				event.preventDefault();
				groupFocusIndex = event.shiftKey
					? (groupFocusIndex - 1 + count) % count
					: (groupFocusIndex + 1) % count;
				updateFocus();
			} else if ((key === 'ArrowUp' || key === 'ArrowDown' || key === 'j' || key === 'k') && item) {
				event.preventDefault();
				if (item.options) {
					// Cycle through options
					const curIdx = item.options.indexOf(String(item.getValue()));
					const dir = key === 'ArrowUp' || key === 'k' ? -1 : 1;
					const nextIdx = (curIdx + dir + item.options.length) % item.options.length;
					setLodTunable(item.key, item.options[nextIdx] as any);
					const el = groupInputs[groupFocusIndex];
					if (el) el.textContent = item.options[nextIdx];
				} else {
					const step = event.shiftKey ? (item.bigStep ?? item.step * 10) : item.step;
					const delta = key === 'ArrowUp' || key === 'k' ? step : -step;
					const cur = item.getValue() as number;
					const clamped = Math.max(item.min, Math.min(item.max, cur + delta));
					setLodTunable(item.key, clamped);
					const el = groupInputs[groupFocusIndex] as HTMLInputElement;
					if (el) el.value = String(clamped);
				}
			}
			return;
		}

		// Navigation mode
		if (key === 'ArrowDown') {
			event.preventDefault();
			groupFocusIndex = (groupFocusIndex + 1) % count;
		} else if (key === 'ArrowUp') {
			event.preventDefault();
			groupFocusIndex = (groupFocusIndex - 1 + count) % count;
		} else if (key === 'ArrowRight' || key === 'Enter') {
			event.preventDefault();
			groupEditing = true;
			updateFocus();
		} else if (key === 'Escape' || key === 'ArrowLeft') {
			event.preventDefault();
			collapseToChannels();
		}
	}

	function handleGroupKeys(event: KeyboardEvent) {
		const group = expandedNumericGroup;
		if (!group) return;
		const key = event.key;
		const count = group.items.length;

		if (groupEditing) {
			const item = group.items[groupFocusIndex];
			const def = item?.def;
			if (key === 'Escape' || key === 'ArrowLeft') {
				event.preventDefault();
				groupEditing = false;
				panelEl?.focus();
			} else if (key === 'Enter' && !event.repeat) {
				event.preventDefault();
				groupEditing = false;
				panelEl?.focus();
			} else if (key === 'Tab') {
				// Tab moves to next/prev item, staying in edit mode
				event.preventDefault();
				groupFocusIndex = event.shiftKey
					? (groupFocusIndex - 1 + count) % count
					: (groupFocusIndex + 1) % count;
				updateFocus();
			} else if ((key === 'ArrowUp' || key === 'ArrowDown' || key === 'j' || key === 'k') && def) {
				event.preventDefault();
				const step = event.shiftKey ? (def.bigStep ?? def.step * 10) : def.step;
				const delta = key === 'ArrowUp' || key === 'k' ? step : -step;
				const cur = getGroupValue(def.prop, def.min);
				const clamped = clampScrubber(cur + delta, def);
				chartContext.config.setChartProp(def.prop, clamped);
				const el = groupInputs[groupFocusIndex] as HTMLInputElement;
				if (el) el.value = String(clamped);
			}
			return;
		}

		// Navigation mode
		if (key === 'ArrowDown') {
			event.preventDefault();
			groupFocusIndex = (groupFocusIndex + 1) % count;
		} else if (key === 'ArrowUp') {
			event.preventDefault();
			groupFocusIndex = (groupFocusIndex - 1 + count) % count;
		} else if (key === 'ArrowRight' || key === 'Enter') {
			event.preventDefault();
			groupEditing = true;
			updateFocus();
		} else if (key === 'Escape') {
			event.preventDefault();
			collapseToChannels(true);
		} else if (key === 'ArrowLeft') {
			event.preventDefault();
			collapseToChannels();
		}
	}

	// ---- Outside click ----
	async function copySpec() {
		const json = exportSpecJSON(chartContext.config);
		await navigator.clipboard.writeText(json);
		copyFeedback = true;
		setTimeout(() => (copyFeedback = false), 1500);
	}

	function handleWindowPointerDown(event: PointerEvent) {
		if (!panelEl) return;
		// Use composedPath() to correctly detect clicks inside the palette
		// even when the widget is inside a shadow DOM (e.g. marimo/anywidget).
		const path = event.composedPath();
		if (!path.includes(panelEl)) {
			close();
		}
	}

	// ---- Cleanup on unmount (palette close) ----
	onDestroy(() => {
		if (chartContext.config.previewing) {
			chartContext.config.cancelPreview();
		}
		if (checkpointed) {
			chartContext.config.undo();
		}
	});
</script>

<svelte:window onpointerdown={handleWindowPointerDown} />

{#if targetEntry || isChartTab}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class={['palette-panel', { 'keyboard-nav': keyboardNav }]}
		bind:this={panelEl}
		tabindex="-1"
		onkeydown={handleKeydown}
		onwheel={(e) => {
			const t = e.target as Node;
			if (!valueListEl?.contains(t) && !channelListEl?.contains(t)) e.preventDefault();
		}}
		onpointermove={() => {
			keyboardNav = false;
		}}
	>
		<!-- Tab bar -->
		<div class="tab-bar">
			{#each tabList as tab, i (tab.kind === 'chart' ? 'chart' : tab.entry.id)}
				{@const isActive = i === Math.min(activeTabIndex, tabList.length - 1)}
				<button
					class={['tab', { active: isActive, focused: focusZone === 'tabs' && isActive }]}
					onclick={() => {
						switchTab(i);
						focusZone = 'channels';
					}}
				>
					{tabLabels[i]}
				</button>
			{/each}
		</div>

		<!-- Body -->
		<div class={['palette-body', { split: expandedChannel != null }]}>
			<!-- Channel list -->
			<div class="channel-list" bind:this={channelListEl}>
				{#each currentChannels as ch, i (ch)}
					<button
						class={[
							'ch-row',
							{
								highlighted: keyboardNav && focusZone === 'channels' && i === channelHighlight,
								expanded: ch === expandedChannel
							}
						]}
						onclick={() => {
							channelHighlightRaw = i;
							expandChannel(ch);
						}}
						onpointerenter={() => {
							if (!keyboardNav && focusZone === 'channels') channelHighlightRaw = i;
						}}
					>
						<span class="ch-name">{ch}</span>
						{#if expandedChannel == null}
							<span class="ch-value">{currentValue(ch)}</span>
						{/if}
					</button>
				{/each}
				<button
					class={[
						'ch-row',
						'reset-row',
						{ highlighted: keyboardNav && focusZone === 'channels' && channelHighlight === currentChannels.length }
					]}
					onclick={resetAll}
					onpointerenter={() => {
						if (!keyboardNav && focusZone === 'channels')
							channelHighlightRaw = currentChannels.length;
					}}
				>
					<span class="ch-name reset-label">reset all</span>
				</button>
				<button
					class="ch-row reset-row"
					onclick={copySpec}
				>
					<span class="ch-name reset-label">{copyFeedback ? 'copied!' : 'copy spec'}</span>
					<span class="ch-value" style:font-size="9px">⌘E</span>
				</button>
			</div>

			<!-- Value panel (only when expanded) -->
			{#if expandedChannel != null}
				<div class="value-panel">
					{#if expandedNumericGroup}
						<div class="group-panel">
							{#each expandedNumericGroup.items as item, gi (item.label)}
								<div class="group-row" class:highlighted={gi === groupFocusIndex}>
									<span class="group-label">{item.label}</span>
									<input
										bind:this={groupInputs[gi]}
										type="number"
										class="scrubber-input"
										value={getGroupValue(item.def.prop, item.def.min)}
										onfocus={() => {
											groupFocusIndex = gi;
											groupEditing = true;
										}}
										min={item.def.min}
										max={item.def.max}
										step={item.def.step}
										oninput={(e) => {
											const v = parseFloat((e.target as HTMLInputElement).value);
											if (!isNaN(v)) {
												const clamped = clampScrubber(v, item.def);
												chartContext.config.setChartProp(item.def.prop, clamped);
											}
										}}
										onwheel={(e) => {
											e.preventDefault();
											const cur = getGroupValue(item.def.prop, item.def.min);
											const step = e.shiftKey
												? (item.def.bigStep ?? item.def.step * 10)
												: item.def.step;
											const delta = e.deltaY < 0 ? step : -step;
											const clamped = clampScrubber(cur + delta, item.def);
											chartContext.config.setChartProp(item.def.prop, clamped);
											(e.target as HTMLInputElement).value = String(clamped);
										}}
									/>
								</div>
							{/each}
						</div>
					{:else if expandedChannel === 'lod' && lodState && lodController}
						<div class="group-panel">
							<!-- Diagnostic readouts -->
							{#if lodState.mode === 'line'}
								<div class="group-row">
									<span class="group-label">visible</span>
									<span class="lod-readout">{lodState.visibleCount.toLocaleString()}</span>
								</div>
								<div class="group-row">
									<span class="group-label">density</span>
									<span class="lod-readout">{lodState.density.toFixed(1)} pt/px</span>
								</div>
								<div class="group-row">
									<span class="group-label">M4</span>
									<span class="lod-readout {lodState.shouldDecimate ? 'lod-active' : ''}">{lodState.shouldDecimate ? 'on' : 'off'}</span>
								</div>
								{#if lodState.smoothActive}
									<div class="group-row">
										<span class="group-label"></span>
										<span class="lod-readout lod-active">{lodState.smoothMode === 'trailing' ? `←${lodState.smoothWindow}` : lodState.smoothMode === 'leading' ? `${lodState.smoothWindow}→` : `±${lodState.smoothWindow}`} avg</span>
									</div>
								{/if}
							{:else}
								<div class="group-row">
									<span class="group-label">bins</span>
									<span class="lod-readout">{Math.round(lodState.numVisibleBins)}</span>
								</div>
								<div class="group-row">
									<span class="group-label">bin width</span>
									<span class="lod-readout">{lodState.binWidthPx.toFixed(1)} px</span>
								</div>
								<div class="group-row">
									<span class="group-label">step</span>
									<span class="lod-readout">{lodState.binStep.toPrecision(3)}</span>
								</div>
							{/if}
							<!-- Editable tunables (group navigation) -->
							{#each lodGroupItems as item, gi (item.key)}
								<div class="group-row" class:highlighted={gi === groupFocusIndex}>
									<span class="group-label">{item.label}</span>
									{#if item.options}
										<span
											bind:this={groupInputs[gi]}
											class="lod-readout lod-option"
											tabindex="0"
											role="button"
											onfocus={() => { groupFocusIndex = gi; groupEditing = true; }}
											onclick={() => {
												const curIdx = item.options!.indexOf(String(item.getValue()));
												const next = item.options![(curIdx + 1) % item.options!.length];
												setLodTunable(item.key, next as any);
											}}
										>{item.getValue()}</span>
									{:else}
										<input
											bind:this={groupInputs[gi]}
											type="number"
											class="scrubber-input"
											value={item.getValue()}
											min={item.min}
											max={item.max}
											step={item.step}
											onfocus={() => {
												groupFocusIndex = gi;
												groupEditing = true;
											}}
											oninput={(e) => {
												const v = parseFloat((e.target as HTMLInputElement).value);
												if (!isNaN(v)) {
													const clamped = Math.max(item.min, Math.min(item.max, v));
													setLodTunable(item.key, clamped);
												}
											}}
											onwheel={(e) => {
												e.preventDefault();
												const step = e.shiftKey ? (item.bigStep ?? item.step * 10) : item.step;
												const delta = e.deltaY < 0 ? step : -step;
												const cur = item.getValue() as number;
												const clamped = Math.max(item.min, Math.min(item.max, cur + delta));
												setLodTunable(item.key, clamped);
												(e.target as HTMLInputElement).value = String(clamped);
											}}
										/>
									{/if}
								</div>
							{/each}
						</div>
					{:else if expandedNumericDef}
						{@const def = expandedNumericDef}
						<div class="scrubber-panel">
							<input
								bind:this={scrubberInput}
								type="number"
								class="scrubber-input"
								bind:value={scrubberText}
								min={def.min}
								max={def.max}
								step={def.step}
								oninput={() => {
									const v = parseFloat(scrubberText);
									if (!isNaN(v)) applyScrubberValue(v);
								}}
								onkeydown={(e) => {
									if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
										e.preventDefault();
										e.stopPropagation();
										const step = e.shiftKey ? (def.bigStep ?? def.step * 10) : def.step;
										const delta = e.key === 'ArrowUp' ? step : -step;
										applyScrubberValue(scrubberValue + delta);
									}
								}}
								onwheel={(e) => {
									e.preventDefault();
									const step = e.shiftKey ? (def.bigStep ?? def.step * 10) : def.step;
									const delta = e.deltaY < 0 ? step : -step;
									applyScrubberValue(scrubberValue + delta);
								}}
								onpointerdown={(e) => {
									if (e.button !== 0) return;
									scrubDragState = { startY: e.clientY, startValue: scrubberValue };
									(e.target as Element).setPointerCapture(e.pointerId);
								}}
								onpointermove={(e) => {
									if (!scrubDragState) return;
									const dy = scrubDragState.startY - e.clientY;
									const step = e.shiftKey ? (def.bigStep ?? def.step * 10) : def.step;
									const steps = Math.round(dy / 4);
									applyScrubberValue(scrubDragState.startValue + steps * step);
								}}
								onpointerup={(e) => {
									if (scrubDragState) {
										(e.target as Element).releasePointerCapture(e.pointerId);
										scrubDragState = null;
									}
								}}
							/>
							<span class="scrubber-range">{def.min} – {def.max}</span>
						</div>
					{:else}
						{#if filterRevealed}
							<div class="filter-row">
								<input
									bind:this={filterInput}
									bind:value={filterText}
									placeholder={expandedOptionDef ? 'Filter...' : 'Filter columns...'}
									class="filter-input"
								/>
							</div>
						{/if}
						<div class="value-list" bind:this={valueListEl}>
							{#each filteredValues as val, i (val.name)}
								{@const isAutoNull =
									expandedOptionDef && (val as { value?: string | number | null }).value === null}
								{@const isConstant = val.isConstantEntry}
								<button
									class={[
										'val-row',
										{
											highlighted: keyboardNav && focusZone === 'values' && i === valueHighlight,
											'constant-entry': isConstant
										}
									]}
									onpointerenter={() => {
										if (keyboardNav) return;
										valueHighlightRaw = i;
										if (isConstant) {
											previewConstantValue();
										} else if (isAutoNull) {
											previewValue(null);
										} else {
											previewValue(val.name);
										}
									}}
									onclick={() => {
										if (isConstant) {
											enterConstantMode();
										} else {
											commitValue(isAutoNull ? null : val.name);
										}
									}}
								>
									<span class="val-name">{val.name}</span>
									<span class="val-right">
										{#if val.jsType}
											<span class="val-type">{val.jsType}</span>
										{/if}
										{#if isConstant}
											<span class="val-type">→</span>
										{/if}
									</span>
								</button>
							{/each}
							{#if showClear}
								<button
									class={[
										'val-row',
										'clear-row',
										{
											highlighted:
												keyboardNav && focusZone === 'values' && valueHighlight === filteredValues.length
										}
									]}
									onpointerenter={() => {
										if (!keyboardNav) valueHighlightRaw = filteredValues.length;
									}}
									onclick={() => commitValue(null)}
								>
									<span class="val-name clear-label">clear</span>
								</button>
							{/if}
							{#if filteredValues.length === 0}
								<div class="palette-empty">No matches</div>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.palette-panel {
		position: absolute;
		top: 12px;
		right: 8px;
		z-index: 1100;
		width: 260px;
		max-height: calc(100% - 20px);
		display: flex;
		flex-direction: column;
		background: var(--diveplot-palette-bg, rgba(0, 0, 0, 0.92));
		color: var(--diveplot-palette-text, #ffffff);
		border: 1px solid var(--diveplot-palette-border, rgba(255, 255, 255, 0.1));
		border-radius: 8px;
		box-shadow:
			0 8px 32px rgba(0, 0, 0, 0.4),
			0 2px 8px rgba(0, 0, 0, 0.2);
		font-family: var(--diveplot-font, system-ui, sans-serif);
		overflow: hidden;
		outline: none;
	}

	/* ---- Tab bar ---- */
	.tab-bar {
		display: flex;
		gap: 0;
		border-bottom: 1px solid var(--diveplot-palette-border, rgba(255, 255, 255, 0.1));
		padding: 0 8px;
	}

	.tab {
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		padding: 5px 8px 4px;
		font-size: 10px;
		font-weight: 600;
		color: var(--diveplot-palette-text-secondary, rgba(255, 255, 255, 0.5));
		cursor: pointer;
		text-transform: lowercase;
		letter-spacing: 0.02em;
		transition: color 0.1s;
	}

	.tab:hover {
		color: var(--diveplot-palette-text, #ffffff);
		opacity: 0.7;
	}

	.tab.active {
		color: var(--diveplot-palette-text, #ffffff);
		opacity: 0.85;
		border-bottom-color: currentColor;
	}

	.tab.focused {
		outline: 1px solid var(--diveplot-palette-border, rgba(255, 255, 255, 0.1));
		outline-offset: -2px;
		border-radius: 3px 3px 0 0;
	}

	/* ---- Body ---- */
	.palette-body {
		display: flex;
		flex: 1;
		overflow: hidden;
	}

	/* ---- Channel list ---- */
	.channel-list {
		display: flex;
		flex-direction: column;
		overflow-y: auto;
		padding: 2px;
		flex: 1;
	}

	.palette-body.split .channel-list {
		width: 90px;
		flex: none;
		border-right: 1px solid var(--diveplot-palette-border, rgba(255, 255, 255, 0.1));
	}

	.ch-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 3px 6px;
		background: none;
		border: none;
		border-radius: 3px;
		cursor: pointer;
		font-size: 11px;
		color: inherit;
		opacity: 0.85;
		text-align: left;
		gap: 4px;
	}

	.palette-panel:not(.keyboard-nav) .ch-row:hover,
	.ch-row.highlighted {
		background: var(--diveplot-palette-highlight, rgba(255, 255, 255, 0.08));
	}

	.ch-row.expanded {
		background: var(--diveplot-palette-highlight, rgba(255, 255, 255, 0.08));
		opacity: 1;
	}

	.ch-name {
		font-weight: 500;
		flex-shrink: 0;
	}

	.ch-value {
		color: var(--diveplot-palette-text-secondary, rgba(255, 255, 255, 0.5));
		font-size: 10px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.palette-body.split .ch-value {
		display: none;
	}

	.reset-row {
		border-top: 1px solid var(--diveplot-palette-border, rgba(255, 255, 255, 0.1));
		margin-top: 2px;
	}

	.reset-label {
		color: var(--diveplot-palette-text-secondary, rgba(255, 255, 255, 0.5));
		font-style: italic;
	}

	/* ---- Value panel ---- */
	.value-panel {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		min-width: 0;
	}

	.filter-row {
		padding: 4px 6px;
		border-bottom: 1px solid var(--diveplot-palette-border, rgba(255, 255, 255, 0.1));
	}

	.filter-input {
		width: 100%;
		background: var(--diveplot-palette-highlight, rgba(255, 255, 255, 0.08));
		border: 1px solid var(--diveplot-palette-border, rgba(255, 255, 255, 0.1));
		border-radius: 3px;
		padding: 3px 6px;
		font-size: 10px;
		color: inherit;
		outline: none;
		box-sizing: border-box;
	}

	.filter-input::placeholder {
		color: var(--diveplot-palette-text-muted, rgba(255, 255, 255, 0.3));
	}

	.filter-input:focus {
		border-color: var(--diveplot-palette-text-secondary, rgba(255, 255, 255, 0.5));
	}

	.value-list {
		overflow-y: auto;
		padding: 2px;
	}

	.val-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 3px 6px;
		background: none;
		border: none;
		border-radius: 3px;
		cursor: pointer;
		font-size: 10px;
		color: inherit;
		opacity: 0.85;
		text-align: left;
	}

	.palette-panel:not(.keyboard-nav) .val-row:hover,
	.val-row.highlighted {
		background: var(--diveplot-palette-highlight, rgba(255, 255, 255, 0.08));
	}

	.val-name {
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.val-right {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.val-type {
		color: var(--diveplot-palette-text-muted, rgba(255, 255, 255, 0.3));
		font-size: 9px;
		font-style: italic;
	}

	.clear-row {
		border-top: 1px solid var(--diveplot-palette-border, rgba(255, 255, 255, 0.1));
		margin-top: 2px;
	}

	.clear-label {
		color: var(--diveplot-palette-text-secondary, rgba(255, 255, 255, 0.5));
		font-style: italic;
	}

	.palette-empty {
		padding: 8px 6px;
		text-align: center;
		color: var(--diveplot-palette-text-muted, rgba(255, 255, 255, 0.3));
		font-size: 10px;
	}

	/* ---- Numeric scrubber ---- */
	.scrubber-panel {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 6px;
	}

	.scrubber-input {
		width: 48px;
		background: none;
		border: none;
		border-bottom: 1px solid var(--diveplot-palette-text-secondary, rgba(255, 255, 255, 0.5));
		padding: 1px 0;
		font-size: 10px;
		font-weight: 500;
		color: inherit;
		text-align: center;
		outline: none;
		cursor: ns-resize;
		-moz-appearance: textfield;
	}

	.scrubber-input::-webkit-inner-spin-button,
	.scrubber-input::-webkit-outer-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}

	.scrubber-input:focus {
		border-bottom-color: var(--diveplot-palette-text, #ffffff);
		cursor: text;
	}

	.scrubber-range {
		font-size: 9px;
		color: var(--diveplot-palette-text-muted, rgba(255, 255, 255, 0.3));
	}

	/* ---- Numeric group ---- */
	.group-panel {
		display: flex;
		flex-direction: column;
		padding: 4px;
	}

	.group-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 3px 6px;
		font-size: 10px;
	}

	.group-label {
		color: var(--diveplot-palette-text-secondary, rgba(255, 255, 255, 0.5));
		font-weight: 500;
	}

	.group-row.highlighted {
		background: var(--diveplot-palette-highlight, rgba(255, 255, 255, 0.08));
		border-radius: 4px;
	}

	.constant-entry {
		border-bottom: 1px solid var(--diveplot-palette-border, rgba(255, 255, 255, 0.1));
		margin-bottom: 2px;
	}

	/* ---- LOD panel ---- */
	.lod-readout {
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		color: var(--diveplot-palette-text-secondary, rgba(255, 255, 255, 0.5));
	}

	.lod-readout.lod-active {
		color: var(--diveplot-palette-text, #ffffff);
	}

	.lod-hint {
		font-size: 9px;
		color: var(--diveplot-palette-text-muted, rgba(255, 255, 255, 0.3));
		font-style: italic;
		padding: 3px 6px 0;
	}
</style>
