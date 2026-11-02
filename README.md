# fjader

An experimental charting library for Svelte and Python with a declarative, grammar-of-graphics API, that queries DuckDB and renders with WebGPU. It is not feature complete, and the API may still change.

fjader builds on the ideas of [Mosaic](https://github.com/uwdata/mosaic): charts are described as marks whose data comes from SQL queries run in DuckDB, and linked charts filter each other through selections. Its marks and channels borrow from [Observable Plot](https://observablehq.com/plot/), but the API is its own and not compatible with Plot's. Query results arrive as Arrow and are drawn with WebGPU.

There are three ways to use it: Svelte components; a JSON spec, rendered from JavaScript with `Fjader.render(element, spec)`; and a Python package that builds specs and renders them in Jupyter, marimo or Streamlit.

The name comes from Swedish _fjäder_ (say "fyeh-der"), which means both spring and feather.

## Install

```bash
npm install fjader @uwdata/mosaic-sql   # Svelte 5 components, and the SQL builder the examples use
pip install fjader                 # Python: marimo and Jupyter
pip install "fjader[streamlit]"    # Python: Streamlit
```

fjader needs Chrome 149 or later, or another Chromium browser on that version. It relies on two recent features other browsers don't ship yet: WebGPU's `immediate_address_space`, through which every chart passes its scales to the shaders (so every zoom and pan uses it), and the `Temporal` API, used for calendar offsets. There is no fallback renderer.

Three things to know before using it in a deployed app:

- **Data goes to the browser in full.** The Python widget and the Streamlit component send every column of a DataFrame to the browser, where DuckDB-WASM queries it. Anyone viewing the app can extract it, so pass only the columns you mean to show. In Jupyter, saved widget state can also store the data in the notebook file.
- **DuckDB-WASM loads from jsDelivr at runtime.** The browser fetches it from the CDN, so locked-down networks that block it cannot render charts.
- **Specs are trusted input.** A spec's `{ "sql": "…" }` field runs as raw SQL in the viewer's DuckDB-WASM. Don't build specs from untrusted input.

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
	import { onMount } from 'svelte';

	const { queryEngine } = initFjader();
	let loaded = $state(false);

	// DuckDB-WASM fetches only full URLs; a bare path means its own file system.
	onMount(async () => {
		const url = new URL('/data/penguins.parquet', location.href).href;
		await queryEngine.exec([loadParquet('penguins', url).toString()]);
		loaded = true;
	});
</script>

{#if loaded}
	<div style="height: 400px">
		<ChartContainer xLabel="island" yLabel="count">
			{#snippet background()}
				<AxisLeft />
				<AxisBottom />
			{/snippet}
			{#snippet canvas()}
				<WebGPUCanvas>
					{#snippet canvasComponents()}
						<Grid />
						<BarMarkY
							table="penguins"
							x="island"
							y={count()}
							fill="species"
							transforms={[stack()]}
						/>
					{/snippet}
				</WebGPUCanvas>
			{/snippet}
		</ChartContainer>
	</div>
{/if}
```

A chart is a container with layers: axes in the background, marks on the GPU canvas. It fills its parent, so give the parent a height; the Python widget and Streamlit set one for you (400 and 500 px). The same chart can be written as a JSON spec and rendered with `Fjader.render(element, spec)`; the npm package ships Svelte source, so this needs a build that compiles Svelte, such as Vite with the Svelte plugin.

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

Charts display on their own in marimo and Jupyter; in Streamlit, call `fj.streamlit.render(chart)`. polars DataFrames need nothing more; pandas ones need pyarrow (`pip install "fjader[pyarrow]"`). Marks compose: `*` overlays two marks in one chart, `+` places charts side by side, and `df.fj.dot(x=..., y=...)` works straight from a pandas or polars DataFrame.

## How it works

**Queries.** Aggregation, binning, filtering, top-N, stacking and normalization compile to SQL and run in DuckDB-WASM in the browser. What reaches JavaScript is sized by the chart, not by the data.

**Selections.** As in Mosaic, brushes crossfilter the other charts, and pre-aggregated tables binned at pixel resolution keep brushing fast. fjader builds them on the first hover over a chart.

**Marks.** Charts are built from marks (dots, bars, rects, lines, areas, rules, text, parallel coordinates). Marks declare the scales they need, and charts sharing a variable share its scale.

**Rendering.** WebGPU shaders draw the marks. A fixed-timestep spring simulation animates domain changes and transitions between states. Level-of-detail rungs move between dots, bins and smoothed density; shift+scroll moves through them.

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

The Python package's widget and Streamlit bundles are build output and not in git. In a checkout, run `npm run build:all` before using the Python package, and again after changing JavaScript code.

The pages under `src/routes/` are development and test pages for working on fjader, not documentation. They read the example data that `npm run fetch-data` downloads.

## Acknowledgements

fjader takes ideas from two projects, and in places code from Mosaic:

- **[Mosaic](https://github.com/uwdata/mosaic)**, by the UW Interactive Data Lab. fjader began as a Mosaic client, with `@uwdata/mosaic-core` as a dependency, and its query layer still follows Mosaic's design: pre-aggregation with sufficient statistics and the crossfilter selection model. The API, interactors and JSON spec layout are modeled on vgplot's, without being compatible with it. As fjader moved to rendering directly in WebGPU, it needed its queries tied more closely to its marks: results shaped for GPU buffers, query timing coupled to interaction frames, and state that follows Svelte 5's reactivity rather than a callback protocol. So it replaced `mosaic-core` with its own query layer, adapted from Mosaic's, and still builds every query with `@uwdata/mosaic-sql`.
- **[Observable Plot](https://github.com/observablehq/plot)**, by Observable. Mark names, channel shorthands, stacking conventions and many defaults are modeled on Plot's.

Mosaic is described in Jeffrey Heer and Dominik Moritz, [_Mosaic: An Architecture for Scalable & Interoperable Data Views_](https://idl.uw.edu/papers/mosaic), IEEE Transactions on Visualization and Computer Graphics 30 (Proc. VIS 2023), 2024, [doi:10.1109/TVCG.2023.3327189](https://doi.org/10.1109/TVCG.2023.3327189).

It also rests on [DuckDB](https://duckdb.org) and [DuckDB-WASM](https://github.com/duckdb/duckdb-wasm), [Flechette](https://github.com/uwdata/flechette), [d3](https://d3js.org) and [Svelte](https://svelte.dev).

## License

BSD 3-Clause. See [LICENSE](https://github.com/dlyngman/fjader/blob/main/LICENSE), which also reproduces the licenses of Mosaic and Observable Plot in full. The Python package's bundled JavaScript ships with a `THIRD_PARTY_LICENSES.txt` covering every package compiled into it.
