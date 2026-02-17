# DivePlot

A high-performance data visualization library built with Svelte 5 and WebGPU, implementing a Grammar of Graphics architecture. Designed for interactive exploration of large datasets using DuckDB (via Mosaic) as the query engine.

## Quick Start

```bash
npm install
npm run dev
```

## Design Principles

**Database-first processing** — Heavy operations (aggregation, binning, filtering) run in DuckDB. Only small, aggregated results cross into JavaScript. Mosaic's PreAggregator provides instant cached results for repeated queries.

**Mark-based composition** — Visualizations are built from composable marks, not chart types. Marks declare scale requirements with priorities that get resolved automatically when multiple marks share a chart.

**GPU rendering** — WebGPU for all mark rendering. Shared pipelines, zero-GC interaction loops, and a fixed-timestep animation system targeting 120fps.

## Usage

```svelte
<script>
  import { ChartContainer, DotsMark, BarMarkY, LineMark } from 'diveplot';
  import { count, sum } from '@uwdata/mosaic-sql';
  import { filter, stack } from '$lib/transforms';
</script>

<ChartContainer xLabel="species" yLabel="count">
  <DotsMark table="penguins" x="bill_length" y="body_mass" color="species" />
</ChartContainer>

<ChartContainer xLabel="island" yLabel="count">
  <BarMarkY
    table="penguins"
    x="island"
    y={count()}
    color="species"
    transforms={[stack()]}
  />
</ChartContainer>
```

## Architecture

### Marks

Each mark is a Svelte component backed by `BaseMarkSetup`, which orchestrates scale registration, data fetching, and transform compilation.

| Mark | Description |
|------|-------------|
| DotsMark | Scatter plots, bubble charts |
| BarMarkX / BarMarkY | Horizontal / vertical bars |
| RectMark / RectXMark / RectYMark | Rectangles, histograms, heatmaps |
| LineMark | Lines with curve interpolation |
| AreaMarkY / AreaMarkX | Filled areas with curve interpolation |
| TextMark | Text labels |

### Scale System

Four-layer architecture in `src/lib/scales/`:

1. **ChartScales** — Per-chart scale orchestration. Collects requirements from marks, resolves conflicts via priority system (MANDATE > PREFER > ACCEPT).
2. **ScaleRegistry** — Global singleton cache. Ensures charts sharing the same variable share the same scale state.
3. **Scale States** — LinearScaleState, BandScaleState, ColorScaleState, TimeScaleState, SizeScaleState. Each manages domain, range, and reactive updates.
4. **ScalePriorities** — Conflict resolution. Throws clear errors when marks have incompatible requirements.

### Data Pipeline

```
DuckDB (Mosaic)  -->  SQL Transforms  -->  Arrow Table  -->  JS Transforms  -->  GPU Buffers
  10M rows           filter/having          ~100 rows        stack/topN           Float32Arrays
```

- **SQL transforms** modify the Mosaic Query AST (filter, having, limit, orderby). Must produce flat queries to preserve PreAggregator optimization.
- **JS transforms** process the small aggregated result (stack, topN, normalize, dodge).
- **ViewManager** pushes categorical-to-integer indexing into SQL, enabling zero-copy Float32 data flow from DuckDB to GPU.

See `docs/architecture/` for detailed documentation.

### GPU Rendering

**GPUCoordinator** (`src/lib/gpu/GPUCoordinator.svelte.js`) manages:
- WebGPU device/queue and shared pipeline caching
- Fixed-timestep animation loop (360Hz physics, spring-based, with render extrapolation)
- SSBO management for scale parameters (linear, color, size configs)
- Render batching via `queueMicrotask` invalidation

**Renderers** in `src/lib/components/rendering/`:
- Dots, Rects, Lines, Areas — each with WGSL shaders
- Scale transforms injected at compile time via template system
- Curve interpolation (linear, step, catmull-rom, monotone, bump) evaluated in vertex shader

### Interactions

- **Brushing**: IntervalX, IntervalY, Interval2D with Mosaic crossfiltering
- **Tooltips**: DB-first hit testing, queries DuckDB temp tables on hover
- **Pan/Zoom**: Spring-based domain animation, zero-GC memory pooling

## Project Structure

```
src/lib/
  components/
    marks/          Mark components and BaseMarkSetup
    rendering/      WebGPU renderers (Dots, Rects, Lines, Areas)
    axes/           AxisBottom, AxisLeft, AxisCenter
    guides/         Grid, legends
    charts/         ChartContainer, ChartCell (faceting)
  scales/           Scale system (ChartScales, ScaleRegistry, state classes)
  gpu/              GPUCoordinator, shader libraries
  data-clients/     Mosaic/DataClient bridge
  transforms/       Transform pipeline (SQL + JS)
  interactors/      Tooltip, brush, interval selection
  animation/        Spring physics, fixed-timestep loop
  sql/              SQL helpers (bin)
  data/             DataAccessor, ViewManager
docs/
  architecture/     Implementation documentation
```

## Development

```bash
npm run dev          # Dev server
npm run build        # Production build
npm run lint         # ESLint + Prettier
npm run format       # Auto-format
npx vitest           # Run tests
```

## License

See [LICENSE](LICENSE).
