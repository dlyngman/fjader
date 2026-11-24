<script>
	import { count, avg, sum, min, max } from '@uwdata/mosaic-sql';
	import {
		ChartContainer,
		Grid,
		AxisLeft,
		AxisBottom,
		MarginLabel,
		Crosshair,
		DotsMark,
		BarMarkY,
		LineMark,
		AreaMarkY,
		RectYMark
	} from '$lib/components';
</script>

<div class="page">
	<h1>tip prop test</h1>
	<p class="subtitle">Hover each chart to verify tooltip field control</p>

	<div class="grid">
		<!-- 1. Default (no tip) — shows all channels -->
		<section>
			<h2>DotsMark &mdash; default (no tip)</h2>
			<p class="desc">Should show all channels: bill_length, body_mass, species</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="bill_length" yLabel="body_mass">
					<MarginLabel />
					<Grid />
					<DotsMark table="penguins" x="bill_length" y="body_mass" fill="species" />
					<Crosshair />
				</ChartContainer>
			</div>
		</section>

		<!-- 2. tip with channel shorthand + extra fields -->
		<section>
			<h2>DotsMark &mdash; tip={'{["x", "fill", "island", "sex"]}'}</h2>
			<p class="desc">Should show: bill_length, species, island, sex (no body_mass)</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="bill_length" yLabel="body_mass">
					<MarginLabel />
					<Grid />
					<DotsMark
						table="penguins"
						x="bill_length"
						y="body_mass"
						fill="species"
						tip={['x', 'fill', 'island', 'sex']}
					/>
					<Crosshair />
				</ChartContainer>
			</div>
		</section>

		<!-- 3. tip with * wildcard + extras -->
		<section>
			<h2>DotsMark &mdash; tip={'{["*", "island"]}'}</h2>
			<p class="desc">Should show: all channels (bill_length, body_mass, species) + island</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="bill_length" yLabel="body_mass">
					<MarginLabel />
					<Grid />
					<DotsMark
						table="penguins"
						x="bill_length"
						y="body_mass"
						fill="species"
						tip={['*', 'island']}
					/>
					<Crosshair />
				</ChartContainer>
			</div>
		</section>

		<!-- 4. tip={false} — disabled -->
		<section>
			<h2>DotsMark &mdash; tip={'{false}'}</h2>
			<p class="desc">Should show NO tooltip on hover</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="bill_length" yLabel="body_mass">
					<MarginLabel />
					<Grid />
					<DotsMark table="penguins" x="bill_length" y="body_mass" fill="species" tip={false} />
					<Crosshair />
				</ChartContainer>
			</div>
		</section>

		<!-- 5. BarMarkY with tip filtering + 'y' alias -->
		<section>
			<h2>BarMarkY &mdash; tip={'{["x", "y"]}'}</h2>
			<p class="desc">
				Should show: species, count (no color field). 'y' aliases to 'y2' for range marks.
			</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="species" yLabel="count">
					<MarginLabel />
					<Grid />
					<BarMarkY table="penguins" x="species" y={count()} fill="species" tip={['x', 'y']} />
					<Crosshair />
				</ChartContainer>
			</div>
		</section>

		<!-- 6. LineMark with tip extras -->
		<section>
			<h2>LineMark &mdash; tip={'{["x", "y", "country"]}'}</h2>
			<p class="desc">Should show: month, revenue, country (extra field from DB)</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="month" yLabel="revenue">
					<MarginLabel />
					<Grid />
					<LineMark
						table="sales"
						x="month"
						y="revenue"
						stroke="region"
						tip={['x', 'y', 'country']}
					/>
					<Crosshair />
				</ChartContainer>
			</div>
		</section>
		<!-- 7. LineMark with aggregate expressions in tip (lazy tooltip fields) -->
		<section>
			<h2>LineMark — tip with aggregate expressions</h2>
			<p class="desc">
				Should show: species, avg(body_mass), min(body_mass), max(body_mass). The min/max are
				computed lazily in the tooltip query only (Path A, no JS transforms).
			</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="species" yLabel="body_mass">
					<MarginLabel />
					<Grid />
					<LineMark
						table="penguins"
						x="bill_length"
						y={avg('body_mass')}
						stroke="species"
						tooltipProximity="x"
						tip={['x', 'stroke', 'y', min('body_mass'), max('body_mass')]}
					/>
					<Crosshair />
				</ChartContainer>
			</div>
		</section>
		<!-- 8. BarMarkY with tip extras (Path B — has implicit stack JS transform) -->
		<section>
			<h2>BarMarkY — tip with aggregate expressions (Path B)</h2>
			<p class="desc">
				Should show: species, avg(body_mass), min(body_mass), max(body_mass). Uses sidecar query
				since BarMarkY has implicit stack (JS transform → Path B).
			</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="species" yLabel="body_mass">
					<MarginLabel />
					<Grid />
					<BarMarkY
						table="penguins"
						x="species"
						y={avg('body_mass')}
						fill="species"
						tip={['x', 'fill', 'y', min('body_mass'), max('body_mass')]}
					/>
					<Crosshair />
				</ChartContainer>
			</div>
		</section>
		<!-- 9. RectYMark with labeled tip expressions (implicit SQL stack, #131) -->
		<section>
			<h2>RectYMark — labeled tip expressions on an implicit stack</h2>
			<p class="desc">
				Should show: start, end, y, Rate (the average of four regions) and N = 4. No "Failed to
				merge tip extras" warning in the console.
			</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="month" yLabel="avg revenue">
					<MarginLabel />
					<Grid />
					<RectYMark
						table="spans"
						x1="start"
						x2="end"
						y={avg('v')}
						tip={['*', { value: avg('v'), label: 'Rate' }, { value: count(), label: 'N' }]}
					/>
					<Crosshair />
				</ChartContainer>
			</div>
		</section>
		<!-- 10. DotsMark with labeled plain columns (#133) -->
		<section>
			<h2>DotsMark — labeled plain columns</h2>
			<p class="desc">
				Should show: Bill length (the x channel), Species (the fill channel) and Island (a column
				not in any channel), each under its label.
			</p>
			<div class="chart-wrapper">
				<ChartContainer xLabel="bill_length" yLabel="body_mass">
					<MarginLabel />
					<Grid />
					<DotsMark
						table="penguins"
						x="bill_length"
						y="body_mass"
						fill="species"
						tip={[
							{ value: 'x', label: 'Bill length' },
							{ value: 'species', label: 'Species' },
							{ value: 'island', label: 'Island' }
						]}
					/>
					<Crosshair />
				</ChartContainer>
			</div>
		</section>
	</div>
</div>

<style>
	.page {
		max-width: 1200px;
		margin: 0 auto;
		padding: 1.5rem;
	}

	h1 {
		font-size: 1.4rem;
		margin: 0 0 0.25rem 0;
	}

	.subtitle {
		color: #666;
		margin: 0 0 1.5rem 0;
		font-size: 0.9rem;
	}

	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
	}

	section {
		min-width: 0;
	}

	h2 {
		font-size: 0.85rem;
		font-family: monospace;
		margin: 0 0 0.25rem 0;
		font-weight: 600;
	}

	.desc {
		font-size: 0.8rem;
		color: #888;
		margin: 0 0 0.5rem 0;
	}

	.chart-wrapper {
		width: 100%;
		aspect-ratio: 4/3;
		min-height: 250px;
		max-height: 400px;
		position: relative;
		border: 1px solid #ddd;
		border-radius: 6px;
		overflow: hidden;
	}
</style>
