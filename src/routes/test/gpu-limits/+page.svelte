<script>
	/**
	 * GPU limits: what this adapter supports against what a device gets by
	 * default, for deciding how fjader lays out its GPU data.
	 *
	 * fjader requests no limits, so every device runs at WebGPU's defaults
	 * whatever the hardware could do. A layout that fits the defaults runs on
	 * any WebGPU device; one that needs more excludes hardware. This page shows
	 * how much room each limit has, starting with the ones fjader's layout
	 * presses on (storage buffers per stage, immediates, uniform sizes,
	 * bind groups), then everything else.
	 *
	 * It also creates a second device asking for the adapter's maxima of the
	 * pressed limits, to check that asking works and what the device then
	 * reports.
	 *
	 * Save results downloads it all as JSON.
	 */
	import { onMount } from 'svelte';

	/** The limits fjader's layout presses on, with what presses on each. */
	const PRESSED = [
		['maxStorageBuffersPerShaderStage', 'Rects binds 8 in its vertex stage (the default)'],
		['maxStorageBuffersInVertexStage', 'newer per-stage limit, where supported'],
		['maxStorageBuffersInFragmentStage', 'newer per-stage limit, where supported'],
		['maxImmediateSize', 'chart scales + entrance (48 B); the scaled resolve uses 64 B'],
		['maxUniformBuffersPerShaderStage', 'colour and size configs, mark constants, atlas entries'],
		['maxUniformBufferBindingSize', 'the text atlas entry table is exactly 64 KiB'],
		['maxStorageBufferBindingSize', 'largest per-row channel: rows × 4 B'],
		['maxBufferSize', 'largest single buffer'],
		['maxBindGroups', 'fjader uses 3 (frame, mark data, scale resources)'],
		['maxBindingsPerBindGroup', ''],
		['maxSampledTexturesPerShaderStage', 'the text atlas'],
		['maxSamplersPerShaderStage', 'the text atlas'],
		['maxVertexBuffers', 'quad geometry, facet and seam attributes'],
		['maxVertexAttributes', ''],
		['maxInterStageShaderVariables', 'vertex → fragment outputs'],
		['maxComputeWorkgroupSizeX', 'resolve and remap kernels'],
		['maxComputeInvocationsPerWorkgroup', ''],
		['maxTextureDimension2D', 'atlas texture, canvases']
	];

	let rows = $state([]);
	let info = $state(null);
	let extra = $state([]);
	let raised = $state(null);
	let error = $state(null);
	let done = $state(false);

	function limitNames(limits) {
		const names = new Set();
		for (const k in limits) names.add(k);
		for (
			let p = Object.getPrototypeOf(limits);
			p && p !== Object.prototype;
			p = Object.getPrototypeOf(p)
		) {
			for (const k of Object.getOwnPropertyNames(p)) if (k !== 'constructor') names.add(k);
		}
		return [...names].filter((k) => typeof limits[k] === 'number').sort();
	}

	onMount(async () => {
		try {
			if (!navigator.gpu) throw new Error('navigator.gpu is missing: no WebGPU.');
			const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
			if (!adapter) throw new Error('No adapter.');
			// A device asking for nothing: the limits fjader runs at today.
			const device = await adapter.requestDevice();

			const ai = adapter.info ?? {};
			info = {
				userAgent: navigator.userAgent,
				vendor: ai.vendor,
				architecture: ai.architecture,
				description: ai.description,
				isFallbackAdapter: ai.isFallbackAdapter ?? adapter.isFallbackAdapter,
				adapterFeatures: [...adapter.features].sort(),
				wgslLanguageFeatures: [...(navigator.gpu.wgslLanguageFeatures ?? [])].sort()
			};

			const names = limitNames(adapter.limits);
			const pressed = PRESSED.map(([name]) => name);
			const row = (name, note = '') => ({
				name,
				note,
				default: device.limits[name],
				adapter: adapter.limits[name],
				headroom:
					typeof device.limits[name] === 'number' && typeof adapter.limits[name] === 'number'
						? adapter.limits[name] / device.limits[name]
						: null
			});
			rows = PRESSED.filter(([name]) => names.includes(name)).map(([name, note]) =>
				row(name, note)
			);
			extra = names.filter((n) => !pressed.includes(n)).map((n) => row(n));

			// Ask for the adapter's maxima of the pressed limits, and see what sticks.
			const requiredLimits = {};
			for (const r of rows) if (typeof r.adapter === 'number') requiredLimits[r.name] = r.adapter;
			try {
				// An adapter creates one device, then is "consumed": ask for a fresh one.
				const second = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
				if (!second) throw new Error('No second adapter.');
				const big = await second.requestDevice({ requiredLimits });
				raised = {
					ok: true,
					limits: Object.fromEntries(rows.map((r) => [r.name, big.limits[r.name]]))
				};
				big.destroy();
			} catch (e) {
				raised = { ok: false, error: `${e.name}: ${e.message}` };
			}
			device.destroy();
		} catch (e) {
			error = e.message;
		}
		done = true;
	});

	function save() {
		const blob = new Blob(
			[JSON.stringify({ info, pressed: rows, other: extra, raised }, null, 2)],
			{ type: 'application/json' }
		);
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'gpu-limits.json';
		a.click();
		URL.revokeObjectURL(a.href);
	}

	const fmt = (v) =>
		v == null ? '–' : v >= 1 << 20 ? `${(v / (1 << 20)).toFixed(0)} MiB` : String(v);
</script>

<svelte:head><title>GPU limits</title></svelte:head>

<div class="page">
	<h1>GPU limits</h1>
	<p>
		{done ? 'Done.' : 'Reading…'}
		<button disabled={!done || !!error} onclick={save}>Save results</button>
	</p>
	{#if error}<p class="error">{error}</p>{/if}

	{#if info}
		<p class="info">
			{info.vendor} · {info.architecture} · {info.description || '(no description)'}
			{info.isFallbackAdapter ? ' · FALLBACK ADAPTER' : ''}
		</p>
	{/if}

	{#if rows.length}
		<h2>Limits fjader's layout presses on</h2>
		<table>
			<thead>
				<tr><th>limit</th><th>default</th><th>adapter</th><th>×</th><th>what presses on it</th></tr>
			</thead>
			<tbody>
				{#each rows as r (r.name)}
					<tr>
						<td>{r.name}</td>
						<td>{fmt(r.default)}</td>
						<td class:more={r.headroom > 1}>{fmt(r.adapter)}</td>
						<td>{r.headroom == null ? '–' : r.headroom.toFixed(r.headroom < 10 ? 1 : 0)}</td>
						<td class="note">{r.note}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if raised}
		<h2>A device asking for the adapter's maxima</h2>
		<p class:error={!raised.ok}>
			{raised.ok ? 'Created; it reports the values above as its limits.' : raised.error}
		</p>
	{/if}

	{#if info}
		<h2>Features</h2>
		<p class="note">adapter: {info.adapterFeatures.join(', ')}</p>
		<p class="note">WGSL: {info.wgslLanguageFeatures.join(', ')}</p>
	{/if}

	{#if extra.length}
		<h2>Every other limit</h2>
		<table>
			<tbody>
				{#each extra as r (r.name)}
					<tr>
						<td>{r.name}</td>
						<td>{fmt(r.default)}</td>
						<td class:more={r.headroom > 1}>{fmt(r.adapter)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	.page {
		padding: 1rem;
		font-family: system-ui, sans-serif;
		max-width: 1100px;
	}
	table {
		border-collapse: collapse;
		font-size: 13px;
		font-variant-numeric: tabular-nums;
		margin-bottom: 1rem;
	}
	th,
	td {
		padding: 2px 10px;
		border-bottom: 1px solid #eee;
		text-align: left;
	}
	.more {
		color: #15803d;
		font-weight: 600;
	}
	.note {
		color: #555;
		font-size: 12px;
	}
	.info {
		font-family: ui-monospace, monospace;
		font-size: 12px;
	}
	.error {
		color: #b00020;
	}
</style>
