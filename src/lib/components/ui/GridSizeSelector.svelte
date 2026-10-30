<script lang="ts">
	interface Props {
		maxSize?: number;
		maxSelected?: number;
		selectedRows?: number;
		selectedColumns?: number;
	}

	let {
		maxSize = 5,
		maxSelected = maxSize,
		selectedRows = $bindable(1),
		selectedColumns = $bindable(1)
	}: Props = $props();

	let isOpen = $state(false);
	let hoverRows = $state(0);
	let hoverColumns = $state(0);
	let dropdownEl = $state<HTMLDivElement | null>(null);
	let buttonEl = $state<HTMLButtonElement | null>(null);

	/** A press anywhere but the dropdown and its button closes it. */
	function handleClickOutside(event: MouseEvent) {
		if (!isOpen) return;
		const target = event.target as Node;
		if (dropdownEl?.contains(target) || buttonEl?.contains(target)) return;
		isOpen = false;
	}

	function handleSelect(rows: number, columns: number) {
		selectedRows = rows;
		selectedColumns = columns;
		isOpen = false;
	}

	// Handle mouse entering a cell
	function handleMouseEnter(row: number, col: number) {
		hoverRows = row;
		hoverColumns = col;
	}
</script>

<svelte:document onmousedown={handleClickOutside} />

<div class="grid-size-selector">
	<button class="size-display" onclick={() => (isOpen = !isOpen)} bind:this={buttonEl}>
		{isOpen && hoverRows > 0 && hoverColumns > 0
			? `${hoverRows} × ${hoverColumns} (preview)`
			: `${selectedRows} × ${selectedColumns}`}
	</button>

	{#if isOpen}
		<div class="dropdown" bind:this={dropdownEl}>
			<div class="grid-container">
				{#each Array(maxSize) as _, rowIndex (rowIndex)}
					<div class="grid-row">
						{#each Array(maxSize) as _, colIndex (colIndex)}
							{@const row = rowIndex + 1}
							{@const col = colIndex + 1}
							{@const isDisabled = row * col > maxSelected}
							<!-- {@const isDisabled = row > maxSize || col > maxSize} -->
							{@const isActive = !isDisabled && row <= hoverRows && col <= hoverColumns}
							{@const isSelected = row === selectedRows && col === selectedColumns}

							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="grid-cell"
								class:active={isActive}
								class:selected={isSelected}
								class:disabled={isDisabled}
								onmouseenter={() => !isDisabled && handleMouseEnter(row, col)}
								onclick={() => !isDisabled && handleSelect(row, col)}
							></div>
						{/each}
					</div>
				{/each}
			</div>
			<div class="size-indicator">{hoverRows} × {hoverColumns}</div>
		</div>
	{/if}
</div>

<style>
	.grid-size-selector {
		position: relative;
		display: inline-block;
		font-family: sans-serif;
	}

	.size-display {
		padding: 8px 16px;
		background-color: var(--fjader-bg, #ffffff);
		border: 1px solid #ccc;
		border-radius: 4px;
		cursor: pointer;
		font-size: 14px;
		min-width: 80px;
		text-align: center;
	}

	.dropdown {
		position: absolute;
		top: 100%;
		left: 0;
		margin-top: 5px;
		background-color: var(--fjader-bg, #ffffff);
		border: 1px solid #ccc;
		border-radius: 4px;
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
		padding: 10px;
		z-index: 100;
	}

	.grid-container {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.grid-row {
		display: flex;
		gap: 2px;
	}

	.grid-cell {
		width: 16px;
		height: 16px;
		background-color: #f0f0f0;
		border: 1px solid #e0e0e0;
		cursor: pointer;
	}

	.grid-cell.active {
		background-color: var(--fjader-accent, #93c5fd);
		/* border-color: #2980b9; */
	}

	.grid-cell.selected {
		background-color: var(--fjader-primary, #3b82f6);
		/* border-color: #27ae60; */
	}

	.grid-cell.disabled {
		background-color: #f8f9fa;
		border-color: #e9ecef;
		/* cursor: not-allowed; */
		cursor: default;
		opacity: 0.6;
	}

	.size-indicator {
		margin-top: 10px;
		text-align: center;
		font-size: 14px;
		font-weight: bold;
	}
</style>
