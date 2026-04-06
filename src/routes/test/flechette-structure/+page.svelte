<script>
	import { onMount } from 'svelte';
	import { loadParquet, sql } from '@uwdata/mosaic-sql';
	// NOTE: This route is broken — DataClient was deleted in the V1 cleanup.
	// import { DataClient } from '$lib/data/DataClient.svelte';

	let status = $state('Initializing...');
	let dictionaryData = $state(null);
	let dataSample = $state([]);
	let isDictionaryEncoded = $state(false);

	onMount(async () => {
		try {
			const coord = new Coordinator();
			coord.databaseConnector(wasmConnector());

			status = 'Loading Parquet...';
			await coord.exec(loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`));
			// await coord.exec(loadParquet("flights", `${window.location.origin}/data/flights-200k.parquet`));

			// Spike test
			const result = await coord.query(`
				SELECT CAST(1.5 AS REAL) as test_float
				FROM penguins LIMIT 5
			`);

			const col = result.getChild('test_float');
			const arr = col.toArray();

			console.log('Type:', arr.constructor.name); // Want: Float32Array
			console.log('Buffer:', arr.buffer); // Want: ArrayBuffer (WASM memory)

			// 1. Create Explicit ENUM Type to force Dictionary Encoding
			await coord.exec(sql`CREATE TYPE species_enum AS ENUM ('Adelie', 'Gentoo', 'Chinstrap')`);

			// 2. Create View with Cast
			await coord.exec(sql`
				CREATE VIEW penguins_enum AS 
				SELECT CAST(species AS species_enum) as species_cat FROM penguins
			`);

			// 3. Query
			const client = new DataClient(
				// 'penguins',
				'penguins_enum',
				null,
				{
					select: { species: 'species_cat' },
					// select: { species: 'species' },
					table: 'penguins_enum',
					// table: 'penguins',
					dataFormat: 'arrow',
					name: 'test-client'
				}
			);

			coord.connect(client);

			// Wait for data
			let attempts = 0;
			while (!client.arrowTable && attempts < 20) {
				await new Promise((r) => setTimeout(r, 100));
				attempts++;
			}

			if (!client.arrowTable) throw new Error('Timeout waiting for Arrow table');

			// 4. EXTRACT DATA
			const table = client.arrowTable;
			const column = table.getChild('species');
			const batch = column.data?.[0] || column;

			if (batch.dictionary) {
				isDictionaryEncoded = true;

				// --- A. EXTRACT DICTIONARY KEYS ---
				const dictVector = batch.dictionary;
				const keys = [];
				for (let i = 0; i < dictVector.length; i++) {
					keys.push({
						index: i,
						value: dictVector.get(i)
					});
				}
				dictionaryData = keys;

				// --- B. EXTRACT INDICES & CROSS-REFERENCE (RANDOM SAMPLE) ---
				const indicesArray = batch.values;
				const sample = [];
				const totalRows = indicesArray.length;
				const sampleSize = Math.min(20, totalRows);

				// Pick random rows to ensure variety
				for (let k = 0; k < sampleSize; k++) {
					const randomRowId = Math.floor(Math.random() * totalRows);
					const index = indicesArray[randomRowId];
					const resolvedValue = keys[index]?.value ?? 'ERROR';

					sample.push({
						rowId: randomRowId,
						storedIndex: index,
						resolvedString: resolvedValue
					});
				}

				// Sort by Row ID for cleaner display
				sample.sort((a, b) => a.rowId - b.rowId);
				dataSample = sample;
			} else {
				isDictionaryEncoded = false;
			}

			status = 'Complete';
			client.destroy();
		} catch (e) {
			status = `Error: ${e.message}`;
			console.error(e);
		}
	});
</script>

<div class="p-8 font-mono max-w-5xl mx-auto text-sm">
	<h1 class="text-2xl font-bold mb-4">Dictionary Data Inspector</h1>

	<div class="mb-6 p-3 bg-gray-100 border rounded">
		<strong>Status:</strong>
		{status}
	</div>

	{#if isDictionaryEncoded && dictionaryData}
		<div class="grid grid-cols-2 gap-8">
			<!-- LEFT: THE DICTIONARY (What is stored once) -->
			<div class="border rounded shadow-sm h-fit">
				<div class="bg-blue-50 p-3 border-b border-blue-100">
					<h2 class="font-bold text-blue-900 text-lg">1. The Dictionary</h2>
					<p class="text-xs text-blue-700 mt-1">
						Unique values stored in <code>batch.dictionary</code>
					</p>
				</div>
				<table class="w-full text-left">
					<thead class="bg-gray-50 text-gray-500 border-b">
						<tr>
							<th class="p-2 w-20">Index</th>
							<th class="p-2">String Value</th>
						</tr>
					</thead>
					<tbody>
						{#each dictionaryData as item (item.index)}
							<tr class="border-b last:border-0 hover:bg-gray-50">
								<td class="p-2 font-bold text-gray-400">{item.index}</td>
								<td class="p-2 font-mono text-green-700">"{item.value}"</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<!-- RIGHT: THE DATA (What is in the column) -->
			<div class="border rounded shadow-sm">
				<div class="bg-purple-50 p-3 border-b border-purple-100">
					<h2 class="font-bold text-purple-900 text-lg">2. The Data Column</h2>
					<p class="text-xs text-purple-700 mt-1">
						Random sample of 20 rows from <code>batch.values</code>
					</p>
				</div>
				<table class="w-full text-left">
					<thead class="bg-gray-50 text-gray-500 border-b">
						<tr>
							<th class="p-2 w-16">Row ID</th>
							<th class="p-2 w-24">Stored Idx</th>
							<th class="p-2">Resolved Value</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each dataSample as row (row.rowId)}
							<tr class="hover:bg-gray-50">
								<td class="p-2 text-gray-400">{row.rowId}</td>
								<td class="p-2 font-bold">{row.storedIndex}</td>
								<td class="p-2 text-gray-600">
									→ <span class="font-mono text-green-700">"{row.resolvedString}"</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{:else if status === 'Complete'}
		<div class="p-4 bg-red-50 border border-red-200 text-red-800 rounded">
			<strong>Verification Failed:</strong> Data returned was not dictionary encoded.
		</div>
	{/if}
</div>

<style>
	/* Minimal utility styles */
	.p-8 {
		padding: 2rem;
	}
	.p-4 {
		padding: 1rem;
	}
	.p-3 {
		padding: 0.75rem;
	}
	.p-2 {
		padding: 0.5rem;
	}
	.mx-auto {
		margin-left: auto;
		margin-right: auto;
	}
	.max-w-5xl {
		max-width: 64rem;
	}
	.mb-4 {
		margin-bottom: 1rem;
	}
	.mb-6 {
		margin-bottom: 1.5rem;
	}
	.grid {
		display: grid;
	}
	.grid-cols-2 {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.gap-8 {
		gap: 2rem;
	}
	.border {
		border-width: 1px;
	}
	.border-b {
		border-bottom-width: 1px;
	}
	.rounded {
		border-radius: 0.375rem;
	}
	.shadow-sm {
		box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
	}
	.bg-gray-100 {
		background-color: #f3f4f6;
	}
	.bg-gray-50 {
		background-color: #f9fafb;
	}
	.bg-blue-50 {
		background-color: #eff6ff;
	}
	.bg-purple-50 {
		background-color: #faf5ff;
	}
	.text-blue-900 {
		color: #1e3a8a;
	}
	.text-purple-900 {
		color: #581c87;
	}
	.text-green-700 {
		color: #15803d;
	}
	.text-gray-400 {
		color: #9ca3af;
	}
	.text-gray-500 {
		color: #6b7280;
	}
	.font-bold {
		font-weight: 700;
	}
	.font-mono {
		font-family: monospace;
	}
	.w-full {
		width: 100%;
	}
	.text-left {
		text-align: left;
	}
	.text-lg {
		font-size: 1.125rem;
	}
	.text-xs {
		font-size: 0.75rem;
	}
	.mt-1 {
		margin-top: 0.25rem;
	}
	.h-fit {
		height: fit-content;
	}
</style>
