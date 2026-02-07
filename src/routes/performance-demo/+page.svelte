<!-- src/routes/performance-demo/+page.svelte -->
<script>
	import { Coordinator, wasmConnector } from '@uwdata/mosaic-core';
	import { loadParquet } from '@uwdata/mosaic-sql';
	import { setCoordinators } from '$lib';
	import { onMount, setContext } from 'svelte';
	import {
		ChartContainer,
		WebGPUCanvas,
		DotsMark,
		// BarMark,
		Grid,
		AxisLeft,
		AxisBottom,
		Crosshair
	} from '$lib/components';
	import Frame from '$lib/components/background/Frame.svelte';

	// ✅ Initialize enhanced coordination
	console.log('🚀 Initializing enhanced coordination for performance demo...');
	const coordinators = setCoordinators({
		msaaSampleCount: 4,
		enableDebugging: false
	});

	// State management
	let mosaicCoordinator;
	let isLoaded = $state(false);
	let loadError = $state(null);
	let performanceReport = $state(null);
	let isMonitoring = $state(false);
	let monitoringDuration = $state(0);
	let monitoringInterval = null;

	// Configuration for testing different scenarios
	let chartCount = $state(4);
	let dataPoints = $state(1000);
	let enableAnimations = $state(true);
	let markType = $state('dots'); // 'dots' or 'bars'

	// Chart configurations - dynamically generated
	let chartConfigs = $derived(generateChartConfigs(chartCount, markType));

	function generateChartConfigs(count, type) {
		const configs = [];
		const variables = ['bill_length', 'bill_depth', 'flipper_length', 'body_mass'];

		for (let i = 0; i < count; i++) {
			const xVar = variables[i % variables.length];
			const yVar = variables[(i + 1) % variables.length];

			configs.push({
				id: `chart-${i}`,
				x: xVar,
				y: yVar,
				title: `${xVar} vs ${yVar}`,
				markType: type
			});
		}

		return configs;
	}

	onMount(async () => {
		try {
			// Initialize Mosaic
			const wasm = wasmConnector();
			mosaicCoordinator = new Coordinator();
			mosaicCoordinator.databaseConnector(wasm);
			setContext('mosaic-coordinator', mosaicCoordinator);

			await mosaicCoordinator.exec(
				loadParquet('penguins', `${window.location.origin}/data/penguins.parquet`)
			);

			isLoaded = true;

			// Setup automatic debugging info
			setTimeout(() => {
				console.log('\n🔍 Performance Monitoring Guide:');
				console.log('1. Basic monitoring: Use the buttons below');
				console.log('2. Manual commands: Try the console commands');
				console.log('3. Adjust settings and re-test for comparison');
				console.log('\n📊 Available Commands:');
				console.log('DivePlotDebug.performance.startMonitoring()');
				console.log('DivePlotDebug.performance.stopMonitoring()');
				console.log('DivePlotDebug.gpu().quickStats()');
				console.log('DivePlotDebug.gpu().analyzeResourceSharing()');
			}, 1000);
		} catch (error) {
			console.error('❌ Initialization error:', error);
			loadError = error.message;
		}
	});

	// Performance monitoring functions
	function startMonitoring() {
		if (typeof window === 'undefined' || !window.DivePlotDebug) {
			alert("Debug tools not available. Make sure you're in development mode.");
			return;
		}

		console.log('\n🚀 Starting Performance Monitoring Session');
		console.log('📋 Current Configuration:');
		console.log(`  Charts: ${chartCount}`);
		console.log(`  Mark Type: ${markType}`);
		console.log(`  Data Points: ${dataPoints}`);
		console.log('📝 Instructions:');
		console.log('  1. Interact with the charts (pan, zoom, hover)');
		console.log('  2. Try different interactions for 20-30 seconds');
		console.log('  3. Click "Stop Monitoring" to see results');

		window.DivePlotDebug.performance.startMonitoring();
		isMonitoring = true;
		monitoringDuration = 0;

		// Update duration counter
		monitoringInterval = setInterval(() => {
			monitoringDuration++;
		}, 1000);
	}

	function stopMonitoring() {
		if (typeof window === 'undefined' || !window.DivePlotDebug) {
			alert('Debug tools not available.');
			return;
		}

		console.log('\n🏁 Stopping Performance Monitoring...');

		const report = window.DivePlotDebug.performance.stopMonitoring();
		performanceReport = report;
		isMonitoring = false;

		if (monitoringInterval) {
			clearInterval(monitoringInterval);
			monitoringInterval = null;
		}

		// Provide interpretation of results
		setTimeout(() => {
			console.log('\n🎯 Quick Interpretation:');
			if (report && report.avgFPS >= 60) {
				console.log('✅ Excellent: Your setup is performing very well!');
			} else if (report && report.avgFPS >= 30) {
				console.log('⚠️ Good: Performance is acceptable but could be optimized');
				console.log('💡 Try: Reduce chart count or data points');
			} else {
				console.log('❌ Poor: Performance needs attention');
				console.log(
					'💡 Try: Check GPU coordination with DivePlotDebug.gpu().analyzeResourceSharing()'
				);
			}
		}, 500);
	}

	function showGPUStats() {
		if (typeof window === 'undefined' || !window.DivePlotDebug) {
			alert('Debug tools not available.');
			return;
		}

		console.log('\n🔧 Showing GPU Coordination Stats...');
		window.DivePlotDebug.gpu().quickStats();

		setTimeout(() => {
			console.log('\n💡 What to look for:');
			console.log('• Shared Pipelines > 0: Resource sharing is working');
			console.log('• Higher Mark Type Batches: More efficient rendering');
			console.log('• Resource sharing efficiency: Should be "Good" or "Excellent"');
		}, 100);
	}

	function analyzeResourceSharing() {
		if (typeof window === 'undefined' || !window.DivePlotDebug) {
			alert('Debug tools not available.');
			return;
		}

		console.log('\n🔍 Analyzing Resource Sharing...');
		window.DivePlotDebug.gpu().analyzeResourceSharing();

		setTimeout(() => {
			console.log('\n💡 Analysis Tips:');
			console.log('• References > 1: Good sharing between charts');
			console.log('• Memory savings > 50%: Excellent efficiency');
			console.log('• If no shared resources: Charts might not be using same mark types');
		}, 100);
	}

	function runQuickBenchmark() {
		if (typeof window === 'undefined' || !window.DivePlotDebug?.benchmark) {
			alert('Benchmark tools not available.');
			return;
		}

		console.log('\n🏃‍♂️ Running Quick Benchmark (10 seconds)...');
		console.log('📋 This will test performance automatically');

		window.DivePlotDebug.benchmark.quick().then((results) => {
			console.log('\n🎯 Benchmark Complete!');
			console.log('📊 Check the detailed results above');
		});
	}

	function demonstratePerformanceScenarios() {
		console.log('\n🎭 Performance Scenario Demonstration');
		console.log('📋 Try these scenarios to see different performance characteristics:');
		console.log('');
		console.log('🚀 Scenario 1: Optimal Performance');
		console.log('  • Charts: 2-4');
		console.log('  • Mark Type: dots');
		console.log('  • Expected: >60 FPS, high resource sharing');
		console.log('');
		console.log('⚠️ Scenario 2: Moderate Load');
		console.log('  • Charts: 6-8');
		console.log('  • Mark Type: dots');
		console.log('  • Expected: 30-60 FPS, good resource sharing');
		console.log('');
		console.log('🔥 Scenario 3: Stress Test');
		console.log('  • Charts: 10+');
		console.log('  • Mark Type: mix dots/bars');
		console.log('  • Expected: <30 FPS, multiple resource types');
		console.log('');
		console.log('💡 Adjust the settings above and test each scenario!');
	}
</script>

<div class="performance-demo">
	{#if loadError}
		<div class="error">
			<h3>❌ Initialization Failed</h3>
			<p>{loadError}</p>
		</div>
	{:else if !isLoaded}
		<div class="loading">
			<h3>⏳ Loading...</h3>
			<p>Initializing enhanced coordination and loading data...</p>
		</div>
	{:else}
		<!-- Performance Control Panel -->
		<div class="control-panel">
			<h2>🔧 Performance Monitoring Demo</h2>

			<div class="controls-section">
				<h3>📊 Test Configuration</h3>
				<div class="controls-grid">
					<div class="control-group">
						<label>Chart Count: {chartCount}</label>
						<input type="range" min="1" max="12" bind:value={chartCount} />
					</div>

					<div class="control-group">
						<label>Mark Type:</label>
						<select bind:value={markType}>
							<option value="dots">Dots (Scatterplot)</option>
							<option value="bars">Bars (Bar Chart)</option>
						</select>
					</div>

					<div class="control-group">
						<label>Data Points: {dataPoints}</label>
						<input type="range" min="100" max="5000" step="100" bind:value={dataPoints} />
					</div>
				</div>
			</div>

			<div class="controls-section">
				<h3>🚀 Performance Monitoring</h3>
				<div class="button-grid">
					<button onclick={startMonitoring} disabled={isMonitoring} class="primary">
						{isMonitoring ? `Monitoring... (${monitoringDuration}s)` : 'Start Monitoring'}
					</button>

					<button onclick={stopMonitoring} disabled={!isMonitoring}> Stop Monitoring </button>

					<button onclick={showGPUStats}> GPU Stats </button>

					<button onclick={analyzeResourceSharing}> Analyze Resources </button>

					<button onclick={runQuickBenchmark}> Quick Benchmark </button>

					<button onclick={demonstratePerformanceScenarios}> Show Scenarios </button>
				</div>
			</div>

			{#if performanceReport}
				<div class="performance-summary">
					<h3>📈 Last Performance Report</h3>
					<div class="metrics-grid">
						<div class="metric">
							<span class="label">Average FPS:</span>
							<span
								class="value"
								class:good={performanceReport.avgFPS >= 60}
								class:warning={performanceReport.avgFPS >= 30 && performanceReport.avgFPS < 60}
								class:poor={performanceReport.avgFPS < 30}
							>
								{performanceReport.avgFPS.toFixed(1)}
							</span>
						</div>
						<div class="metric">
							<span class="label">Frame Time:</span>
							<span class="value">{performanceReport.avgFrameTime.toFixed(2)}ms</span>
						</div>
						<div class="metric">
							<span class="label">Max Frame Time:</span>
							<span class="value">{performanceReport.maxFrameTime.toFixed(2)}ms</span>
						</div>
						<div class="metric">
							<span class="label">Duration:</span>
							<span class="value">{(performanceReport.duration / 1000).toFixed(1)}s</span>
						</div>
					</div>
				</div>
			{/if}

			<div class="instructions">
				<h3>📋 How to Use Performance Monitoring</h3>
				<ol>
					<li>
						<strong>Adjust Configuration:</strong> Change chart count, mark type, and data points above
					</li>
					<li>
						<strong>Start Monitoring:</strong> Click "Start Monitoring" to begin tracking performance
					</li>
					<li>
						<strong>Interact with Charts:</strong> Pan, zoom, and hover over the charts below for 20-30
						seconds
					</li>
					<li>
						<strong>Stop & Analyze:</strong> Click "Stop Monitoring" to see comprehensive results in
						console
					</li>
					<li>
						<strong>Check GPU Efficiency:</strong> Use "GPU Stats" and "Analyze Resources" buttons
					</li>
					<li>
						<strong>Compare Scenarios:</strong> Try different configurations and compare results
					</li>
				</ol>

				<div class="console-tip">
					💡 <strong>Pro Tip:</strong> Open your browser console (F12) to see detailed reports and analysis!
				</div>
			</div>
		</div>

		<!-- Charts Grid -->
		<div class="charts-container" style="--chart-count: {Math.min(chartCount, 4)}">
			{#each chartConfigs as config (config.id)}
				<div class="chart-wrapper">
					<h4>{config.title}</h4>

					<ChartContainer xLabel={config.x} yLabel={config.y}>
						{#snippet background()}
							<Grid />
							<Frame />
							<AxisLeft />
							<AxisBottom />
						{/snippet}

						{#snippet canvas()}
							<WebGPUCanvas>
								{#snippet canvasComponents()}
									{#if config.markType === 'dots'}
										<DotsMark
											table="penguins"
											x={config.x}
											y={config.y}
											color="species"
											alpha={0.7}
											radius={3}
										/>
									{:else if config.markType === 'bars'}
										<BarMark table="penguins" x={config.x} y={config.y} alpha={0.8} />
									{/if}
								{/snippet}
							</WebGPUCanvas>
						{/snippet}

						{#snippet foreground()}
							<Crosshair />
						{/snippet}
					</ChartContainer>
				</div>
			{/each}
		</div>

		<!-- Console Commands Reference -->
		<div class="console-reference">
			<h3>🖥️ Console Commands Reference</h3>
			<div class="commands-grid">
				<div class="command-group">
					<h4>Basic Performance</h4>
					<code>DivePlotDebug.performance.startMonitoring()</code>
					<code>DivePlotDebug.performance.stopMonitoring()</code>
					<code>DivePlotDebug.performance.getStats()</code>
				</div>

				<div class="command-group">
					<h4>GPU Coordination</h4>
					<code>DivePlotDebug.gpu().quickStats()</code>
					<code>DivePlotDebug.gpu().analyzeResourceSharing()</code>
					<code>DivePlotDebug.gpu().debugChart('chart-id')</code>
				</div>

				<div class="command-group">
					<h4>Benchmarking</h4>
					<code>DivePlotDebug.benchmark.quick()</code>
					<code>DivePlotDebug.benchmark.full()</code>
				</div>

				<div class="command-group">
					<h4>Help & Utils</h4>
					<code>DivePlotDebug.help()</code>
					<code>DivePlotErrorUtils.simulate.webgpuNotSupported()</code>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.performance-demo {
		max-width: 1400px;
		margin: 0 auto;
		padding: 20px;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	}

	.control-panel {
		background: #f8f9fa;
		border: 1px solid #dee2e6;
		border-radius: 8px;
		padding: 24px;
		margin-bottom: 24px;
	}

	.controls-section {
		margin-bottom: 24px;
	}

	.controls-section h3 {
		margin: 0 0 16px 0;
		color: #495057;
	}

	.controls-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 16px;
	}

	.control-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.control-group label {
		font-weight: 600;
		color: #495057;
		font-size: 14px;
	}

	.control-group input,
	.control-group select {
		padding: 8px;
		border: 1px solid #ced4da;
		border-radius: 4px;
		font-size: 14px;
	}

	.button-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 12px;
	}

	button {
		padding: 12px 16px;
		border: 1px solid #dee2e6;
		border-radius: 6px;
		background: white;
		cursor: pointer;
		font-size: 14px;
		font-weight: 500;
		transition: all 0.2s;
	}

	button:hover:not(:disabled) {
		background: #e9ecef;
		border-color: #adb5bd;
	}

	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	button.primary {
		background: #007bff;
		color: white;
		border-color: #007bff;
	}

	button.primary:hover:not(:disabled) {
		background: #0056b3;
		border-color: #0056b3;
	}

	.performance-summary {
		background: white;
		border: 1px solid #dee2e6;
		border-radius: 6px;
		padding: 16px;
		margin-top: 16px;
	}

	.metrics-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 16px;
		margin-top: 12px;
	}

	.metric {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid #f1f3f4;
	}

	.metric .label {
		font-weight: 500;
		color: #495057;
	}

	.metric .value {
		font-weight: 600;
		font-family: 'Courier New', monospace;
	}

	.metric .value.good {
		color: #28a745;
	}
	.metric .value.warning {
		color: #ffc107;
	}
	.metric .value.poor {
		color: #dc3545;
	}

	.instructions {
		background: #e7f3ff;
		border: 1px solid #b3d7ff;
		border-radius: 6px;
		padding: 20px;
		margin-top: 16px;
	}

	.instructions h3 {
		margin: 0 0 16px 0;
		color: #0056b3;
	}

	.instructions ol {
		margin: 0;
		padding-left: 20px;
	}

	.instructions li {
		margin-bottom: 8px;
		line-height: 1.5;
	}

	.console-tip {
		background: #fff3cd;
		border: 1px solid #ffeaa7;
		border-radius: 4px;
		padding: 12px;
		margin-top: 16px;
		font-size: 14px;
	}

	.charts-container {
		display: grid;
		grid-template-columns: repeat(var(--chart-count, 2), 1fr);
		gap: 20px;
		margin: 24px 0;
	}

	.chart-wrapper {
		border: 1px solid #dee2e6;
		border-radius: 8px;
		padding: 16px;
		background: white;
	}

	.chart-wrapper h4 {
		margin: 0 0 16px 0;
		font-size: 16px;
		color: #495057;
	}

	.chart-wrapper :global(.chart-container) {
		width: 100%;
		height: 300px;
	}

	.console-reference {
		background: #f8f9fa;
		border: 1px solid #dee2e6;
		border-radius: 8px;
		padding: 20px;
		margin-top: 24px;
	}

	.commands-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 20px;
		margin-top: 16px;
	}

	.command-group h4 {
		margin: 0 0 12px 0;
		color: #495057;
		font-size: 14px;
		font-weight: 600;
	}

	.command-group code {
		display: block;
		background: #343a40;
		color: #f8f9fa;
		padding: 8px 12px;
		border-radius: 4px;
		font-family: 'Courier New', monospace;
		font-size: 13px;
		margin-bottom: 6px;
		word-break: break-all;
	}

	.loading,
	.error {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 50vh;
		text-align: center;
	}

	.error {
		color: #d32f2f;
	}

	@media (max-width: 768px) {
		.controls-grid,
		.button-grid,
		.metrics-grid,
		.commands-grid {
			grid-template-columns: 1fr;
		}

		.charts-container {
			grid-template-columns: 1fr;
		}
	}
</style>
