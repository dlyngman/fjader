<div class="wrapper">
	<h1>DivePlot Demos</h1>

	<section>
		<h2>Marks</h2>
		<div class="grid">
			<a class="card" href="/bar_chart">
				<div class="route">/bar_chart</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						BarMarkX, BarMarkY
					</div>
					<div class="col">
						<span class="label">Description</span>
						GPU color scale modes, stacking, normalize, range bars
					</div>
				</div>
			</a>
			<a class="card" href="/line_chart">
				<div class="route">/line_chart</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						LineMark
					</div>
					<div class="col">
						<span class="label">Description</span>
						Multi-series lines, gap handling, stroke width, color by series
					</div>
				</div>
			</a>
			<a class="card" href="/histogram">
				<div class="route">/histogram</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						RectYMark
					</div>
					<div class="col">
						<span class="label">Description</span>
						Histogram via bin() + count(), penguins and travelers datasets
					</div>
				</div>
			</a>
			<a class="card" href="/zero-baseline-test">
				<div class="route">/zero-baseline-test</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						BarMarkY
					</div>
					<div class="col">
						<span class="label">Description</span>
						Zero baseline: negative-only, mixed, positive-only values
					</div>
				</div>
			</a>
		</div>
	</section>

	<section>
		<h2>Scales</h2>
		<div class="grid">
			<a class="card" href="/color_scale_test">
				<div class="route">/color_scale_test</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						DotsMark, BarMarkY
					</div>
					<div class="col">
						<span class="label">Description</span>
						Categorical vs continuous color scales, scheme gallery
					</div>
				</div>
			</a>
			<a class="card" href="/time_scale_test">
				<div class="route">/time_scale_test</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						DotsMark
					</div>
					<div class="col">
						<span class="label">Description</span>
						Time scale axis formatting with synthetic hourly data
					</div>
				</div>
			</a>
			<a class="card" href="/test_scale_conf">
				<div class="route">/test_scale_conf</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						<em>utility</em>
					</div>
					<div class="col">
						<span class="label">Description</span>
						Scale config resolution testing, band padding/alignment
					</div>
				</div>
			</a>
		</div>
	</section>

	<section>
		<h2>Layout & Grid</h2>
		<div class="grid">
			<a class="card" href="/scatter_plot_matrix">
				<div class="route">/scatter_plot_matrix</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						DotsMark, BarMarkX, BarMarkY
					</div>
					<div class="col">
						<span class="label">Description</span>
						Small multiples grid, dynamic rows/columns, column selector
					</div>
				</div>
			</a>
			<a class="card" href="/grid_test">
				<div class="route">/grid_test</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						DotsMark, Grid
					</div>
					<div class="col">
						<span class="label">Description</span>
						Hybrid GPU/SVG grid, zero-lag movement at 120fps
					</div>
				</div>
			</a>
		</div>
	</section>

	<section>
		<h2>Interactors</h2>
		<div class="grid">
			<a class="card" href="/brush-demo">
				<div class="route">/brush-demo</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						DotsMark, BarMarkY, Interval2D
					</div>
					<div class="col">
						<span class="label">Description</span>
						Cross-chart brushing, 2D interval selection, filter chips
					</div>
				</div>
			</a>
		</div>
	</section>

	<section>
		<h2>Transforms</h2>
		<div class="grid">
			<a class="card" href="/transform-test">
				<div class="route">/transform-test</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						DotsMark, BarMarkX
					</div>
					<div class="col">
						<span class="label">Description</span>
						bin, filter (SQL) + topN, normalize, stack (JS)
					</div>
				</div>
			</a>
		</div>
	</section>

	<section>
		<h2>Mosaic Examples</h2>
		<div class="grid">
			<a class="card" href="/mosaic_examples/airline_travelers">
				<div class="route">/mosaic_examples/airline_travelers</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						LineMark, DotsMark
					</div>
					<div class="col">
						<span class="label">Description</span>
						Line chart with overlaid dots, multiple series
					</div>
				</div>
			</a>
			<a class="card" href="/mosaic_examples/flights_200k">
				<div class="route">/mosaic_examples/flights_200k</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						RectYMark, IntervalX
					</div>
					<div class="col">
						<span class="label">Description</span>
						Three coordinated histograms with cross-filtering, 200k rows
					</div>
				</div>
			</a>
			<a class="card" href="/mosaic_examples/weather">
				<div class="route">/mosaic_examples/weather</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						...
					</div>
					<div class="col">
						<span class="label">Description</span>
						Sync view
					</div>
				</div>
			</a>
		</div>
	</section>

	<section>
		<h2>Integration</h2>
		<div class="grid">
			<a class="card" href="/flights_200k">
				<div class="route">/flights_200k</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						DotsMark, RectYMark, IntervalX
					</div>
					<div class="col">
						<span class="label">Description</span>
						Scatter + histogram with cross-filtering, aggregated color
					</div>
				</div>
			</a>
			<a class="card" href="/performance-demo">
				<div class="route">/performance-demo</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						DotsMark
					</div>
					<div class="col">
						<span class="label">Description</span>
						FPS tracking, GPU debug tools, dynamic chart count
					</div>
				</div>
			</a>
		</div>
	</section>

	<section>
		<h2>Data Internals</h2>
		<div class="grid">
			<a class="card" href="/test/flechette-structure">
				<div class="route">/test/flechette-structure</div>
				<div class="cols">
					<div class="col">
						<span class="label">Components</span>
						<em>utility</em>
					</div>
					<div class="col">
						<span class="label">Description</span>
						Arrow IPC dictionary encoding inspection, DuckDB ENUM structure
					</div>
				</div>
			</a>
		</div>
	</section>
</div>

<style>
	.wrapper {
		max-width: 1000px;
		margin: 0 auto;
		padding: 1rem;
	}

	h1 {
		margin-bottom: 2rem;
	}

	section {
		margin-bottom: 2rem;
	}

	h2 {
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #888;
		margin-bottom: 0.5rem;
	}

	.grid {
		display: flex;
		flex-direction: column;
		gap: 1px;
		background: #e8e8e8;
		border-radius: 6px;
		overflow: hidden;
	}

	.card {
		display: block;
		background: #fafafa;
		padding: 0.6rem 0.8rem;
		text-decoration: none;
		color: inherit;
	}

	.card:hover {
		background: #f0f0f0;
	}

	.route {
		font-family: monospace;
		font-weight: 600;
		font-size: 0.95rem;
		color: #1a1a1a;
		margin-bottom: 0.3rem;
	}

	.cols {
		display: grid;
		grid-template-columns: 1fr 2fr;
		gap: 1rem;
	}

	.col {
		font-size: 0.82rem;
		color: #555;
		line-height: 1.4;
	}

	.label {
		display: block;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #aaa;
		margin-bottom: 0.1rem;
	}

	em {
		color: #999;
	}
</style>
