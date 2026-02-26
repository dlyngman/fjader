<script>
	import { onMount } from 'svelte';
	import { render } from '$lib/spec';

	let dotContainer;
	let barContainer;
	let hconcatContainer;
	let handle1;
	let handle2;
	let handle3;
	let status = $state('Loading...');

	const dataUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/data/penguins.parquet`;

	onMount(async () => {
		try {
			// Test 1: Dot plot
			status = 'Rendering dot plot...';
			handle1 = await render(dotContainer, {
				data: {
					penguins: { url: dataUrl, type: 'parquet' }
				},
				plot: {
					width: 600,
					height: 400,
					xLabel: 'Bill Length (mm)',
					yLabel: 'Bill Depth (mm)',
					marks: [
						{
							mark: 'dot',
							table: 'penguins',
							x: 'bill_length',
							y: 'bill_depth',
							fill: 'species',
							opacity: 0.6,
							// r: 4,
							tooltip: true
						}
					]
				}
			});

			// Test 2: Bar chart with aggregate (shares coordinator with test 1)
			status = 'Rendering bar chart...';
			handle2 = await render(barContainer, {
				data: {
					penguins: { url: dataUrl, type: 'parquet' }
				},
				plot: {
					width: 600,
					height: 300,
					xLabel: 'Species',
					yLabel: 'Count',
					marks: [
						{
							mark: 'barY',
							table: 'penguins',
							x: 'species',
							y: 'count()',
							fill: 'species',
							tooltip: true
						}
					]
				}
			});

			// Test 3: hconcat layout
			status = 'Rendering hconcat layout...';
			handle3 = await render(hconcatContainer, {
				data: {
					penguins: { url: dataUrl, type: 'parquet' }
				},
				hconcat: [
					{
						height: 300,
						xLabel: 'Body Mass (g)',
						yLabel: 'Flipper Length (mm)',
						marks: [
							{
								mark: 'dot',
								table: 'penguins',
								x: 'body_mass',
								y: 'flipper_length',
								fill: 'species',
								opacity: 0.5,
								// r: 3
							}
						]
					},
					{
						height: 300,
						xLabel: 'Island',
						yLabel: 'Count',
						marks: [
							{
								mark: 'barY',
								table: 'penguins',
								x: 'island',
								y: 'count()',
								fill: 'island'
							}
						]
					}
				]
			});

			status = 'All charts rendered successfully!';
		} catch (error) {
			console.error('Spec renderer error:', error);
			status = `Error: ${error.message}`;
		}

		return () => {
			handle1?.destroy();
			handle2?.destroy();
			handle3?.destroy();
		};
	});
</script>

<div style="padding: 20px; max-width: 1200px; margin: 0 auto;">
	<h1>Spec Renderer Test</h1>
	<p>Status: {status}</p>

	<h2>Test 1: Dot Plot (from spec)</h2>
	<div bind:this={dotContainer}></div>

	<h2>Test 2: Bar Chart with Aggregate (shared coordinator)</h2>
	<div bind:this={barContainer}></div>

	<h2>Test 3: hconcat Layout</h2>
	<div bind:this={hconcatContainer}></div>
</div>
