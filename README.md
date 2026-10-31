# Fjäder

**Declarative, GPU-rendered charts for millions of rows, powered by DuckDB.**

_Fjäder_ (say "fyeh-der") is Swedish for both spring and feather: the springs that animate every chart, and the feathers that steer an Arrow.

You describe a chart in marks and channels. Fjäder compiles it to SQL that runs in DuckDB, moves only the aggregated result into the browser as Arrow, and draws it with WebGPU. Brushing, crossfiltering, pan and zoom stay interactive at 120 fps on datasets far beyond what an SVG or Canvas chart can hold.

If you know [Observable Plot](https://observablehq.com/plot/), you already know most of the API.

## Install

```bash
npm install fjader                 # Svelte 5 components
pip install "fjader[jupyter]"      # Python: Jupyter and marimo
pip install "fjader[streamlit]"    # Python: Streamlit
```

Fjäder needs a browser with WebGPU. There is no fallback renderer.

## Svelte

```svelte
<script>
	import {
		initFjader,
		ChartContainer,
		WebGPUCanvas,
		AxisLeft,
		AxisBottom,
		Grid,
		BarMarkY,
		stack
	} from 'fjader';
	import { count, loadParquet } from '@uwdata/mosaic-sql';

	const { queryEngine } = initFjader();
	const ready = queryEngine.exec([loadParquet('penguins', '/data/penguins.parquet').toString()]);
</script>

{#await ready then}
	<ChartContainer xLabel="island" yLabel="count">
		{#snippet background()}
			<AxisLeft />
			<AxisBottom />
		{/snippet}
		{#snippet canvas()}
			<WebGPUCanvas>
				{#snippet canvasComponents()}
					<Grid />
					<BarMarkY table="penguins" x="island" y={count()} fill="species" transforms={[stack()]} />
				{/snippet}
			</WebGPUCanvas>
		{/snippet}
	</ChartContainer>
{/await}
```

A chart is a container with layers: axes in the background, marks on the GPU canvas. Charts can also be rendered from a JSON spec, from any JavaScript, with `Fjader.render(element, spec)`.

## Python

```python
import polars as pl
import fjader as fj

weather = pl.read_parquet("seattle-weather.parquet")

fj.plot(
    fj.dot(data=weather, x="date", y="temp_max", fill="weather", r="precipitation"),
    x_label="Date",
    y_label="Max temperature (°F)",
)
```

Charts display on their own in Jupyter and marimo; in Streamlit, call `fj.streamlit.render(chart)`. Marks compose: `*` overlays two marks in one chart, `+` places charts side by side, and `df.fj.dot(x=..., y=...)` works straight from a pandas or polars DataFrame.

## How it works

**The database does the heavy lifting.** Aggregation, binning, filtering, top-N, stacking and normalization compile to SQL and run in DuckDB-WASM, or in a server-side DuckDB from Python. Only results sized by the screen, not by the data, reach JavaScript.

**Interactions stay instant.** Brushes crossfilter every other chart. On the first hover, Fjäder builds pre-aggregated tables binned at pixel resolution, so each brush frame reads a small table instead of rescanning the data.

**Marks compose.** Charts are built from marks (dots, bars, rects, lines, areas, rules, text, parallel coordinates), not chart types. Marks declare what scales they need, and charts sharing a variable share its scale.

**Everything renders on the GPU.** WebGPU shaders draw every mark. A fixed-timestep spring simulation animates domain changes, filters and morphs between states. Level-of-detail rungs move between dots, bins and smoothed density, and shift+scroll scrubs through them.

## Project structure

```
src/lib/
  components/     Marks, charts, axes, legends, interaction overlays
  query-engine/   DuckDB connection, crossfilter, pre-aggregation
  transforms/     Transform pipeline (SQL first, then JS)
  scales/         Scale requirements, resolution and shared scale state
  gpu/            GPUCoordinator, pipelines, shader libraries
  animation/      Spring physics and the fixed-timestep loop
  lod/            Level-of-detail rungs
  interactors/    Brushes, toggles, tooltips, pan and zoom
  spec/           JSON spec renderer and export
python/fjader/    Python API, Jupyter widget, Streamlit component
docs/             Design and implementation notes
```

## Development

```bash
npm install
npm run fetch-data       # Example datasets, from their upstream sources
npm run dev              # Dev server with examples and test routes
npm run build            # Production build
npm run lint             # ESLint + Prettier
npx vitest               # JavaScript tests
npm run build:python     # Widget and Streamlit bundles, then the Python wheel
```

## Acknowledgements

Fjäder owes a great deal to two projects:

- **[Mosaic](https://github.com/uwdata/mosaic)**, by the UW Interactive Data Lab. Fjäder started out on Mosaic and still builds every query with `@uwdata/mosaic-sql`. Its query layer adapts Mosaic's pre-aggregation with sufficient statistics, its crossfilter selection model and its REST connector protocol, and the API, interactors and JSON spec follow vgplot.
- **[Observable Plot](https://github.com/observablehq/plot)**, by Observable. The mark API, its channel shorthands, stacking conventions and many defaults follow Plot.

It also rests on [DuckDB](https://duckdb.org) and [DuckDB-WASM](https://github.com/duckdb/duckdb-wasm), [Flechette](https://github.com/uwdata/flechette), [d3](https://d3js.org) and [Svelte](https://svelte.dev).

## License

BSD 3-Clause. See [LICENSE](LICENSE), which also reproduces the licenses of Mosaic and Observable Plot in full. The Python package's bundled JavaScript ships with a `THIRD_PARTY_LICENSES.txt` covering every package compiled into it.
