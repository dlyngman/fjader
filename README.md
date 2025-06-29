# Current Codebase Architecture Summary

## 🏗️ **Core Architecture**

### **ChartContainer.svelte** - *Main Chart Component*
**Responsibility**: Top-level chart orchestration and user interaction handling
- **Layout Management**: Creates and binds to `ChartLayout` instance
- **Scale Coordination**: Creates and manages reactive `ChartScales` instance
- **User Interactions**: Handles all mouse/touch events (pan, zoom, crosshair)
- **Context Provider**: Provides comprehensive chart context to child components
- **Rendering Coordination**: Manages SVG layers (background, foreground) and canvas layer

**Key Features**:
- ✅ Clean separation of concerns (delegates to Layout + ChartScales)
- ✅ Event handling for pan, zoom, double-click reset
- ✅ Touch/pinch support
- ✅ Reactive to prop changes (xLabel, yLabel) - ChartScales recreated automatically
- ✅ Explicit context API with all layout and scale methods

---

## 📐 **Layout System**

### **ChartLayout.svelte.js** - *Dimensions & Coordinate Management*
**Responsibility**: All chart layout calculations and coordinate transformations
- **Dimension Management**: Width, height, margins, inner dimensions
- **Coordinate Transformations**: Screen ↔ inner coordinates, SVG transforms
- **Boundary Detection**: Determines which axes are active for interactions
- **Clip Path Management**: SVG clipping for chart bounds
- **Layout State**: Tracks when layout is ready for rendering

**Key Features**:
- ✅ Pure class (no Svelte dependencies)
- ✅ Reactive properties via getters
- ✅ Context data provider for chart context
- ✅ Comprehensive coordinate utilities

---

## 📊 **Scale System** (4-Layer Architecture)

### **ChartScales.svelte.js** - *Scale Orchestration with Priority Resolution*
**Responsibility**: Manages all scale-related logic for ONE chart instance with intelligent conflict resolution
- **Scale Requirements**: Collects scale type requirements from marks with priority levels
- **Conflict Resolution**: Uses Observable Plot-inspired priority system (MANDATE > PREFER > ACCEPT)
- **Scale State Management**: References to shared scale states from registry based on resolved types
- **D3 Scale Creation**: Creates actual D3 scales from resolved scale states + layout
- **Interaction Delegation**: Handles zoom/pan/reset operations on scales
- **Reactive Computations**: Uses `$derived` for automatic updates

**Key Features**:
- ✅ Priority-based scale type resolution prevents conflicts
- ✅ Reactive to prop changes (recreated when xLabel/yLabel change)
- ✅ Grammar of Graphics alignment - mark-based requirements
- ✅ Intelligent error messages for incompatible mark combinations
- ✅ Debug utilities for scale requirement inspection
- ✅ Supports multiple marks of same type with unique identification

### **ScalePriorities.js** - *Scale Type Resolution Logic*
**Responsibility**: Priority system for resolving scale type conflicts between marks
- **Priority Constants**: MANDATE (3), PREFER (2), ACCEPT (1), DEFAULT (0)
- **Conflict Resolution**: Throws helpful errors when marks have incompatible MANDATE requirements
- **Type Resolution**: Highest priority wins, same priority with same type succeeds

**Key Features**:
- ✅ Observable Plot-inspired priority hierarchy
- ✅ Clear, actionable error messages for conflicts
- ✅ Explicit over implicit behavior

### **ScaleRegistry.svelte.js** - *Global Scale State Registry*
**Responsibility**: Central registry for sharing scale states across charts
- **Scale State Factory**: Creates/retrieves scale states by name and type
- **Sharing Logic**: Ensures charts with same variable share same scale state
- **Type Management**: Supports multiple scale types (linear, band, point, ordinal)
- **Singleton Pattern**: Global registry accessible via context

**Key Features**:
- ✅ Perfect scale synchronization across charts
- ✅ Automatic scale state reuse
- ✅ Support for multiple scale types
- ✅ Svelte context integration

### **Scale State Classes** - *Individual Scale Management*
**LinearScaleState.svelte.js**: Manages continuous data with zoom/pan interactions
**BandScaleState.svelte.js**: Manages categorical data with uniform bands
**PointScaleState.svelte.js**: Manages ordinal data with point positioning

**Responsibility**: Manages domain state and interactions for a single scale
- **Domain Management**: Current domain, target domain, domain limits
- **Animation System**: Smooth domain transitions via Svelte Tween (linear scales)
- **Zoom/Pan Logic**: Domain calculations for user interactions (linear scales only)
- **Data Tracking**: Manages data extents from multiple mark sources with unique IDs
- **Freeze/Debounce**: Can disable updates temporarily for performance

**Key Features**:
- ✅ Smooth domain animations (linear scales)
- ✅ Multi-mark data extent management with unique mark identification
- ✅ Zoom limits and boundary enforcement (linear scales)
- ✅ Reactive domain state via `$state`
- ✅ Type-specific behavior (bands vs points vs linear)

---

## 📡 **Data System**

### **DataClient.svelte.js** - *Data Fetching & Processing with Mark Integration*
**Responsibility**: Bridges Mosaic data coordinator with chart scales using unique mark identification
- **Query Building**: Constructs SQL queries from configuration
- **Data Processing**: Transforms raw data for chart consumption
- **Scale Integration**: Automatically updates scale states with data extents using mark IDs
- **Loading States**: Manages loading/error states with debouncing
- **Format Support**: Handles both Arrow and array data formats
- **Mark Identification**: Accepts and uses mark IDs for consistent scale extent management

**Key Features**:
- ✅ Automatic scale domain calculation from data
- ✅ Reactive to configuration changes
- ✅ Integration with Mosaic ecosystem
- ✅ Multi-format data support
- ✅ Unique mark identification for proper cleanup

---

## 🏗️ **Data Processing Architecture: Database-First Design**

### **Core Principle: Optimal Processing Layer Separation**

Our architecture follows a **database-first processing model** that maximizes performance by leveraging Mosaic's pre-aggregation engine while maintaining smooth client-side interactions. This creates a clear separation between data processing (database) and visual processing (client).

### **📊 Database Level Processing (via Generic DataClients)**

**Responsibility**: Generic SQL query processing that accepts any Mosaic SQL expression

**DataClient Architecture**:
- **Generic Query Builder**: Accepts any Mosaic SQL expression from component props
- **Flexible Processing**: Not limited to predetermined aggregations - handles any valid Mosaic SQL
- **Expression Parsing**: `x={sum("amount")}` becomes `SELECT category, SUM(amount) GROUP BY category`
- **Complex Query Support**: `x={sum("amount").where(eq(column("category"), literal("premium")))}` 
- **Future Extensibility**: Can handle any Mosaic SQL innovation without DataClient changes

**Operations Handled at Database Level**:
- **Any Mosaic SQL Expression**: `sum("amount")`, `count()`, `avg("price")`, complex window functions
- **Chained Operations**: `sum("amount").where(condition)` for filtered aggregations  
- **Binning**: `GROUP BY` with calculated bin edges for histograms
- **Filtering**: `WHERE` clauses embedded in expressions or applied to table
- **Sorting**: `ORDER BY` for optimal topN preparation  
- **Statistical Operations**: `PERCENTILE`, `STDDEV`, any database-supported function
- **Joins**: Multi-table operations via Mosaic SQL expressions

**Performance Benefits**:
- ✅ **Mosaic Pre-Aggregation Engine**: Lightning-fast cached results for repeated queries
- ✅ **Database Native Speed**: `GROUP BY` operations run at full database performance
- ✅ **Minimal Data Transfer**: Only aggregated results cross the wire (20 rows vs 1M rows)
- ✅ **Optimal Caching**: Coordinator caches aggregated queries efficiently
- ✅ **Cross-filtering Support**: Leverages Mosaic's selection system for interactive dashboards

### **🎨 Client Level Processing (via Transformer Pipeline)**

**Responsibility**: Visual transformations and UI logic on pre-processed data

**Operations Handled at Client Level**:
- **Visual Positioning**: Stack and dodge layouts (post-aggregation)
- **Post-Aggregation Filtering**: TopN with "Other" category creation
- **Additional Filtering**: Client-side filtering as alternative to database filtering
- **Animations & Transitions**: Smooth state changes without re-querying  
- **Interactive Feedback**: Real-time visual updates during interactions
- **Color & Opacity Mapping**: Aesthetic transformations
- **UI-Specific Logic**: Crosshair positioning, selection highlighting

**Performance Benefits**:
- ✅ **Smooth Interactions**: No database round-trips for visual changes
- ✅ **Fluid Animations**: Process small aggregated datasets for transitions
- ✅ **Reactive Updates**: Immediate feedback during user interactions
- ✅ **Composable Transforms**: Chain multiple visual operations efficiently
- ✅ **Memory Efficient**: Work with small aggregated datasets (10-100 rows)

### **⚡ Performance Comparison**

**Traditional Approach (Inefficient)**:
```
Database → 1M raw rows → Client aggregates → Client renders
         └─ Heavy transfer ─ Slow processing ─ Memory intensive
```

**Our Database-First Approach (Optimal)**:
```
Database → GROUP BY/SUM → 20 aggregated rows → Client visual transforms → Render
         └─ Fast caching ─ Minimal transfer ─ Smooth interactions
```

### **🎯 Architectural Advantages**

**Versus Observable Plot**:
- ✅ **Database Optimization**: Leverages SQL aggregation (Plot processes everything client-side)
- ✅ **Pre-Aggregation Caching**: Instant re-queries for filtered data
- ✅ **Large Dataset Support**: Handle millions of rows efficiently

**Versus Traditional BI Tools**:
- ✅ **Fluid Interactions**: Real-time visual feedback without server round-trips  
- ✅ **Composable Transformations**: Mix and match visual operations dynamically
- ✅ **Grammar of Graphics**: Flexible mark-based composition

**Versus Client-Only Libraries**:
- ✅ **Scalable Performance**: Database aggregation scales to massive datasets
- ✅ **Memory Efficiency**: Process aggregated results, not raw data
- ✅ **Caching Benefits**: Leverage Mosaic's sophisticated caching system

---

## 🚧 **Proposed Post-Aggregation Processing System** *(Not Yet Implemented)*

### **🎯 Design Goals & Alternative Approaches Considered**

We are designing a client-side processing system for visual transformations on database-aggregated data. After extensive analysis, we evaluated several architectural approaches:

**Considered Alternatives**:
1. **Class-Based Transformer Pipeline**: Observable Plot-style processor classes
2. **Pure Declarative Configuration**: Simple props that hide all complexity  
3. **Functional Transform Composition**: RxJS/Ramda-style function composition
4. **Schema-Driven Processing**: Vega-Lite-style JSON specifications
5. **Plugin Architecture**: Extensible plugin system for custom transforms
6. **Svelte Actions System**: Leveraging Svelte's action system for side effects

**Selected Approach**: **Reactive Derivations + Functional Fallback** - Leverages Svelte's native reactivity for common cases while providing unlimited flexibility through functional composition for complex scenarios.

### **🌟 Proposed API Design**

#### **Core Principle: Progressive Disclosure**
- **80% of users**: Simple reactive derivations (`topN={10}`)
- **15% of users**: Functional composition (`transform={flow(...)}`) 
- **5% of users**: Custom functions for edge cases

#### **Database Integration via Mosaic SQL**
```javascript
import { sum, count, avg, eq, column, literal } from '@uwdata/mosaic-sql';

// Clean integration with Mosaic's SQL functions (passed from outside)
<BarMark 
  table="sales" 
  x={sum("amount")}    // DataClient parses: SELECT category, SUM(amount) GROUP BY category
  y="category" 
  topN={10}           // Client: Post-aggregation filtering
/>

// Complex expressions supported via Mosaic SQL chaining
<BarMark 
  table="sales" 
  x={sum("amount").where(eq(column("category"), literal("premium")))}
  y="region"
  topN={5}
/>
```

#### **Simple Cases: Reactive Derivations (80% of users)**
```javascript
<BarMark 
  table="sales" 
  x={sum("amount")} 
  y="category"
  
  // Single transforms via reactive derivations
  topN={10}           // Client: TopN with "Other" category
  stackBy="region"    // Client: Visual stack positioning  
  animate             // Client: Smooth transitions
/>
```

#### **Complex Cases: Functional Composition (20% of users)**
```javascript
<BarMark 
  table="sales" 
  x={sum("amount")} 
  y="category"
  
  // Multiple transforms via functional composition
  transform={flow(
    topN({ n: 20, by: 'sales' }),        // First topN
    topN({ n: 10, by: 'profit_margin' }), // Second topN (hierarchical)
    filter(d => d.margin > 0.1),         // Custom filtering
    animate({ stagger: 50 })             // Staggered animations
  )}
/>
```

#### **Hybrid Approach: Mix Simple + Custom**
```javascript
<BarMark 
  table="sales" 
  x={sum("amount")} 
  y="category"
  topN={15}           // Simple reactive prop
  transform={[        // Additional custom transforms
    customBusinessLogic,
    animate({ type: 'bounce', duration: 600 })
  ]}
/>
```

### **🔧 Proposed Implementation Architecture**

#### **Component Structure**
```javascript
// Proposed ReactiveBarMark.svelte structure
<script>
  let {
    table,
    x,  // Any Mosaic SQL expression: sum("amount"), count(), avg("price"), etc.
    y,
    
    // Simple single transforms (reactive derivations)
    topN: simpleTopN = null,
    stackBy = null,
    animate: simpleAnimate = true,
    
    // Advanced multi-transform (functional composition)
    transform = null
  } = $props();

  // Generic DataClient processes any Mosaic SQL expression
  let client = new DataClient(table, null, {
    select: { 
      [y]: y,           // Category field
      value: x          // Any Mosaic SQL expression (sum, count, complex chains)
    }
  });

  // Raw aggregated data from Mosaic (result of any SQL expression)
  let rawData = $derived(client?.data || []);
  
  // Reactive derivations for simple cases
  let topNData = $derived.by(() => {
    if (!simpleTopN || !rawData.length) return rawData;
    return applyTopN(rawData, simpleTopN);
  });
  
  let stackedData = $derived.by(() => {
    if (!stackBy) return topNData;
    return applyStack(topNData, { by: stackBy });
  });
  
  let animatedData = $derived.by(() => {
    if (!simpleAnimate) return stackedData;
    return applyAnimation(stackedData, simpleAnimate);
  });
  
  // Functional composition for complex cases
  let transformedData = $derived.by(() => {
    if (!transform) return animatedData;
    return flow(...transform)(rawData, { chart: c });
  });
  
  // Final display data (automatically chooses optimal path)
  let displayData = $derived(transform ? transformedData : animatedData);
</script>
```

#### **Functional Transform Library**
```javascript
// Proposed functional transforms (src/lib/transforms/index.js)
export const flow = (...transforms) => (data, context) =>
  transforms.reduce((acc, transform) => transform(acc, context), data);

export const topN = (config) => (data, context) => {
  const { n, by = 'value', createOther = true } = config;
  // TopN implementation with "Other" category creation
};

export const filter = (predicate) => (data, context) =>
  data.filter(predicate);

export const stack = (config) => (data, context) => {
  const { by, within, normalize = false } = config;
  // Visual stacking implementation (post-aggregation)
};

export const animate = (config) => (data, context) => {
  const { duration = 400, stagger = 0, type = 'smooth' } = config;
  // Animation configuration for smooth transitions
};
```

### **🎯 Design Benefits & Architectural Concerns**

#### **Framework Integration**
- **Generic DataClient**: Accepts any Mosaic SQL expression, not limited to predefined aggregations
- **Maximum Flexibility**: `x={sum("amount").where(condition)}` for complex database operations
- **Svelte-Native**: Reactive derivations feel natural to Svelte developers
- **Performance Optimal**: Only recomputes what changed via Svelte's dependency tracking
- **Future Query Builders**: Separate utility components can help construct complex Mosaic SQL expressions

#### **Mosaic SQL Expression Support**
```javascript
// Simple aggregations
<BarMark table="sales" x={sum("amount")} y="category" />
<BarMark table="sales" x={count()} y="category" />
<BarMark table="sales" x={avg("price")} y="region" />

// Complex expressions with filtering
<BarMark 
  table="sales" 
  x={sum("amount").where(eq(column("category"), literal("premium")))} 
  y="region" 
/>

// Window functions and advanced operations  
<BarMark 
  table="sales" 
  x={sum("amount").over({ partitionBy: "region", orderBy: "date" })} 
  y="month" 
/>

// Future: Query builder utilities (separate from DataClient)
const complexQuery = QueryBuilder
  .sum("amount")
  .where(and(
    gte(column("date"), literal("2024-01-01")),
    eq(column("status"), literal("completed"))
  ))
  .over({ partitionBy: "region" });

<BarMark table="sales" x={complexQuery} y="category" />
```

#### **Progressive Complexity**
- **Beginner Friendly**: Start with `topN={10}`, minimal learning curve
- **Power User Ready**: Graduate to `transform={flow(...)}` when needed
- **No Artificial Limits**: Can always compose multiple transforms of same type

#### **Architectural Concerns**

**Data Flow Complexity**:
- Simple path: `rawData → topNData → stackedData → animatedData`
- Complex path: `rawData → transformedData` (bypasses simple derivations)
- **Concern**: Need clear precedence rules when both simple props and transforms are used

**State Management**:
- Each reactive derivation creates intermediate state
- **Concern**: Memory usage with large transform chains, garbage collection
- **Mitigation**: Derivations only hold references, not copies

**Transform Composition**:
- Functional transforms are pure functions operating on aggregated data
- **Concern**: Order dependency in transform chains, debugging complex pipelines
- **Mitigation**: Each transform function is independently testable

**Scale Integration**:
- Final processed data must update scale domains appropriately
- **Concern**: Scale updates need to understand transform effects (e.g., stacking changes extent)
- **Mitigation**: Transform outputs include metadata for scale updates

#### **Performance Characteristics**

**Reactive Derivations**:
- ✅ **Granular Updates**: Only affected derivations recompute
- ✅ **Framework Optimized**: Leverages Svelte's change detection
- ⚠️ **Chain Length**: Long derivation chains may impact performance

**Functional Composition**:
- ✅ **Predictable**: Pure functions with no side effects
- ✅ **Testable**: Each transform function independently verifiable
- ⚠️ **Pipeline Length**: Complex transform chains need performance monitoring

**Memory Management**:
- ✅ **Small Datasets**: Processing aggregated data (10-100 rows typically)
- ✅ **Garbage Collection**: Intermediate results released automatically
- ⚠️ **Transform Metadata**: Rich transform outputs may increase memory usage

### **📋 Implementation Phases**

#### **Phase 1: Core Reactive System**
- Implement basic reactive derivations for `topN`, `stackBy`, `animate`
- Create enhanced DataClient with Mosaic SQL integration
- Build simple mark components using reactive approach

#### **Phase 2: Functional Transform Library**
- Develop functional transform primitives (`flow`, `topN`, `stack`, `filter`, `animate`)
- Implement hybrid API supporting both simple props and transform functions
- Add transform composition and debugging utilities

#### **Phase 3: Advanced Features**
- Complex transform types (nested stacking, multi-stage filtering)
- Performance monitoring and optimization
- Transform validation and error handling
- TypeScript integration for transform chain validation

### **🔍 Open Questions & Design Decisions**

#### **Precedence Rules**
- When both simple props and transforms are provided, which takes priority?
- **Current thinking**: `transform` overrides simple props for maximum flexibility

#### **Error Handling**
- How to handle transform errors gracefully?
- **Current thinking**: Each transform wraps in try-catch, falls back to previous data

#### **Scale Update Strategy**
- How do transforms communicate scale domain changes?
- **Current thinking**: Transform outputs include `_scaleHints` metadata

#### **Performance Thresholds**
- At what data size should we warn about client-side processing?
- **Current thinking**: Monitor and warn when processing >1000 aggregated rows

#### **Transform Debugging**
- How to inspect intermediate transform states?
- **Current thinking**: Each derivation available in component debug context

---

## 🎨 **GPU Rendering & Coordination Pipeline** 

### **GPUCoordinator.svelte.js** - *Centralized Scheduler & Resource Manager*
**Current Implementation Status: ✅ Production Ready**

**Responsibility**: A singleton that manages all GPU resources, layers, and render scheduling for an entire dashboard. It acts as the central "brain" for all rendering operations.

-   **Shared Resource Management**: Manages and reference-counts shared WebGPU resources (device, pipelines, shaders, uniform buffers) to maximize VRAM efficiency.
-   **Canvas & Layer Management**: Tracks all chart canvases and their associated renderable layers, providing a global view of the entire scene.
-   **Debounced Render Scheduling**: Employs an intelligent "dirty set" and `queueMicrotask` pattern to handle high-frequency invalidation events (e.g., during animations) with maximum efficiency, preventing redundant work and ensuring a single, coordinated render pass per frame.
-   **Optimized Render Orchestration**: Contains the logic to perform batched rendering, minimizing expensive GPU state changes.

**Key Features**:
-   ✅ **Centralized Layer Management**: The coordinator is the single source of truth for all renderable layers, enabling advanced, cross-chart optimizations.
-   ✅ **Debounced Invalidation**: Prevents "invalidation storms" during animations and interactions, keeping the main thread responsive.
-   ✅ **Reference-counted resource sharing**: Automatic cleanup of pipelines and shaders when they are no longer in use.
-   ✅ **Render batching**: The architecture enables rendering all marks of the same type (e.g., all 'dots') in efficient batches.
-   ✅ **Comprehensive error handling**: Graceful degradation with automatic recovery.
-   ✅ **Rich debugging tools**: A browser console interface for performance analysis and state inspection.

### **Registration Model: Canvas + Layers**

The previous model where renderers registered with `WebGPUCanvas` has been refactored to a more direct and efficient model. Renderers now register their layers **directly with the `GPUCoordinator`**, making the coordinator the true manager of the scene.

#### **1. Canvas Registration (`ChartContainer.svelte`)**
The top-level chart container is responsible for creating a canvas and registering it as a render target.

```javascript
// A Svelte action can simplify this boilerplate
function webgpu(canvas, chartId) {
    const coordinator = getGPUContext();
    // ... configures context ...
    coordinator.registerCanvas(chartId, canvas, context); // Registers the canvas surface
    
    return { destroy: () => coordinator.unregisterCanvas(chartId) };
}
```

#### **2. Layer Registration (`BaseGPURenderer.svelte.js`)**
Each mark's renderer, once initialized, registers itself directly with the coordinator, specifying which chart it belongs to.

```javascript
// Inside a renderer like BaseGPURenderer
function registerLayer(drawFunction) {
    const chartId = this.chartContext.chartId;
    const layerConfig = {
        draw: drawFunction,
        markType: 'dots',
        renderer: this // Pass a reference to itself
    };
    
    // ✅ Renderer talks directly to the global coordinator
    this.layerControl = this.gpuCoordinator.registerLayer(chartId, layerConfig);
}
```
This two-part registration provides a clear separation of concerns: `WebGPUCanvas` manages the render surface, and the `GPUCoordinator` manages the content to be drawn on all surfaces.

### **Resource Sharing Strategy: Centralized & Reference-Counted**

Our architecture employs a centralized resource management strategy, with the `GPUCoordinator` acting as the singleton owner of all shared WebGPU objects. This eliminates resource duplication and ensures efficient memory usage across an entire dashboard. Resources are reference-counted and automatically cleaned up when no longer in use.

**1. `GPUCoordinator` - The Central Hub**

The coordinator holds maps of all shared resources. The keys are typically strings (like a mark type), and the values are objects containing the resource and its metadata.

```javascript
// Inside GPUCoordinator instance
this.#sharedResources = {
  // Pipelines are shared by mark type (e.g., 'dots', 'bars').
  pipelines: Map<'dots', { pipeline: GPURenderPipeline, refCount: number, ... }>,

  // Shaders are also shared by mark type.
  shaderModules: Map<'dots', { module: GPUShaderModule, refCount: number, ... }>,

  // Uniform buffers can be shared globally (e.g., for device pixel ratio).
  uniformBuffers: Map<'devicePixelRatio', { buffer: GPUBuffer, refCount: number, ... }>
};
```

**2. Chart & Layer Registration - The Scene Graph**

The coordinator builds a "scene graph" that describes what to render and where. It maintains a map of all canvases and the layers that should be drawn onto them.

```javascript
// Inside GPUCoordinator instance
// A map where the key is a chart's unique ID.
this.#registeredCharts = Map<chartId, {
    canvas: HTMLCanvasElement,
    context: GPUCanvasContext,
    visible: boolean,
    needsRedraw: boolean,

    // Each chart has its own map of layers.
    layers: Map<layerId, {
        id: layerId,
        markType: string,
        draw: (passEncoder) => void,
        
        // CRITICAL: A direct reference back to the renderer instance
        // that owns the layer-specific buffers and bind groups.
        renderer: BaseGPURenderer 
    }>
}>;
```

**3. `BaseGPURenderer` - The Leaf Node**

Each renderer instance (one per mark component) is responsible for its own **non-shared, layer-specific resources**. It gets the shared resources from the coordinator but owns its own data buffers.

```javascript
// Inside a BaseGPURenderer instance for a specific DotsMark
this.pipeline; // A *reference* to the shared 'dots' pipeline from the coordinator.
this.bindGroup; // The bind group is UNIQUE to this layer.

// These buffers are owned exclusively by this renderer instance.
this.xBuffer;      // Holds x-values for this layer's data.
this.yBuffer;      // Holds y-values for this layer's data.
this.colorBuffer;  // Holds color values for this layer's data.
```

This multi-level strategy provides the best of both worlds:
*   **Maximum Sharing:** Expensive, stateless resources like pipelines and shaders are created once and shared globally.
*   **Clear Ownership:** Stateful, data-driven resources like data buffers and bind groups are owned by the specific renderer instance that needs them, preventing conflicts and ensuring correct data is drawn for each layer.

---

### **WebGPUCanvas.svelte** - *Dedicated WebGPU Canvas Provider*
**Responsibility**: Manages the lifecycle of a single `<canvas>` element and its associated WebGPU context. It has been simplified to be a "dumb" provider of a rendering surface.

-   **WebGPU Setup**: Handles device initialization and context configuration.
-   **Canvas Management**: Owns the `<canvas>` element and handles resizing.
-   **Context Registration**: Registers its configured canvas with the central `GPUCoordinator`.

**Key Features**:
-   ✅ **Single Responsibility**: Focused purely on managing the canvas, not layers.
-   ✅ **Decoupled**: Has no knowledge of the marks or layers being drawn onto it.
-   ✅ **Robust Initialization**: Reliably communicates its readiness (`contextConfigured`) and resize events to the coordinator.

### **WebGPUCirclesCanvasMark.svelte** - *Dot Mark Implementation*
**Responsibility**: Grammar of Graphics dot mark with data integration and scale registration.
-   **Mark Identity**: Unique mark ID used throughout lifecycle.
-   **Scale Registration**: Registers scale type requirements with priority system.
-   **Data Client Integration**: Uses DataClient for data fetching with mark ID.
-   **Error Handling**: Manages loading/error states.
-   **Cleanup**: Proper cleanup of scale requirements and data extents.

**Key Features**:
-   ✅ Grammar of Graphics alignment (dot mark, not scatter plot).
-   ✅ Priority-based scale type registration.
-   ✅ Unique mark identification for multi-instance support.
-   ✅ Automatic data management with consistent ID usage.
-   ✅ Proper cleanup preventing interference between marks.

### **WebGPUCirclesColor.svelte** - *Low-Level Circle Renderer*
**Responsibility**: Direct WebGPU circle rendering with color encoding, managed by a `BaseGPURenderer`.
-   **Shader Management**: Leverages shared shaders from the `GPUCoordinator`.
-   **Buffer Management**: Efficient GPU buffer creation and updates for layer-specific data.
-   **Color Encoding**: Integration with ordinal color scales.
-   **Performance Optimization**: Instanced rendering, SDF circles.
-   **Resource Cleanup**: Proper GPU resource management.

**Key Features**:
-   ✅ High-performance instanced rendering.
-   ✅ SDF-based smooth circles.
-   ✅ Color scale integration.
-   ✅ Efficient buffer management.


### **🔧 Context Integration Strategy**

**setCoordinators()** - *Unified Dashboard Setup*
**Responsibility**: Single initialization call for all dashboard-level coordination
- **Scale Registry**: Cross-chart scale state sharing
- **GPU Coordination**: Centralized WebGPU resource management
- **Dependency Management**: Ensures proper initialization order
- **Context Provision**: Makes both systems available to child components

**Integration API**:
```javascript
// Single call initializes complete dashboard coordination
setCoordinators();

// Internally calls:
setScaleRegistry();     // Cross-chart scale sharing
setGPUCoordinator();    // Cross-chart GPU resource sharing

// Components can access both:
const scaleRegistry = getContext('scale-registry');
const gpuCoordinator = getContext('gpu-coordinator');
```

**Key Features**:
- ✅ **Single Setup**: One call initializes all dashboard coordination
- ✅ **Consistent Pattern**: Matches existing context approach
- ✅ **Clear Dependencies**: Explicit relationship between scale and GPU coordination
- ✅ **Developer Experience**: Simple API hides complex coordination setup

### **Development & Debugging Tools** *(Currently Implemented)*

**Real-Time Performance Monitoring**:
```javascript
// ✅ Start monitoring (works in development mode)
DivePlotDebug.performance.startMonitoring()

// Interact with your charts for 20-30 seconds (pan, zoom, hover)

// ✅ Get detailed performance report
DivePlotDebug.performance.stopMonitoring()
// Shows: FPS, frame times, GPU coordination stats, resource efficiency
```

**GPU Resource Analysis**:
```javascript
// ✅ Quick overview of GPU coordination
DivePlotDebug.gpu().quickStats()
// Shows table with: Registered Charts, Shared Pipelines, etc.

// ✅ Detailed resource sharing analysis  
DivePlotDebug.gpu().analyzeResourceSharing()
// Shows: Pipeline references, memory savings, efficiency metrics
```

**Automated Benchmarking**:
```javascript
// ✅ Quick 10-second performance test
DivePlotDebug.benchmark.quick()

// ✅ Comprehensive 30-second test with interactions
DivePlotDebug.benchmark.full()
// Includes: rendering performance, resource usage, interaction tests
```

**Error Handling (Implemented)**:
```javascript
// ✅ Automatic error recovery strategies:
// • WebGPU not supported → Fallback to Canvas rendering  
// • Resource creation failed → Automatic retry with exponential backoff
// • Context configuration failed → Reset and retry context setup
// • Render errors → Skip failed layers, continue with others

// ✅ Test error handling (development only)
DivePlotErrorUtils.simulate.webgpuNotSupported()
DivePlotErrorUtils.testRecovery.retryMechanism()
```

---

## 🎬 **Advanced Animation & GPU Coordination Architecture** *(Proposed)*

### **🎯 Core Design Philosophy**

**JavaScript-Controlled, GPU-Executed Animation System**: Separate animation control (JavaScript) from animation execution (GPU) for optimal performance and developer experience while maintaining architectural consistency with existing reactive patterns.

### **🎨 WebGPU Tween Interpolation Architecture**

**AnimationCoordinator.svelte.js** - *JavaScript Animation Control*
**Responsibility**: Manages animation timing, easing, and state transitions using Svelte's reactive system
- **Tween Integration**: Uses Svelte `tweened()` for familiar animation control
- **State Management**: Tracks current/target data states for interpolation
- **Interruption Handling**: Manages mid-animation data changes and redirections
- **Racing Chart Support**: Coordinates complex multi-stage animations

**Key Features**:
- ✅ **Familiar Svelte API**: Standard `tweened()` with duration, easing, interruption
- ✅ **Flexible Control**: JavaScript timing logic remains debuggable and testable
- ✅ **Smooth Interruptions**: Mid-animation data changes redirect naturally
- ✅ **Scale Integration**: Works seamlessly with existing scale coordination system

**GPU Animation Shaders** - *Parallel Interpolation Execution*
**Responsibility**: Performs high-performance interpolation and rendering on GPU
- **Buffer Management**: Current/target data buffers with animation progress uniform
- **Parallel Processing**: All mark instances interpolate simultaneously 
- **Scale Integration**: Applies current scale transformations during interpolation
- **Visual Properties**: Animates position, color, size, opacity in parallel

**Key Features**:
- ✅ **GPU Parallelization**: All interpolation happens simultaneously across instances
- ✅ **Minimal CPU Overhead**: Single `float32` progress upload per frame
- ✅ **120fps Capable**: Handles 10+ animated charts simultaneously
- ✅ **Simple Shader Logic**: `mix(current, target, progress)` keeps GPU code clean

**Data Flow**:
```
New Data Arrives
     ↓
Current = getCurrentInterpolatedState(progress)
Target = newDataValues  
     ↓
Svelte Tween: progress 0→1
     ↓
GPU Shader: mix(current, target, progress)
     ↓
Apply Current Scales → Render
```

**GPU Buffer Layout**:
```glsl
@binding(1) currentValues: array<f32>    // Where we are now
@binding(2) targetValues: array<f32>     // Where we're going  
@binding(3) categories: array<f32>       // Stable category indices
@binding(4) colors: array<vec4<f32>>     // Visual properties
@binding(6) animationProgress: f32       // 0.0 → 1.0 from Svelte
```

### **🏷️ Category Lifecycle Management**

**Enhanced BandScaleState** - *Smart Category Positioning*
**Responsibility**: Manages category appearance/disappearance with smooth off-screen transitions
- **Ghost Category Tracking**: Keeps removed categories temporarily for animation-out
- **Off-Screen Positioning**: Places disappearing categories outside chart bounds
- **Smart Exit Directions**: Configurable exit directions (left/right/fade for different use cases)
- **Cleanup Coordination**: Removes ghost categories after animation completion

**Key Features**:
- ✅ **GPU Simplicity**: Shader unchanged - just interpolates between positions
- ✅ **Business Logic Separation**: Category lifecycle handled in JavaScript, not GPU
- ✅ **Configurable Behavior**: Exit directions and timing customizable per chart type
- ✅ **Racing Chart Support**: Categories slide in/out based on ranking changes

**Category State Management**:
```javascript
// Active categories: Normal band positions (0.0 - 1.0)
activeDomain: ['USA', 'China', 'Brazil']

// Ghost categories: Off-screen positions for animation-out
ghostCategories: {
  'Germany': { 
    targetPosition: 1.2,        // Off-screen right
    removeAfter: 1704123456789  // Cleanup timestamp
  }
}
```

**Visual Behavior Example**:
```
Racing Chart Transition:
['USA', 'China', 'Japan', 'Germany'] 
           ↓ (Germany falls out, Brazil enters)
['USA', 'China', 'Brazil'] 

User Experience:
- 'Brazil' slides in from left (-0.2 → 0.6)
- 'Germany' slides out to right (0.8 → 1.2) 
- 'USA', 'China' smoothly reposition to make room
```

### **🖱️ SVG Interaction Layer Strategy**

**Foreground SVG Event Handling** - *Interaction Coordination*
**Responsibility**: Handle all mouse/touch interactions through SVG layer while maintaining GPU/SVG scale synchronization
- **Event Mapping**: Translate SVG coordinates to chart data coordinates
- **Scale Synchronization**: SVG and GPU scales stay perfectly synchronized
- **Interaction Delegation**: Route interactions to appropriate chart components
- **Crosshair Coordination**: Visual feedback remains in SVG layer

**Key Features**:
- ✅ **Separation of Concerns**: Interaction logic separate from GPU rendering
- ✅ **Familiar Patterns**: Leverages existing mouse/touch event handling
- ✅ **Scale Consistency**: No coordinate translation errors between layers
- ✅ **Performance**: GPU focused on rendering, SVG handles interactions

**Coordinate Flow**:
```
User Interaction (SVG coordinates)
         ↓
Chart Context Layout Transformation
         ↓
Scale Invert (Data coordinates)
         ↓
Update Reactive Scale State
         ↓
GPU Re-render (Automatic via reactivity)
```

### **📋 Implementation Phases**

**Phase 1: GPU Coordination Foundation** *(2 weeks)*
**1.1 Dashboard GPU Provider**
- Single WebGPU context with chart registration system
- Viewport management and coordinate mapping utilities
- Shared resource initialization (device, pipelines, buffers)
- Basic render orchestration with z-index ordering

**1.2 Context Integration**
- Implement `setCoordinators()` unified setup function
- Integration with existing `setScaleRegistry()` 
- Context provider pattern for GPU coordinator access
- Update existing components to use coordinated GPU context

**Phase 2: Animation Infrastructure** *(2 weeks)*
**2.1 Tween Animation System**
- JavaScript animation control using Svelte `tweened()`
- Current/target data buffer management
- Animation progress uniform and GPU integration
- Base animated renderer with common animation patterns

**2.2 Enhanced Category Management**
- Extend `BandScaleState` with ghost category support
- Off-screen positioning and cleanup logic
- Configurable exit directions and animation timing
- Integration with existing band scale system

**Phase 3: Advanced Animation Features** *(1-2 weeks)*
**3.1 Racing Chart Utilities**
- Multi-stage animation sequencing for time-series data
- Automatic duration calculation and ranking management
- Category appearance/disappearance coordination
- Performance monitoring for complex animation chains

**3.2 Multi-Property Animation**
- Extend shaders for color, size, opacity transitions
- Multiple simultaneous tween coordination
- Advanced easing and staggered animation support
- Edge case handling (data structure changes, scale updates)

**Phase 4: Performance & Polish** *(1 week)*
**4.1 Performance Optimization**
- Buffer reuse strategies and memory usage optimization
- Batch animation updates across multiple charts
- Animation frame coordination and GPU resource management
- Performance monitoring and debugging utilities

**4.2 Developer Experience**
- Animation debugging and inspection tools
- TypeScript definitions for animation APIs
- Comprehensive documentation and examples
- Integration testing for complex dashboard scenarios

### **🎯 Success Metrics**

**Performance Targets**
- ✅ **120fps Animation**: 10+ animated charts simultaneously
- ✅ **<1ms Frame Time**: For animation progress updates
- ✅ **~10x Resource Efficiency**: vs separate GPU contexts per chart
- ✅ **Smooth Interruptions**: No janky animation redirections

**Developer Experience Goals**
- ✅ **Simple API**: `<BarMark animate duration={800} easing={cubicOut} />`
- ✅ **Familiar Patterns**: Svelte `tweened()` integration throughout
- ✅ **Easy Racing Charts**: Minimal configuration for complex animations
- ✅ **Debugging Tools**: Clear visibility into animation state and performance

**Architectural Benefits**
- ✅ **Consistent Patterns**: Aligns with existing reactive architecture
- ✅ **Clean Separation**: JavaScript control, GPU execution boundary
- ✅ **Resource Efficiency**: Shared GPU resources across dashboard
- ✅ **Extensible Foundation**: Easy to add new animation types and behaviors

---

## 🔄 **Data Flow & Reactivity: The Managed Render Loop**

### **Current Data Flow (Implemented)**:
1.  **Parent** updates chartConfig
2.  **ChartContainer** receives new xLabel/yLabel props
3.  **ChartScales** is recreated with new labels (via `$derived`)
4.  **New scale states** are retrieved from the registry based on resolved scale types
5.  **Charts sync** automatically if sharing scale states

### **New Invalidation & Redraw Flow: Dual-Mode Managed Loop (Implemented)**
The previous microtask-based invalidation has been upgraded to a more robust and explicit **Managed Loop** system. This provides maximum efficiency for both static data updates and smooth, continuous animations without hacks or guesswork. The `GPUCoordinator` operates in two distinct modes:

#### **Mode 1: Sleeping (On-Demand, Event-Driven Rendering)**
This is the default, highly efficient state for static charts. The render loop is "asleep" until a change occurs.

**Use Cases**: Initial data load, chart resizing, props changing.

**Flow**:
1.  **Invalidation Event**: A resize or data update triggers an `$effect` in a component.
2.  **Mark as Dirty**: The component calls `coordinator.invalidateChart(chartId)`.
3.  **Add to Dirty Set**: The coordinator adds the `chartId` to the global `#dirtyChartIDs` set.
4.  **Check Loop State**: The coordinator sees that its continuous loop is not active (`#loopIsActive` is `false`).
5.  **Schedule a Single Frame**: It calls `#requestSingleFrame()`, which queues a **single** `requestAnimationFrame` to perform the render. No more work is scheduled.
6.  **Render & Sleep**: The `rAF` fires. The coordinator's `render()` method runs, draws only the dirty charts, clears the set, and goes back to sleep.

#### **Mode 2: Active (Continuous Rendering)**
This mode is explicitly requested by components that require smooth, high-framerate updates.

**Use Cases**: Animations (tweening), real-time crosshair feedback, interactive brushing.

**Flow**:
1.  **Request Loop**: An animation starts (e.g., in `Dots.svelte`). It calls `coordinator.requestActiveLoop(requesterId)` with a unique ID.
2.  **Start Loop**: The coordinator sees it's the first requester, sets `#loopIsActive` to `true`, and starts a continuous `rAF` loop via `#setupContinuousRenderLoop()`.
3.  **Frame-by-Frame Updates**: On each animation frame, the Svelte tween updates its value. The component's `$effect` tracks this change and calls `coordinator.invalidateChart(chartId)`.
4.  **Continuous Render**: The active `rAF` loop fires, sees the dirty chart in the `#dirtyChartIDs` set, and re-renders it with the new interpolated data.
5.  **Release Loop**: When the animation finishes, the component calls `coordinator.releaseActiveLoop(requesterId)`.
6.  **Go to Sleep**: The coordinator removes the ID from its set of requesters. If the set is now empty, it sets `#loopIsActive` to `false`. The `rAF` loop runs one last time, sees the flag is false, and terminates, returning the system to Sleeping Mode.

### **Architectural Advantages of the Managed Loop**:
- ✅ **Explicit Control**: The system doesn't have to guess if an animation is running. Components that need high-frequency updates explicitly request them.
- ✅ **Maximum Efficiency**: The GPU is completely idle in Sleeping Mode. The continuous loop only runs when absolutely necessary.
- ✅ **Animation-Ready**: Eliminates the need for `setTimeout` workarounds to keep the render loop alive for the duration of an animation.
- ✅ **Robust & Centralized**: The coordinator perfectly handles multiple components requesting/releasing the active loop, ensuring it runs as long as needed and stops when all work is done.

---


## 🎯 **Key Design Principles**

### **✅ Grammar of Graphics Alignment**
- Mark-based architecture (dot, bar, line) instead of chart types
- Composable marks that can be layered and combined
- Scale requirements declared by marks, not centrally configured
- Observable Plot-inspired API and concepts

### **✅ Database-First Processing**
- Heavy operations (aggregation, binning, filtering) handled by database
- Leverages Mosaic's pre-aggregation engine for instant cached results
- Minimal data transfer with maximum performance scalability
- Client processing reserved for visual transformations and interactions

### **✅ Priority-Based Scale Resolution**
- MANDATE: Mark absolutely requires this scale type (e.g., bars need bands)
- PREFER: Mark works best with this type (e.g., dots prefer linear)
- ACCEPT: Mark can work with this type (fallback compatibility)
- Clear error messages when marks have incompatible requirements

### **✅ Unique Mark Identification**
- Each mark instance gets unique ID: `dot-a1b2c3d4`, `bar-e5f6g7h8`
- Same ID used for scale registration, data extents, and cleanup
- Multiple marks of same type work independently
- Perfect traceability for debugging

### **✅ Reactive Architecture**
- Heavy use of `$derived` and `$state` for automatic updates
- Scale states shared via registry for perfect synchronization
- Props flow reactively through the component tree
- ChartScales recreation handles prop changes automatically

### **✅ Separation of Concerns**
- **Layout**: Pure dimension/coordinate logic
- **Scales**: Priority resolution and domain state management separated
- **Database Processing**: Aggregation, filtering, sorting via enhanced DataClients
- **Client Processing**: Visual positioning, animations via reactive derivations
- **Rendering**: WebGPU completely isolated from business logic

### **✅ Performance Optimized**
- Database aggregation leverages Mosaic's caching for massive datasets
- WebGPU for high-performance rendering of processed results
- Shared scale states prevent duplicate computations
- Smart conflict resolution prevents unnecessary scale recreations
- Post-aggregation processing enables smooth animations

### **✅ Extensible Design**
- Plugin-like mark system (easy to add new mark types)
- Multiple scale types supported with type-specific behaviors
- Layer-based rendering system
- Configurable and composable reactive processing system
- Configurable and composable components

---

## 🚧 **Current State & Future Roadmap**

### **✅ Currently Implemented & Working**:
- Perfect scale synchronization across charts
- Smooth interactions (pan, zoom, crosshair) on supported scale types
- High-performance WebGPU rendering with enhanced coordination
- Reactive prop updates with automatic ChartScales recreation
- Clean component architecture with grammar of graphics alignment
- Intelligent scale conflict resolution with helpful error messages
- Multiple mark instances work independently
- Database-first processing architecture design
- **Enhanced GPU coordination with resource sharing**
- **Comprehensive debugging and performance monitoring**
- **Error handling and recovery systems**

### **🔧 Recent Major Improvements**:
- ✅ **Coordinator-Centric Rendering**: Refactored the render pipeline to centralize layer management in the `GPUCoordinator`, enabling efficient cross-chart batching and a robust, debounced invalidation system.
- ✅ **Enhanced GPU Coordination**: Reference-counted resource sharing with ~50-70% memory savings.
- ✅ **Performance Monitoring**: Real-time FPS tracking and comprehensive reporting tools.
- ✅ **Development Debugging**: Rich browser console interface with 15+ monitoring commands.
- ✅ **Error Handling**: Automatic recovery from WebGPU failures with graceful degradation.
- ✅ **Benchmarking**: Automated performance testing and validation tools.
- ✅ **Resource Management**: Reference counting and automatic cleanup systems.

### **📋 Next Major Implementation Phases**:

#### **Phase 1: Post-Aggregation Processing System**
- Implement reactive derivations approach for client-side visual transformations
- Create enhanced DataClient with Mosaic SQL function integration
- Build functional transform library for complex composition scenarios
- Add support for topN filtering, stack positioning, and smooth animations

#### **Phase 2: Enhanced Mark Library**
- Create more mark types (line, area, rect, text) using new processing system
- Implement consistent APIs across all mark types with transform support
- Add advanced mark features (error bars, confidence intervals, annotations)

#### **Phase 3: Advanced Interactions & Scale Features**
- Implement band and point scale interactions (pan/zoom currently linear-only)
- Add animation coordination between charts for smooth transitions
- Expand scale type support (log, time scales, advanced color scales)
- Add selection and brushing interactions across mark types

#### **Phase 4: GPU-Accelerated Animation System**
- JavaScript-controlled, GPU-executed animation with Svelte tween integration
- Category lifecycle management for smooth appearance/disappearance
- Multi-property animation (position, color, size, opacity) with parallel GPU execution
- Racing chart utilities for complex time-series animations

#### **Phase 5: Developer Experience & Tooling**
- Add comprehensive TypeScript definitions for better developer experience
- Create visual debugging tools for scale conflicts and data flow
- Build performance monitoring and optimization utilities
- Add comprehensive testing suite for all architectural components

#### **Phase 6: Advanced Features**
- Real-time data streaming support with reactive processing
- Advanced statistical transformations (regression, clustering)
- Custom shader support for specialized rendering needs
- Plugin ecosystem for community extensions

---

## 🔍 **Debugging & Development**

### **Scale Resolution Debugging**:
```javascript
// Inspect current scale requirements and resolution
console.log('Scale Requirements:', c.getScaleRequirementsSummary());
// Output:
// {
//   x: {
//     resolved: 'band',
//     requirements: ['bar-abc123:band(3)', 'dot-def456:linear(2)']
//   },
//   y: { resolved: 'linear', requirements: [...] }
// }
```

### **Database vs Client Processing Debugging**:
```javascript
// Check what SQL query the DataClient generated from Mosaic expression
console.log('Generated SQL:', client.query());
// SELECT category, SUM(amount) as value FROM sales GROUP BY category

// For complex expressions
console.log('Complex Query SQL:', client.query());  
// SELECT region, SUM(amount) as value FROM sales WHERE category = 'premium' GROUP BY region

// Future: Monitor reactive derivation performance
console.log('Derivation Performance:', component.getDerivationStats());
// { topNData: { computeTime: 2.3ms }, stackedData: { computeTime: 1.1ms } }

// Future: Monitor functional transform performance
console.log('Transform Performance:', flow.getPerformanceReport());
// { topN: { averageMs: 2.3 }, stack: { averageMs: 1.1 } }
```

### **Enhanced GPU Coordination Debugging** *(Currently Available)*:
```javascript
// ✅ Complete debugging interface available now
DivePlotDebug.help()                              // Show all available commands
DivePlotDebug.gpu().quickStats()                  // GPU resource sharing overview
DivePlotDebug.gpu().analyzeResourceSharing()      // Detailed efficiency analysis
DivePlotDebug.performance.startMonitoring()       // Real-time performance tracking
DivePlotDebug.benchmark.quick()                   // Automated 10-second benchmark

// ✅ Error simulation and testing
DivePlotErrorUtils.simulate.webgpuNotSupported()  // Test WebGPU fallback
DivePlotErrorUtils.testRecovery.retryMechanism()  // Test automatic recovery
```

### **Mark Lifecycle Tracing**:
- Each mark instance has unique ID for complete traceability
- Scale registrations, data extents, and cleanup all use same ID
- Console logging shows mark registration and cleanup events
- Perfect debugging story for multi-mark scenarios

### **Conflict Analysis**:
- Clear error messages when marks have incompatible scale requirements
- Suggestions for resolution (separate containers, different mark types)
- Priority levels explicitly shown in debug output

### **Future: Transform Pipeline Debugging**:
```javascript
// Proposed reactive derivation inspection
console.log('Derivation Chain:', component.getDerivationChain());
// { rawData: 47 rows, topNData: 10 rows, stackedData: 10 rows, animatedData: 10 rows }

// Proposed functional transform inspection  
console.log('Transform Pipeline:', transform.getSteps());
// [{ name: 'topN', input: 47, output: 20 }, { name: 'topN', input: 20, output: 10 }]
```

---

## 🔍 **Architectural Validation**

This comprehensive architecture maintains design consistency while enabling powerful new capabilities:

**✅ Database-First Processing**: All proposed animations and transforms work on pre-aggregated data
**✅ Priority-Based Scale Resolution**: Animation and transform systems respect scale conflicts  
**✅ Reactive Derivations**: All proposed processing flows through existing reactive patterns
**✅ Grammar of Graphics**: Animations and transforms are mark-based, not chart-type specific
**✅ Resource Sharing**: Enhanced GPU coordination eliminates resource duplication
**✅ Separation of Concerns**: Clear boundaries between control logic and execution
**✅ Performance Optimized**: All proposals maintain or improve current performance characteristics

**Bottom Line**: This architecture delivers a comprehensive, high-performance charting library that maintains developer experience excellence while providing the performance and capabilities needed for sophisticated data applications.



Of course. Here is a new section for your `README.md` that summarizes the advanced architecture of offloading to a dedicated render worker and implementing a global Z-index batching strategy. It is written in the same style and format as your existing documentation.

---

## 🚀 Proposed Advanced Architecture: Render Worker & Global Z-Ordering

While the current architecture provides an excellent balance of performance and flexibility, this section outlines a more advanced model for applications that demand ultimate UI responsiveness and handle extremely large datasets or complex scenes.

### 🎯 Design Philosophy

The core philosophy is to **decouple rendering entirely from the main UI thread**. By moving the `GPUCoordinator` and all WebGPU API interactions into a dedicated Web Worker, the main thread is freed from any rendering-related work, guaranteeing a smooth, non-blocking user experience even during heavy data processing or complex frame rendering.

### 🏗️ Proposed Architecture: Dedicated Render Worker

This model introduces a clear separation of concerns between the main thread (UI) and a new render worker (GPU logic).

#### **Main Thread Responsibilities**
- **UI Management**: Handles all Svelte component lifecycle and rendering.
- **User Interaction**: Captures all mouse/touch events (`pan`, `zoom`, `hover`).
- **State Management**: Manages application state and user configuration.
- **Communication**: Sends high-level commands and interaction state to the render worker.
- **Canvas Control**: Creates `<canvas>` elements and transfers their control to the worker via `canvas.transferControlToOffscreen()`.

#### **Render Worker Responsibilities**
- **`GPUCoordinator` Host**: Owns and manages the singleton `GPUCoordinator` instance.
- **WebGPU API Interaction**: Executes all `device` and `queue` operations. This includes buffer creation, pipeline compilation, and command submission.
- **Render Loop**: Runs the `requestAnimationFrame` loop for rendering.
- **State Synchronization**: Receives state updates from the main thread and applies them to the rendering scene.

#### **Architectural Flow**
```
      Main Thread (UI)                      Render Worker                       GPU
┌────────────────────────────┐       ┌────────────────────────────┐      ┌───────────┐
| Svelte Components          |       | GPUCoordinator             |      |           |
| (ChartContainer, Marks)    |       |                            |      |           |
└───────────┬────────────────┘       └───────────┬────────────────┘      |           |
            │                                    │                       |           |
            │ canvas.transferControlToOffscreen()│                       |           |
            ├───────────────────────────────────►│ (Owns Canvas)         |           |
            │                                    │                       |           |
┌───────────▼────────────────┐       ┌───────────▼────────────────┐      |           |
| User Interaction           |       | Render Loop (rAF)          |      |           |
| (e.g., pan, zoom)          |       |                            |      |           |
└───────────┬────────────────┘       └───────────┬────────────────┘      |           |
            │                                    │                       |           |
            │ Atomics.store(newDomain)           │Atomics.load(newDomain)|           |
            │ (via SharedArrayBuffer)            │                       |           |
            ├───────────────────────────────────►├──────────────────────►│ Render    |
            │                                    │ queue.submit(...)     |           |
            │                                    │                       |           |
┌───────────▼────────────────┐       ┌───────────▼────────────────┐      |           |
| UI remains 100% responsive |       | All GPU work & preparation |      |           |
| at 60/120 FPS              |       | happens off the main thread|      |           |
└────────────────────────────┘       └────────────────────────────┘      └───────────┘
```

#### **Key Benefits**
- ✅ **Ultimate UI Responsiveness**: The main thread never drops a frame due to rendering, even if a frame takes >100ms to prepare. Pan, zoom, and other UI interactions remain perfectly smooth.
- ✅ **True Parallelism**: Data processing, UI logic, and GPU rendering can all occur simultaneously on different threads.
- ✅ **Scalability**: The architecture scales to higher chart counts and data volumes more gracefully, as the main thread bottleneck is eliminated.

---

### 🧬 Communication Strategy: Hybrid `postMessage` & `SharedArrayBuffer`

Efficient communication is critical. This architecture uses a hybrid approach to minimize overhead.

| Data Type | Communication Method | Rationale |
| :--- | :--- | :--- |
| **Configuration / Commands** (e.g., `setColor`, `loadData`) | `postMessage()` | Simple, infrequent messages where the small overhead of copying data is negligible. |
| **Interaction State** (e.g., pan/zoom domains, crosshair position) | `SharedArrayBuffer` + `Atomics` | For high-frequency updates. Provides **zero-copy**, near-instant state sharing, crucial for responsive interactions. |
| **Large Chart Data** (e.g., vertex data from `DataClient`) | `SharedArrayBuffer` | For large datasets. A one-time copy into the shared buffer enables the worker to access it directly without any subsequent transfer overhead. |

#### **💡 Prerequisite: COOP/COEP Headers**
To enable `SharedArrayBuffer`, the application must be served with these HTTP headers, which ensures a secure context:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

---

## ⚙️ Dual-Mode Rendering Architecture: Worker Fallback System (proposal)

To provide both maximum performance and out-of-the-box compatibility, the library implements a **Dual-Mode Rendering Architecture**. At runtime, it automatically detects the environment's capabilities and selects the optimal rendering strategy without requiring any configuration from the user.

### **Two Rendering Modes**

#### 1. 🚀 **Render Worker Mode (High Performance)**
- **Trigger**: Automatically enabled when the environment supports `SharedArrayBuffer` (i.e., when COOP/COEP headers are correctly configured).
- **Architecture**: All GPU coordination, resource management, and rendering commands are moved to a dedicated **Web Worker**. The main UI thread is responsible only for user interactions and component logic, guaranteeing a perfectly smooth, non-blocking experience.
- **Communication**: Uses a hybrid approach for maximum efficiency:
    - **`SharedArrayBuffer`**: For high-frequency state updates like pan/zoom domains and crosshair positions, enabling zero-copy, near-instant communication.
    - **`postMessage`**: For infrequent commands like configuration changes.
- **Benefit**: The gold standard for performance. UI remains fluid at 60/120 FPS, even during heavy data processing or complex frame rendering on a separate thread.

#### 2. Fallback: **Main Thread Mode (High Compatibility)**
- **Trigger**: Automatically used as a fallback when `SharedArrayBuffer` is not available.
- **Architecture**: This is the robust "Coordinated Multi-Canvas" architecture detailed previously. The `GPUCoordinator` runs on the main UI thread, managing all chart canvases.
- **Benefit**: Ensures the library works in any environment without requiring special server configuration. It provides excellent performance that is suitable for a majority of use cases.

### **How It Works: The `setCoordinators` Switch**

The architectural switching logic is handled transparently within the `setCoordinators()` initialization function.

```javascript
// Simplified logic within setCoordinators()

import { supportsSharedArrayBuffer } from '$lib/utils/environment';
import { createWorkerCoordinator } from '$lib/gpu/workerCoordinator';
import { createMainThreadCoordinator } from '$lib/gpu/mainThreadCoordinator';

// 1. Detect environment capabilities at runtime
if (supportsSharedArrayBuffer()) {
  // 2a. If supported, initialize the high-performance worker coordinator
  console.log('✅ Initializing Render Worker...');
  gpuCoordinator = await createWorkerCoordinator(config);
} else {
  // 2b. Otherwise, fall back to the compatible main-thread coordinator
  console.warn('⚠️ Falling back to Main Thread rendering.');
  gpuCoordinator = await createMainThreadCoordinator(config);
}

// 3. Provide the chosen coordinator to the application via context.
// All child components interact with it through a unified interface,
// unaware of the underlying rendering mode.
setContext('gpu-coordinator', gpuCoordinator);
```

### **Architectural Advantages of the Dual-Mode System**
- ✅ **Performance by Default**: Users with correctly configured environments automatically get the best possible performance.
- ✅ **Seamless Fallback**: The library remains fully functional for users in more restricted environments or during initial development without server setup.
- ✅ **Zero Configuration**: Developers do not need to manually select a mode; the library handles it.
- ✅ **Progressive Enhancement**: Encourages best practices (using COOP/COEP) by offering a tangible performance reward, while not punishing those who cannot implement them.

This dual-mode system ensures that your charting library is both powerful for production-grade applications and easy to adopt for rapid prototyping.


---

### 🎨 Enhanced Rendering: Global Z-Index Batching (proposal)

To enable precise, individual Z-ordering of marks across multiple charts, the `GPUCoordinator`'s render strategy must be enhanced.

#### **The Challenge: Z-Ordering vs. Performance Batching**
The current strategy batches draws by `markType` across all charts. This is highly performant but can violate Z-ordering if different charts have different layer structures (e.g., Chart A has `bars(z=0), dots(z=1)` while Chart B has `dots(z=0), bars(z=1)`).

#### **The Solution: Render by Global Z-Passes**
The `GPUCoordinator` will render the entire scene in sorted Z-level passes. Within each pass, it will still batch by `markType` to maintain performance.

#### **Proposed Render Loop Logic**
```javascript
function renderScene() {
    // 1. Collect all layers from all visible charts
    const allLayers = collectAllLayers(); // [{ chart, layer, globalZ, markType }, ...]

    // 2. Group layers by Z-level, then by markType
    const zBatches = groupLayers(allLayers); // Map<zLevel, Map<markType, Layer[]>>

    // 3. Get sorted Z-levels
    const sortedZLevels = Array.from(zBatches.keys()).sort((a, b) => a - b);

    // 4. Iterate through Z-passes
    for (const zLevel of sortedZLevels) {
        const markTypeBatches = zBatches.get(zLevel);

        // 5. Iterate through mark types within this Z-pass
        for (const [markType, batch] of markTypeBatches) {
            // Get shared pipeline for this markType
            const pipeline = getSharedPipeline(markType);

            // 6. Render all items in this batch
            for (const item of batch) {
                // Set pipeline, bind group for item.chart, and draw
                drawItem(item, pipeline);
            }
        }
    }

    // 7. Submit all command buffers at once
    submitCommands();
}
```

#### **Key Features**
- ✅ **Correct Global Ordering**: Guarantees that a mark with `zIndex: 1` in any chart will always render on top of a mark with `zIndex: 0` in any other chart.
- ✅ **Preserves Performance**: Maintains the critical optimization of batching draws by `markType` within each Z-level.
- ✅ **Flexible Composition**: Developers can freely compose layers in any order within any chart, and the system will render them correctly across the entire dashboard.

---

### 📈 Architectural Advantages & Trade-offs

#### **Advantages**
- **Uncompromised UI Fluidity**: The primary benefit. The application feels faster and more professional.
- **Improved Scalability**: Handles heavy rendering loads without impacting the user's ability to interact with the UI.
- **Robust Z-Ordering**: Provides intuitive and powerful control over layer composition.

#### **Trade-offs**
- **Increased Complexity**: Requires careful state synchronization and management of communication between threads.
- **COOP/COEP Requirement**: The server hosting the application must be configured to send the required security headers.
- **Debugging**: Debugging across threads can be more challenging than single-threaded logic.

This advanced architecture represents the gold standard for building demanding, real-time data visualization applications on the web.



# GPU-Accelerated Data Visualization Pipeline Summary (plan)

## Core Architecture Concepts

**End-to-End GPU Pipeline**: Process raw data points entirely on GPU using WebGPU, generate Catmull-Rom curves, apply transforms (dodge, stacking), and render - keeping everything in GPU memory to avoid CPU↔GPU transfers.

**Data Space Processing**: Generate curves and transformations in data coordinate space, then use GPU-side scale functions to convert to screen coordinates. This maintains mathematical precision similar to SVG while leveraging GPU parallelism.

**Performance Target**: 10+ charts at 120fps on modern high-end laptops, even with integrated GPUs.

## Data Processing on GPU

**Curve Generation**: Catmull-Rom interpolation from raw data points using compute shaders, with each curve segment calculated in parallel across GPU cores.

**Complex Transforms**: Even operations like dodge transforms and stacking can be efficiently implemented on GPU using parallel algorithms (spatial hashing, prefix sums) - worthwhile even for smaller datasets (1000 rows) given the cumulative throughput requirements.

**Animation & Morphing**: Store both "old" and "new" curve geometries on GPU, interpolate between them over 300ms for smooth transitions synchronized across all visual elements.

## GPU Text Rendering

**Fixed-Size Approach**: Labels maintain consistent font size during zoom/pan (better UX for data viz), significantly simplifying implementation vs. scalable text.

**Font Atlas Strategy**: Use Canvas 2D API to render CSS fonts to texture atlas, upload to GPU. Supports same fonts as CSS with crisp quality when properly handling high-DPI displays.

**Performance Integration**: Text rendering reuses position data from curve generation pipeline, adding minimal overhead (~0.1-0.5ms) to overall frame time.

## JavaScript Integration

**Buffer Readback**: Read processed GPU data back to JavaScript for tooltips/interactions using WebGPU's async buffer mapping. Optimized by caching data during "interaction mode" vs. "data update mode" since these are mutually exclusive.

**Text Formatting**: CPU-side formatting using `Intl` APIs and D3-style helpers during data preparation, sending pre-formatted glyph indices to GPU rather than doing string manipulation on GPU.

## Key Advantages & Mitigations

**Why GPU Over CPU**: Even for smaller datasets, the combination of high frame rate, multiple charts, and existing GPU infrastructure makes GPU processing more efficient than CPU alternatives.

**Browser/Hardware Considerations**: Build Canvas 2D fallback for WebGPU-unsupported browsers; adaptive quality settings for varying GPU capabilities; focus on modern high-end laptop targets reduces compatibility concerns.

**Performance Reality**: Modern integrated GPUs can handle this workload in ~0.5-1ms total frame time, leaving massive headroom for additional complexity and features.



---

## 🏗️ **Architectural Evolution: Controller-Based Mark Design**

To manage component complexity and ensure long-term maintainability, our mark components (`DotsMark`, `BarMark`, etc.) are built upon a robust, multi-layer **Controller-based architecture**. This represents a key architectural departure from the monolithic class structure found in other data visualization libraries, and is specifically designed to leverage the strengths of a reactive, GPU-first rendering system.

### **Core Principle: Clear Separation of View, Controller, and Service**

Instead of a single `Mark` class that handles all data fetching, state, and rendering logic, our architecture separates these concerns into distinct, specialized layers. This ensures each part of the system has a single, clear responsibility and a well-defined API.

| Layer | Component(s) | Responsibility | Analogy |
| :--- | :--- | :--- | :--- |
| **View** | `*.svelte` Component | **Declares user intent** and reactively renders state from its controller. | The **Storefront** |
| **Controller** | `BaseMarkSetup.js`, `*MarkSetup.js` | **Translates visual semantics** into concrete data requirements and manages the component's lifecycle. | The **Manager** |
| **Service** | `DataClient.js` | **Provides a generic bridge** to the Mosaic backend for data fetching and state holding. | The **Courier** |

---

### **Four-Layer Mark Architecture in Detail**

#### 1. **Mark Component (`<DotsMark.svelte>`) - The View**
**Responsibility**: The user-facing Svelte component that gathers props and delegates all logic to its controller.
- **Declarative API**: Provides a simple, props-based API where users pass in `mosaic-sql` expressions (`<BarMark x="category" y={count()} />`).
- **Controller Instantiation**: Creates and manages the lifecycle of its corresponding `*MarkSetup` controller.
- **Reactive Rendering**: Listens to state changes from its `setup` controller (`client.arrowTable`, `gpuReady`, `error`) and passes the results to a low-level WebGPU renderer (e.g., `<Dots>`).
- **"Dumb" by Design**: Contains no business logic, query building, or complex state management.

#### 2. **Specialized Controller (`DensityMarkSetup.js`) - The Specialist Manager**
**Responsibility**: Encapsulates the unique data logic for a specific, complex mark type.
- **Inheritance**: `extends BaseMarkSetup` to inherit all common functionality.
- **Query Overriding**: Implements a custom `buildQuery()` method to generate the specialized SQL needed for that mark (e.g., using `bin2d` for a heatmap). This is the primary extension point for new mark types.
- **Context-Aware**: Uses its knowledge of the mark's visual requirements to construct the correct queries (e.g., an ordered `DISTINCT` query for a sorted bar chart's categorical domain).

#### 3. **Generic Controller (`BaseMarkSetup.js`) - The General Manager**
**Responsibility**: Manages the common lifecycle and state for *any* mark, providing a reusable foundation.
- **Lifecycle Orchestration**: The `setup()` method orchestrates the entire initialization flow: scale registration, client creation, metadata fetching, and domain setting.
- **Scale Registration**: Communicates the mark's scale requirements to the `ChartScales` coordinator.
-   **Data Requirement Logic**: Contains the logic to:
    -   Build the `fieldRequests` for continuous scale extents (`min`/`max`).
    -   Fetch and set domains for categorical scales (`DISTINCT` query).
- **Default Query Builder**: Provides a default `buildQuery()` that correctly handles `mosaic-sql` expressions, aggregations, and automatic `GROUP BY` clause generation for simple marks.
- **State Management**: Holds the reactive `$state` (`client`, `gpuReady`, `error`) that the Svelte component consumes.

#### 4. **`DataClient.js` - The Service & Adapter**
**Responsibility**: A generic, reusable service that communicates with the Mosaic backend and holds the resulting data state.
- **Mosaic Integration**: `extends MosaicClient`, making it a valid participant in the Mosaic ecosystem (selections, caching, pre-aggregation). It adapts our application's needs to the `MosaicClient` API.
- **Query Execution**: Takes a fully-formed `Query` object (built by its `MarkSetup` controller) and executes it via the `Coordinator`.
- **State Holding**: It is the stateful container for `arrowTable`, `loading`, `error`, and `fieldInfo`.
- **Decoupled & Generic**: It has **zero dependencies** on Svelte context or any chart-specific visual logic.

---


### **Data & Initialization Flow: A Reactive State machine (Corrected)**

The lifecycle of a mark is no longer a simple, imperative set of steps but a robust, declarative **state machine** orchestrated by Svelte 5's reactivity. The `BaseMarkSetup` controller manages a series of state flags that are flipped as each asynchronous step completes. This ensures that the system is resilient to timing issues and that data fetching and GPU preparation happen in a predictable, efficient order.

The entire process is kicked off when a mark component (e.g., `<DotsMark>`) is mounted.

#### **Visualizing the Flow**

```
        Mark Component / Controller                  Mosaic Coordinator / DataClient
┌───────────────────────────────────────┐         ┌───────────────────────────────────────┐
| 1. <DotsMark> mounts, creates         |         |                                       |
|    `BaseMarkSetup` controller.        |         |                                       |
|    Calls `registerInitialScales()`    |         |                                       |
└──────────────────┬────────────────────┘         |                                       |
                   │ (Scale requirements updated) |                                       |
┌──────────────────▼────────────────────┐         |                                       |
| 2. `$effect` chain begins in          |         |                                       |
|    `BaseMarkSetup`:                     |         |                                       |
|    - `scaleStatesReady` → true        |         |                                       |
|    - `scaleMappingsReady` → true      |         |                                       |
|    - `clientCreated` → true           |         |                                       |
|    (creates `DataClient` instance)    |         |                                       |
└──────────────────┬────────────────────┘         |                                       |
                   │ `coordinator.connect(client)`│                                       |
                   ├─────────────────────────────►│ 3. Hand-off to Mosaic. Coordinator  |
                   │                              │    takes ownership of client lifecycle. |
                   │                              └──────────────────┬────────────────────┘
                   │                                                 │ `client.prepare()`
┌──────────────────▼────────────────────┐         ┌──────────────────▼────────────────────┐
| 6. `$effect` chain resumes:           |         | 4. `DataClient` executes `fieldRequests`|
|    - `continuousDomainsSet` → true    |         |    (e.g., MIN/MAX queries) to get     |
|    (sets min/max on linear scales)    |         |    metadata.                          |
|    - `categoricalFetchStarted` → true |         |                                       |
|    (triggers DISTINCT query)          |         |                                       |
└──────────────────┬────────────────────┘         └──────────────────┬────────────────────┘
                   │ `await #fetchCategorical()`                    │ `this.fieldInfo` populated
                   │                              ◄─────────────────┤
┌──────────────────▼────────────────────┐         ┌──────────────────▼────────────────────┐
| 7. Final fetch completes:             |         | 8. In parallel, Coordinator issues    |
|    `categoricalDataFetched` → true    |         |    the main data query for the mark.  |
└──────────────────┬────────────────────┘         └──────────────────┬────────────────────┘
                   │ `gpuReady` now `true`                           │ `client.arrowTable` populated
┌──────────────────▼────────────────────┐         ┌──────────────────▼────────────────────┐
| 9. Svelte View (`<DotsMark>`) finally |         |                                       |
|    renders the low-level GPU          |         |                                       |
|    renderer (`<Dots>`), passing it    |         |                                       |
|    the `arrowTable`.                  |         |                                       |
└───────────────────────────────────────┘         └───────────────────────────────────────┘
```

#### **Step-by-Step Breakdown**

1.  **Mount & Initial Registration (`onMount` in Mark.svelte):**
    *   The `<DotsMark>` component is mounted and instantiates its `BaseMarkSetup` controller.
    *   It immediately calls `setup.registerInitialScaleRequirements()`, which informs the `ChartScales` coordinator of its needs (e.g., `'linear'`, `'band'`). This is the **ignition key** for the entire process.

2.  **The Reactive Chain Reaction (`$effect`s in `BaseMarkSetup`):**
    *   A series of Svelte `$effect`s within `BaseMarkSetup` now take over, creating a reactive chain reaction. Each effect waits for the previous step's state flag to become `true` before executing its logic and setting its own flag.
    *   This chain handles:
        *   Waiting for the chart's scale state objects (`xScaleState`, `yScaleState`) to be ready.
        *   Mapping the mark's `x`/`y` encodings to the correct scale state instances.
        *   Finally, creating the `DataClient` instance.

3.  **Hand-off to Mosaic (`coordinator.connect()`):**
    *   Upon creation, the `DataClient` is connected to the main Mosaic `Coordinator`. The `Coordinator` now takes ownership of the client's lifecycle, which is crucial for managing queries and caching across the application.

4.  **Metadata Fetch (`DataClient.prepare()`):**
    *   The Mosaic `Coordinator` calls the client's `prepare()` method.
    *   The `DataClient` executes the initial `fieldRequests` it was given (e.g., `SELECT MIN(x), MAX(x) FROM ...`) to fetch the necessary metadata for setting up continuous scale domains.
    *   When complete, it sets its public, reactive state: `client.fieldInfo = ...`.

5.  **Resuming the Reactive Chain (`$effect` for continuous domains):**
    *   Back in `BaseMarkSetup`, an `$effect` that was waiting for `client.fieldInfo` to be populated now triggers.
    *   It reads the fetched `min`/`max` values and calls `scaleState.addMark(...)` to set the initial domain for any **continuous** scales.

6.  **Final Domain Fetch (Categorical):**
    *   The completion of the previous step triggers the final effect in the chain.
    *   This effect calls the async `#fetchCategoricalDomains()` method, which runs any necessary `SELECT DISTINCT ...` queries for band or point scales.

7.  **The "Ready" Signal (`gpuReady`):**
    *   Once the categorical domain fetch completes, the final state flag, `categoricalDataFetched`, is set to `true`.
    *   This causes the `$derived` property `setup.gpuReady` to finally evaluate to `true`.

8.  **View Renders:**
    *   The Svelte View (`<DotsMark.svelte>`), which was reactively waiting on `setup.gpuReady`, now receives the signal.
    *   It renders its low-level `<Dots>` WebGPU component. Simultaneously, the main data query has been executing in the background, and the `client.arrowTable` is passed to the renderer, which can now draw the marks.

#### **Key Advantages of this Architecture:**

*   **Declarative & Robust**: The flow is driven by state changes, not imperative calls, making it resilient to race conditions and complex asynchronous timing.
*   **Efficient**: Metadata queries are dispatched early and in parallel where possible.
*   **Extensible**: New, complex marks can easily extend `BaseMarkSetup` and tap into this lifecycle without rewriting boilerplate.
*   **Debuggable**: The state flags (`#scaleStatesReady`, `#clientCreated`, etc.) provide a clear, step-by-step trace of the initialization process.