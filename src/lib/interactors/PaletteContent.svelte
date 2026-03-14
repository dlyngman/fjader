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
		CHART_CHANNELS,
		CHART_CHANNEL_DEFS
	} from './palette-channels';
	import type { ChartChannel, OptionChannelDef } from './palette-channels';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();

	const chartContext = getContext<ChartContext>('chart');

	// ---- Tab types ----
	type TabItem = { kind: 'mark'; entry: MarkEntry } | { kind: 'chart' };

	// ---- State ----
	let activeTabIndex = $state((() => {
		const hoveredId = chartContext.tooltipManager?.currentMarkId;
		if (!hoveredId) return 0;
		let i = 0;
		for (const entry of chartContext.config.entries.values()) {
			if (entry.id === hoveredId) return i;
			i++;
		}
		return 0;
	})());

	let focusZone: 'tabs' | 'channels' | 'values' = $state('channels');
	let channelHighlightRaw = $state(0);
	let expandedChannel: string | null = $state(null);
	let valueHighlightRaw = $state(0);
	let filterText = $state('');
	let checkpointed = false;
	let originalColumnName: string | null = $state(null);
	let keyboardNav = $state(false);
	let filterRevealed = $state(false);

	// DOM refs
	let filterInput: HTMLInputElement | null = $state(null);
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
		return [...cols, ...opts];
	});

	const expandedOptionDef: OptionChannelDef | null = $derived.by(() => {
		if (!expandedChannel) return null;
		if (isChartTab) {
			return CHART_CHANNEL_DEFS[expandedChannel as ChartChannel] ?? null;
		}
		if (!targetEntry) return null;
		return getOptionChannels(targetEntry.markType)[expandedChannel] ?? null;
	});

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
	const allValues: Array<{ name: string; value?: string | null; jsType?: string; current?: boolean }> = $derived.by(() => {
		if (!expandedChannel) return [];

		if (expandedOptionDef) {
			const def = expandedOptionDef;
			let options = def.options;

			if (def.dynamic === 'scaleType' && schema) {
				const axis = expandedChannel === 'x scale' ? 'x' : 'y';
				const entry = firstEntry;
				if (entry) options = getCompatibleScaleTypes(schema, axis as 'x' | 'y', entry);
			}

			const entry = isChartTab ? firstEntry : targetEntry;
			const currentVal = entry?.[def.prop as keyof MarkEntry] ?? null;
			return options.map((o) => ({
				name: o.label,
				value: o.value,
				current: o.value === currentVal
			}));
		}

		if (!targetEntry || !schema) return [];
		const cols = getCompatibleColumns(schema, expandedChannel, chartContext.scaleTypes);
		return cols.map((c) => ({
			name: c.name,
			jsType: c.jsType,
			current: c.name === originalColumnName
		}));
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
		valueHighlightRaw >= valueListSize && valueListSize > 0
			? valueListSize - 1
			: valueHighlightRaw
	);

	// ---- Current value display for channel rows ----
	function currentValue(channel: string): string {
		const optDef = isChartTab
			? CHART_CHANNEL_DEFS[channel as ChartChannel]
			: targetEntry ? getOptionChannels(targetEntry.markType)[channel] : null;

		if (optDef) {
			const entry = isChartTab ? firstEntry : targetEntry;
			if (!entry) return '\u2014';
			const val = entry[optDef.prop as keyof MarkEntry];
			if (val == null) return 'auto';
			return String(val);
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
		if (focusZone === 'values' && valueHighlightRaw === -1 && filterInput) {
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
		} else if (targetEntry) {
			chartContext.config.checkpoint('palette reset all');
			chartContext.config.revertMark(targetEntry.id);
		}
		onclose();
	}

	function expandChannel(channel: string) {
		if (expandedChannel != null) {
			collapseCancel();
		}
		expandedChannel = channel;

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

	function collapseCancel() {
		if (chartContext.config.previewing) {
			chartContext.config.cancelPreview();
		}
		if (checkpointed) {
			chartContext.config.undo();
			checkpointed = false;
		}
		expandedChannel = null;
		originalColumnName = null;
		filterText = '';
		filterRevealed = false;
		valueHighlightRaw = 0;
	}

	function collapseToChannels() {
		collapseCancel();
		focusZone = 'channels';
		updateFocus();
	}

	function resolveExpandedProp(): string | null {
		if (!expandedChannel) return null;
		if (expandedOptionDef) return expandedOptionDef.prop;
		return expandedChannel;
	}

	function previewValue(valueName: string | null) {
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

	function commitValue(valueName: string | null) {
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
		focusZone = 'channels';
		updateFocus();
	}

	function switchTab(index: number) {
		if (expandedChannel != null) {
			collapseCancel();
		}
		activeTabIndex = index;
		channelHighlightRaw = 0;
	}

	// ---- Resolve value from highlight index ----
	function getValueAtIndex(idx: number): { name: string; isNull: boolean } | null {
		if (showClear && idx === filteredValues.length) {
			return { name: 'clear', isNull: true };
		}
		const v = filteredValues[idx];
		if (!v) return null;
		if (expandedOptionDef && (v as { value?: string | null }).value === null) {
			return { name: v.name, isNull: true };
		}
		return { name: v.name, isNull: false };
	}

	// ---- Keyboard ----
	function handleKeydown(event: KeyboardEvent) {
		event.stopPropagation();
		keyboardNav = true;

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
				collapseToChannels();
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

	function previewAtHighlight() {
		const item = getValueAtIndex(valueHighlight);
		if (!item) return;
		if (item.isNull && !expandedOptionDef) {
			if (chartContext.config.previewing) {
				chartContext.config.cancelPreview();
			}
		} else {
			previewValue(item.isNull ? null : item.name);
		}
	}

	function handleValueKeys(event: KeyboardEvent) {
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
			}
		} else if (key === 'ArrowDown') {
			event.preventDefault();
			if (valueHighlight === -1) {
				valueHighlightRaw = 0;
				updateFocus();
				previewAtHighlight();
			} else if (valueListSize > 0) {
				valueHighlightRaw = (valueHighlight + 1) % valueListSize;
				previewAtHighlight();
			}
		} else if (key === 'ArrowLeft' || key === 'Escape') {
			event.preventDefault();
			collapseToChannels();
		} else if (key === 'Enter' && !event.repeat) {
			event.preventDefault();
			if (valueHighlight >= 0) {
				const item = getValueAtIndex(valueHighlight);
				if (item) {
					commitValue(item.isNull ? null : item.name);
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

	// ---- Outside click ----
	function handleWindowPointerDown(event: PointerEvent) {
		if (!panelEl) return;
		if (!panelEl.contains(event.target as Node)) {
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
		onwheel={(e) => e.preventDefault()}
		onpointermove={() => { keyboardNav = false; }}
	>
		<!-- Tab bar -->
		<div class="tab-bar">
			{#each tabList as tab, i (tab.kind === 'chart' ? 'chart' : tab.entry.id)}
				{@const isActive = i === Math.min(activeTabIndex, tabList.length - 1)}
				<button
					class={['tab', { active: isActive, focused: focusZone === 'tabs' && isActive }]}
					onclick={() => { switchTab(i); focusZone = 'channels'; }}
				>
					{tabLabels[i]}
				</button>
			{/each}
		</div>

		<!-- Body -->
		<div class={['palette-body', { split: expandedChannel != null }]}>
			<!-- Channel list -->
			<div class="channel-list">
				{#each currentChannels as ch, i (ch)}
					<button
						class={['ch-row', { highlighted: focusZone === 'channels' && i === channelHighlight, expanded: ch === expandedChannel }]}
						onclick={() => expandChannel(ch)}
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
					class={['ch-row', 'reset-row', { highlighted: focusZone === 'channels' && channelHighlight === currentChannels.length }]}
					onclick={resetAll}
					onpointerenter={() => {
						if (!keyboardNav && focusZone === 'channels') channelHighlightRaw = currentChannels.length;
					}}
				>
					<span class="ch-name reset-label">reset all</span>
				</button>
			</div>

			<!-- Value panel (only when expanded) -->
			{#if expandedChannel != null}
				<div class="value-panel">
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
					<div class="value-list">
						{#each filteredValues as val, i (val.name)}
							{@const isAutoNull = expandedOptionDef && (val as { value?: string | null }).value === null}
							<button
								class={['val-row', { highlighted: focusZone === 'values' && i === valueHighlight, current: val.current }]}
								onpointerenter={() => {
									if (keyboardNav) return;
									valueHighlightRaw = i;
									if (isAutoNull) {
										previewValue(null);
									} else {
										previewValue(val.name);
									}
								}}
								onclick={() => commitValue(isAutoNull ? null : val.name)}
							>
								<span class="val-name">{val.name}</span>
								<span class="val-right">
									{#if val.current}
										<span class="current-marker">&#10003;</span>
									{/if}
									{#if val.jsType}
										<span class="val-type">{val.jsType}</span>
									{/if}
								</span>
							</button>
						{/each}
						{#if showClear}
							<button
								class={['val-row', 'clear-row', { highlighted: focusZone === 'values' && valueHighlight === filteredValues.length }]}
								onpointerenter={() => { if (!keyboardNav) valueHighlightRaw = filteredValues.length; }}
								onclick={() => commitValue(null)}
							>
								<span class="val-name clear-label">clear</span>
							</button>
						{/if}
						{#if filteredValues.length === 0}
							<div class="palette-empty">No matches</div>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.palette-panel {
		position: absolute;
		top: 8px;
		right: 8px;
		z-index: 1100;
		width: 280px;
		max-height: calc(100% - 16px);
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
		padding: 7px 10px 5px;
		font-size: 11px;
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
		padding: 4px;
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
		padding: 6px 8px;
		background: none;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
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
		font-size: 11px;
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
		padding: 6px 8px;
		border-bottom: 1px solid var(--diveplot-palette-border, rgba(255, 255, 255, 0.1));
	}

	.filter-input {
		width: 100%;
		background: var(--diveplot-palette-highlight, rgba(255, 255, 255, 0.08));
		border: 1px solid var(--diveplot-palette-border, rgba(255, 255, 255, 0.1));
		border-radius: 4px;
		padding: 4px 8px;
		font-size: 11px;
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
		padding: 4px;
	}

	.val-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 5px 8px;
		background: none;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-size: 11px;
		color: inherit;
		opacity: 0.85;
		text-align: left;
	}

	.palette-panel:not(.keyboard-nav) .val-row:hover,
	.val-row.highlighted {
		background: var(--diveplot-palette-highlight, rgba(255, 255, 255, 0.08));
	}

	.val-row.current {
		opacity: 1;
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

	.current-marker {
		color: rgba(120, 200, 120, 0.8);
		font-size: 10px;
	}

	.val-type {
		color: var(--diveplot-palette-text-muted, rgba(255, 255, 255, 0.3));
		font-size: 10px;
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
		padding: 12px 8px;
		text-align: center;
		color: var(--diveplot-palette-text-muted, rgba(255, 255, 255, 0.3));
		font-size: 11px;
	}
</style>
