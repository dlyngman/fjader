<script>
	import { onMount } from 'svelte';
	import { render } from '$lib/spec';

	const dataUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/data/penguins.parquet`;

	const DEFAULT_SPEC = {
		data: {
			penguins: { url: dataUrl, type: 'parquet' }
		},
		plot: {
			marks: [
				{
					mark: 'dot',
					table: 'penguins',
					x: 'bill_length',
					y: 'bill_depth',
					fill: 'species',
					opacity: 0.6,
					tooltip: true
				}
			]
		}
	};

	let containerA = $state(null);
	let containerB = $state(null);
	let handleA = $state(null);
	let handleB = $state(null);
	let specTextA = $state(JSON.stringify(DEFAULT_SPEC, null, 2));
	let specTextB = $state('');
	let statusA = $state('Ready');
	let statusB = $state('Ready');
	let errorA = $state('');
	let errorB = $state('');

	async function renderChart(which) {
		const isA = which === 'A';
		const specText = isA ? specTextA : specTextB;
		const container = isA ? containerA : containerB;
		let handle = isA ? handleA : handleB;

		if (isA) errorA = '';
		else errorB = '';
		if (isA) statusA = 'Rendering...';
		else statusB = 'Rendering...';

		if (handle) {
			handle.destroy();
			handle = null;
		}
		if (container) container.innerHTML = '';

		try {
			const parsed = JSON.parse(specText);
			// Accept both full DivePlotSpec ({ data, plot }) and bare PlotSpec ({ marks })
			const spec = parsed.marks
				? { data: { penguins: { url: dataUrl, type: 'parquet' } }, plot: parsed }
				: parsed;
			handle = await render(container, spec);
			if (isA) {
				handleA = handle;
				statusA = 'Rendered';
			} else {
				handleB = handle;
				statusB = 'Rendered';
			}
		} catch (e) {
			if (isA) {
				errorA = e.message;
				statusA = 'Error';
			} else {
				errorB = e.message;
				statusB = 'Error';
			}
		}
	}

	function handleEditorKey(e, which) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
			e.preventDefault();
			renderChart(which);
		}
	}

	onMount(() => {
		renderChart('A');
		return () => {
			handleA?.destroy();
			handleB?.destroy();
		};
	});
</script>

<div class="page">
	<div class="pane">
		<div class="toolbar">
			<span class="label">Original</span>
			<button onclick={() => renderChart('A')}>Render</button>
			<span class="status">{statusA}</span>
		</div>
		{#if errorA}
			<div class="error">{errorA}</div>
		{/if}
		<textarea
			bind:value={specTextA}
			spellcheck="false"
			onkeydown={(e) => handleEditorKey(e, 'A')}
		></textarea>
		<div class="chart-area" bind:this={containerA}></div>
	</div>

	<div class="divider"></div>

	<div class="pane">
		<div class="toolbar">
			<span class="label">Exported</span>
			<button onclick={() => renderChart('B')}>Render</button>
			<span class="status">{statusB}</span>
		</div>
		{#if errorB}
			<div class="error">{errorB}</div>
		{/if}
		<textarea
			bind:value={specTextB}
			spellcheck="false"
			placeholder="Paste exported spec here (Cmd+E from palette)"
			onkeydown={(e) => handleEditorKey(e, 'B')}
		></textarea>
		<div class="chart-area" bind:this={containerB}></div>
	</div>
</div>

<style>
	.page {
		display: flex;
		height: 100vh;
		overflow: hidden;
		background: #0a0a0a;
	}

	.pane {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.divider {
		width: 1px;
		background: #333;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid #333;
		background: #1a1a1a;
	}

	.label {
		font-size: 12px;
		font-weight: 600;
		color: #aaa;
	}

	.toolbar button {
		padding: 3px 10px;
		background: #2a6;
		color: white;
		border: none;
		border-radius: 3px;
		font-size: 11px;
		cursor: pointer;
	}

	.toolbar button:hover {
		background: #3b7;
	}

	.status {
		font-size: 10px;
		color: #666;
	}

	.error {
		padding: 4px 10px;
		background: #411;
		color: #f88;
		font-size: 11px;
		font-family: monospace;
	}

	textarea {
		height: 200px;
		padding: 8px 10px;
		background: #111;
		color: #ddd;
		border: none;
		border-bottom: 1px solid #333;
		font-family: 'SF Mono', 'Fira Code', monospace;
		font-size: 11px;
		line-height: 1.4;
		resize: vertical;
		outline: none;
		tab-size: 2;
	}

	textarea::placeholder {
		color: #444;
	}

	.chart-area {
		flex: 1;
		overflow: auto;
		padding: 12px;
	}
</style>
