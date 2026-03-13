<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import type { ChartContext } from '$lib/types';
	import type { MarkEntry } from '$lib/config/ChartConfig.svelte';
	import { tableSchemaService } from '$lib/data/TableSchemaService.svelte';
	import { getAssignableChannels, getCompatibleColumns } from './palette-channels';
	import type { ColumnOption } from './palette-channels';

	interface Props {
		open: boolean;
	}

	let { open = $bindable() }: Props = $props();

	const chartContext = getContext<ChartContext>('chart');

	// --- Internal state ---
	let mode: 'channel-select' | 'column-select' = $state('channel-select');
	let selectedChannel: string | null = $state(null);
	let filterText: string = $state('');
	let highlightIndex: number = $state(0);
	let checkpointed = false;
	let filterInput: HTMLInputElement | null = $state(null);
	let panelEl: HTMLDivElement | null = $state(null);

	// --- Target mark resolution ---
	const targetEntry: MarkEntry | null = $derived.by(() => {
		const entries = chartContext.config.entries;
		if (entries.size === 0) return null;
		if (entries.size === 1) return [...entries.values()][0];
		const hoveredId = chartContext.tooltipManager?.currentMarkId;
		if (hoveredId) return entries.get(hoveredId) ?? null;
		return [...entries.values()][0];
	});

	// --- Channels for current mark ---
	const channels: string[] = $derived(
		targetEntry ? getAssignableChannels(targetEntry.markType) : []
	);

	// --- Schema access ---
	const schema = $derived.by(() => {
		tableSchemaService.version;
		return targetEntry ? tableSchemaService.getSchema(targetEntry.table) : null;
	});

	// --- Filtered columns for selected channel ---
	const allColumns: ColumnOption[] = $derived(
		schema && selectedChannel
			? getCompatibleColumns(schema, selectedChannel, chartContext.scaleTypes)
			: []
	);

	const filteredColumns: ColumnOption[] = $derived.by(() => {
		if (!filterText) return allColumns;
		const lower = filterText.toLowerCase();
		return allColumns.filter((c) => c.name.toLowerCase().includes(lower));
	});

	// --- Current value for a channel ---
	function currentValue(channel: string): string {
		if (!targetEntry) return '';
		const val = targetEntry[channel as keyof MarkEntry];
		if (val == null) return '—';
		if (typeof val === 'string') return val;
		if (typeof val === 'number') return String(val);
		return '(expr)';
	}

	// --- Original column name captured on entering column-select ---
	let originalColumnName: string | null = $state(null);

	// --- Can the selected channel be cleared? (show clear row) ---
	const canClear: boolean = $derived(originalColumnName != null);

	// --- Whether the clear row is visible (hidden when filtering) ---
	const showClear: boolean = $derived(canClear && !filterText);

	// --- Total item count in column-select (for keyboard nav) ---
	const columnListSize: number = $derived(
		filteredColumns.length + (showClear ? 1 : 0)
	);

	// --- Reset state on open/close ---
	$effect(() => {
		if (open) {
			mode = 'channel-select';
			selectedChannel = null;
			filterText = '';
			highlightIndex = 0;
			checkpointed = false;
		}
	});

	// --- Focus management ---
	$effect(() => {
		if (open && mode === 'column-select' && filterInput) {
			filterInput.focus();
		} else if (open && mode === 'channel-select' && panelEl) {
			panelEl.focus();
		}
	});

	// --- Actions ---
	function close() {
		if (chartContext.config.previewing) {
			chartContext.config.cancelPreview();
		}
		if (checkpointed) {
			chartContext.config.undo();
			checkpointed = false;
		}
		open = false;
	}

	function resetAll() {
		if (!targetEntry) return;
		chartContext.config.checkpoint('palette reset all');
		chartContext.config.revertMark(targetEntry.id);
		open = false;
	}

	function selectChannel(channel: string) {
		selectedChannel = channel;
		const val = targetEntry?.[channel as keyof MarkEntry];
		originalColumnName = typeof val === 'string' ? val : null;
		filterText = '';
		highlightIndex = 0;
		chartContext.config.checkpoint('palette');
		checkpointed = true;
		mode = 'column-select';
	}

	function backToChannels() {
		if (chartContext.config.previewing) {
			chartContext.config.cancelPreview();
		}
		if (checkpointed) {
			chartContext.config.undo();
			checkpointed = false;
		}
		mode = 'channel-select';
		selectedChannel = null;
		originalColumnName = null;
		filterText = '';
		highlightIndex = 0;
	}

	function previewColumn(columnName: string | null) {
		if (!targetEntry || !selectedChannel) return;
		if (chartContext.config.previewing) {
			chartContext.config.cancelPreview();
		}
		chartContext.config.beginPreview(targetEntry.id, selectedChannel, columnName);
	}

	function commit(columnName: string | null) {
		if (!targetEntry || !selectedChannel) return;
		if (chartContext.config.previewing) {
			chartContext.config.commitPreview();
		} else {
			chartContext.config.setMarkProp(targetEntry.id, selectedChannel, columnName);
		}
		// Stay open — return to channel list so user can chain edits
		checkpointed = false;
		mode = 'channel-select';
		selectedChannel = null;
		originalColumnName = null;
		filterText = '';
		highlightIndex = 0;
	}

	// --- Keyboard handling ---
	function handleKeydown(event: KeyboardEvent) {
		event.stopPropagation();

		if ((event.metaKey || event.ctrlKey) && event.key === 'z') {
			event.preventDefault();
			if (mode === 'channel-select' && chartContext.config.canUndo) {
				chartContext.config.undo();
			}
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			if (mode === 'column-select') {
				backToChannels();
			} else {
				close();
			}
			return;
		}

		const listSize = mode === 'channel-select' ? channels.length + 1 : columnListSize;

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			if (listSize > 0) highlightIndex = (highlightIndex + 1) % listSize;
			return;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			if (listSize > 0) highlightIndex = (highlightIndex - 1 + listSize) % listSize;
			return;
		}

		if (event.key === 'Enter') {
			event.preventDefault();
			if (mode === 'channel-select' && highlightIndex === channels.length) {
				resetAll();
			} else if (mode === 'channel-select' && channels[highlightIndex]) {
				selectChannel(channels[highlightIndex]);
			} else if (mode === 'column-select') {
				if (showClear && highlightIndex === 0) {
					commit(null);
				} else {
					const colIdx = showClear ? highlightIndex - 1 : highlightIndex;
					if (filteredColumns[colIdx]) {
						commit(filteredColumns[colIdx].name);
					}
				}
			}
			return;
		}
	}

	// Clamp highlight when list shrinks (e.g. from filtering)
	$effect(() => {
		const max = mode === 'channel-select' ? channels.length + 1 : columnListSize;
		if (highlightIndex >= max && max > 0) {
			highlightIndex = max - 1;
		}
	});

	// --- Close on outside click ---
	function handleWindowPointerDown(event: PointerEvent) {
		if (!open || !panelEl) return;
		const cell = panelEl.closest('.chart-cell');
		if (cell && !cell.contains(event.target as Node)) {
			close();
		}
	}

	// --- Cleanup on destroy ---
	onDestroy(() => {
		if (chartContext.config.previewing) {
			chartContext.config.cancelPreview();
		}
	});
</script>

<svelte:window onpointerdown={handleWindowPointerDown} />

{#if open && targetEntry}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="palette-backdrop" onclick={close} onkeydown={handleKeydown} onwheel={(e) => e.preventDefault()}>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="palette-panel"
			bind:this={panelEl}
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
		>
			<div class="palette-header">
				{#if mode === 'column-select'}
					<button class="back-btn" onclick={backToChannels}>&larr;</button>
					<span class="header-channel">{selectedChannel}</span>
				{:else}
					<span class="header-mark">{targetEntry.markType}</span>
				{/if}
			</div>

			{#if mode === 'column-select'}
				<div class="filter-row">
					<input
						bind:this={filterInput}
						bind:value={filterText}
						placeholder="Filter columns..."
						class="filter-input"
					/>
				</div>
			{/if}

			<div class="palette-list">
				{#if mode === 'channel-select'}
					{#each channels as ch, i}
						<button
							class="palette-item"
							class:highlighted={i === highlightIndex}
							onclick={() => selectChannel(ch)}
							onpointerenter={() => (highlightIndex = i)}
						>
							<span class="item-label">{ch}</span>
							<span class="item-value">{currentValue(ch)}</span>
						</button>
					{/each}
					<button
						class="palette-item reset-item"
						class:highlighted={highlightIndex === channels.length}
						onclick={resetAll}
						onpointerenter={() => (highlightIndex = channels.length)}
					>
						<span class="item-label clear-label">reset all</span>
					</button>
				{:else}
					{#if showClear}
						<button
							class="palette-item clear-item"
							class:highlighted={highlightIndex === 0}
							onpointerenter={() => (highlightIndex = 0)}
							onclick={() => commit(null)}
						>
							<span class="item-label clear-label">clear</span>
						</button>
					{/if}
					{#each filteredColumns as col, i}
						{@const idx = showClear ? i + 1 : i}
						<button
							class="palette-item"
							class:highlighted={idx === highlightIndex}
							class:current={col.name === originalColumnName}
							onpointerenter={() => {
								highlightIndex = idx;
								previewColumn(col.name);
							}}
							onclick={() => commit(col.name)}
						>
							<span class="item-label">{col.name}</span>
							<span class="item-right">
								{#if col.name === originalColumnName}
									<span class="current-marker">&#10003;</span>
								{/if}
								<span class="item-type">{col.jsType}</span>
							</span>
						</button>
					{/each}
					{#if filteredColumns.length === 0}
						<div class="palette-empty">No matching columns</div>
					{/if}
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.palette-backdrop {
		position: absolute;
		inset: 0;
		z-index: 1100;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding-top: 12%;
		background: transparent;
		pointer-events: auto;
	}

	.palette-panel {
		width: 280px;
		min-height: 180px;
		max-height: max(60%, 280px);
		display: flex;
		flex-direction: column;
		background: #1e1e2e;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		box-shadow:
			0 8px 32px rgba(0, 0, 0, 0.4),
			0 2px 8px rgba(0, 0, 0, 0.2);
		overflow: hidden;
		outline: none;
	}

	.palette-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 12px;
		font-size: 12px;
		font-weight: 600;
		color: rgba(255, 255, 255, 0.5);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
	}

	.back-btn {
		background: none;
		border: none;
		color: rgba(255, 255, 255, 0.6);
		cursor: pointer;
		padding: 0 4px;
		font-size: 14px;
		line-height: 1;
	}

	.back-btn:hover {
		color: rgba(255, 255, 255, 0.9);
	}

	.header-channel {
		color: rgba(255, 255, 255, 0.7);
	}

	.header-mark {
		color: rgba(255, 255, 255, 0.5);
	}

	.filter-row {
		padding: 6px 8px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
	}

	.filter-input {
		width: 100%;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 4px;
		padding: 6px 8px;
		font-size: 13px;
		color: rgba(255, 255, 255, 0.9);
		outline: none;
		box-sizing: border-box;
	}

	.filter-input::placeholder {
		color: rgba(255, 255, 255, 0.3);
	}

	.filter-input:focus {
		border-color: rgba(255, 255, 255, 0.2);
	}

	.palette-list {
		overflow-y: auto;
		padding: 4px;
	}

	.palette-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 7px 8px;
		background: none;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-size: 13px;
		color: rgba(255, 255, 255, 0.85);
		text-align: left;
	}

	.palette-item:hover,
	.palette-item.highlighted {
		background: rgba(255, 255, 255, 0.08);
	}

	.palette-item.current {
		color: rgba(255, 255, 255, 1);
	}

	.item-label {
		font-weight: 500;
	}

	.item-value {
		color: rgba(255, 255, 255, 0.4);
		font-size: 12px;
	}

	.item-right {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.current-marker {
		color: rgba(120, 200, 120, 0.8);
		font-size: 12px;
	}

	.item-type {
		color: rgba(255, 255, 255, 0.3);
		font-size: 11px;
		font-style: italic;
	}

	.clear-item {
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
		margin-bottom: 2px;
	}

	.reset-item {
		border-top: 1px solid rgba(255, 255, 255, 0.06);
		margin-top: 2px;
	}

	.clear-label {
		color: rgba(255, 255, 255, 0.4);
		font-style: italic;
	}

	.palette-empty {
		padding: 12px 8px;
		text-align: center;
		color: rgba(255, 255, 255, 0.3);
		font-size: 13px;
	}
</style>
