# Current Codebase Architecture Summary

## 🏗️ **Core Architecture**

### **ChartContainer.svelte** - *Main Chart Component*
**Responsibility**: Top-level chart orchestration and user interaction handling
- **Layout Management**: Creates and binds to `ChartLayout` instance
- **Scale Coordination**: Creates and manages reactive `ScaleCoordinator` instance  
- **User Interactions**: Handles all mouse/touch events (pan, zoom, crosshair)
- **Context Provider**: Provides comprehensive chart context to child components
- **Rendering Coordination**: Manages SVG layers (background, foreground) and canvas layer

**Key Features**:
- ✅ Clean separation of concerns (delegates to Layout + ScaleCoordinator)
- ✅ Event handling for pan, zoom, double-click reset
- ✅ Touch/pinch support
- ✅ Reactive to prop changes (xLabel, yLabel) - ScaleCoordinator recreated automatically
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

### **ScaleCoordinator.svelte.js** - *Scale Orchestration with Priority Resolution*
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

## 🎨 **Rendering System**

### **WebGPUCanvas.svelte** - *GPU Rendering Layer*
**Responsibility**: WebGPU rendering context and layer management
- **WebGPU Setup**: Device initialization, context configuration
- **Layer System**: Manages multiple rendering layers with z-ordering
- **MSAA Support**: Configurable anti-aliasing
- **Render Loop**: Frame-based rendering with invalidation
- **Context Provider**: Provides WebGPU context to child components

**Key Features**:
- ✅ High-performance GPU rendering
- ✅ Layer composition system
- ✅ Automatic redraw management
- ✅ MSAA for smooth graphics

### **WebGPUCirclesCanvasMark.svelte** - *Dot Mark Implementation*
**Responsibility**: Grammar of Graphics dot mark with data integration and scale registration
- **Mark Identity**: Unique mark ID used throughout lifecycle
- **Scale Registration**: Registers scale type requirements with priority system
- **Data Client Integration**: Uses DataClient for data fetching with mark ID
- **Error Handling**: Manages loading/error states
- **Cleanup**: Proper cleanup of scale requirements and data extents

**Key Features**:
- ✅ Grammar of Graphics alignment (dot mark, not scatter plot)
- ✅ Priority-based scale type registration  
- ✅ Unique mark identification for multi-instance support
- ✅ Automatic data management with consistent ID usage
- ✅ Proper cleanup preventing interference between marks

### **WebGPUCirclesColor.svelte** - *Low-Level Circle Renderer*
**Responsibility**: Direct WebGPU circle rendering with color encoding
- **Shader Management**: Vertex/fragment shader compilation
- **Buffer Management**: Efficient GPU buffer creation and updates
- **Color Encoding**: Integration with ordinal color scales
- **Performance Optimization**: Instanced rendering, SDF circles
- **Resource Cleanup**: Proper GPU resource management

**Key Features**:
- ✅ High-performance instanced rendering
- ✅ SDF-based smooth circles
- ✅ Color scale integration
- ✅ Efficient buffer management

---

## 🔄 **Data Flow & Reactivity**

### **Current Data Flow (Implemented)**:
1. **Parent** updates chartConfig
2. **ChartContainer** receives new xLabel/yLabel props
3. **ScaleCoordinator** recreated with new labels (via `$derived`)
4. **New scale states** retrieved from registry based on resolved scale types
5. **Charts sync** automatically if sharing scale states

### **Proposed Enhanced Data Flow (Future)**:
1. **Generic DataClient** receives any Mosaic SQL expression (`sum("amount")`, `count()`, complex chains)
2. **DataClient Query Builder** parses expression and constructs SQL query automatically
3. **Mosaic Coordinator** executes query with pre-aggregation caching
4. **Aggregated data** returned (10-100 rows instead of millions)
5. **Reactive Derivations** process aggregated data through visual transformations
6. **Alternative: Functional Pipeline** processes complex multi-step transformations
7. **Scale states** updated with final processed extents including transform metadata
8. **WebGPU rendering** displays processed results efficiently

### **Mark Registration Flow**:
1. **Mark** creates unique ID: `dot-a1b2c3d4`
2. **Mark** registers scale requirements: `c.registerScaleType('x', 'linear', PREFER, markId)`
3. **ScaleCoordinator** collects all requirements and resolves conflicts
4. **Scale states** retrieved based on resolved types
5. **DataClient** uses same mark ID for extent registration
6. **Perfect traceability** throughout mark lifecycle

### **Interaction Flow**:
1. **User** pans/zooms in ChartContainer
2. **ChartContainer** delegates to ScaleCoordinator
3. **ScaleCoordinator** updates shared scale state (if scale type supports interactions)
4. **All charts** with same scale state update automatically via reactivity

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
- ScaleCoordinator recreation handles prop changes automatically

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
- High-performance WebGPU rendering
- Reactive prop updates with automatic ScaleCoordinator recreation
- Clean component architecture with grammar of graphics alignment
- Intelligent scale conflict resolution with helpful error messages
- Multiple mark instances work independently
- Database-first processing architecture design

### **🔧 Recent Major Improvements**:
- ✅ **Priority System**: Added Observable Plot-inspired scale type resolution
- ✅ **Mark Registration**: Marks declare their own scale requirements
- ✅ **Unique Identification**: Each mark gets unique ID used throughout lifecycle  
- ✅ **Grammar of Graphics**: Aligned with mark types (dot, bar, line) vs chart types
- ✅ **Enhanced Debugging**: Scale requirement inspection and conflict analysis
- ✅ **Multi-Instance Support**: Multiple marks of same type work independently
- ✅ **Context API**: Complete explicit context with all layout and scale methods
- ✅ **Database-First Architecture**: Optimal separation of database vs client processing

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

#### **Phase 4: Developer Experience & Tooling**
- Add comprehensive TypeScript definitions for better developer experience
- Create visual debugging tools for scale conflicts and data flow
- Build performance monitoring and optimization utilities
- Add comprehensive testing suite for all architectural components

#### **Phase 5: Advanced Features**
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


# 🎬 **Advanced Animation & GPU Coordination Architecture**

## 🎯 **Core Design Philosophy**

**JavaScript-Controlled, GPU-Executed Animation System**: Separate animation control (JavaScript) from animation execution (GPU) for optimal performance and developer experience while maintaining architectural consistency with existing reactive patterns.

---

## 🎨 **WebGPU Tween Interpolation Architecture**

### **AnimationCoordinator.svelte.js** - *JavaScript Animation Control*
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

### **GPU Animation Shaders** - *Parallel Interpolation Execution*
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

---

## 🏷️ **Category Lifecycle Management**

### **Enhanced BandScaleState** - *Smart Category Positioning*
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

---

## 🖥️ **GPU Coordination Architecture**

### **DashboardGPUProvider.svelte** - *Centralized Resource Management*
**Responsibility**: Single WebGPU context managing all charts in a dashboard
- **Resource Sharing**: Shared device, pipelines, shaders, and uniform buffers
- **Viewport Management**: Chart registration with coordinate mapping
- **Render Orchestration**: Single render pass for all charts with optimal ordering
- **Layer System**: Z-index based rendering with shared animation loop

**Key Features**:
- ✅ **~10x Performance**: Single GPU context vs multiple contexts
- ✅ **Resource Efficiency**: Shared pipelines, buffers, and shaders
- ✅ **Synchronized Animation**: Single animation loop coordinates all charts
- ✅ **Memory Optimization**: Eliminates GPU context switching overhead

### **Chart Registration System** - *Lightweight Chart Integration*
**Responsibility**: Register individual charts with the central GPU coordinator
- **Viewport Definition**: Chart boundaries and coordinate mapping
- **Draw Function Registration**: Chart-specific rendering logic
- **Resource Allocation**: Per-chart data buffers and bind groups
- **Event Coordination**: Mouse/touch event mapping to chart coordinates

**Registration API**:
```javascript
dashboardCoordinator.registerChart(chartId, {
  viewport: { x, y, width, height },
  drawFunction: (passEncoder, viewport) => { /* chart drawing */ },
  zIndex: 0,
  markTypes: ['dots', 'bars'], // For resource sharing
  updateFrequency: 'realtime' | 'ondemand'
});
```

**Resource Sharing Strategy**:
```javascript
// Shared across all charts in dashboard
sharedResources = {
  device: GPUDevice,
  pipelines: {
    'dots': GPURenderPipeline,
    'bars': GPURenderPipeline,
    'lines': GPURenderPipeline
  },
  uniformBuffers: {
    resolution: GPUBuffer,
    devicePixelRatio: GPUBuffer
  }
}

// Per-chart resources
chartResources = {
  [chartId]: {
    viewport: { x, y, width, height },
    dataBuffers: [GPUBuffer, ...],
    scaleParams: GPUBuffer,
    bindGroups: [GPUBindGroup, ...]
  }
}
```

---

## 🔧 **Context Integration Strategy**

### **setDivePlotCoordinators()** - *Unified Dashboard Setup*
**Responsibility**: Single initialization call for all dashboard-level coordination
- **Scale Registry**: Cross-chart scale state sharing
- **GPU Coordination**: Centralized WebGPU resource management
- **Dependency Management**: Ensures proper initialization order
- **Context Provision**: Makes both systems available to child components

**Integration API**:
```javascript
// Single call initializes complete dashboard coordination
setDivePlotCoordinators();

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

---

## 🖱️ **SVG Interaction Layer Strategy**

### **Foreground SVG Event Handling** - *Interaction Coordination*
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

---

## 📋 **Implementation Phases**

### **Phase 1: GPU Coordination Foundation** *(2 weeks)*
**1.1 Dashboard GPU Provider**
- Single WebGPU context with chart registration system
- Viewport management and coordinate mapping utilities
- Shared resource initialization (device, pipelines, buffers)
- Basic render orchestration with z-index ordering

**1.2 Context Integration**
- Implement `setDivePlotCoordinators()` unified setup function
- Integration with existing `setScaleRegistry()` 
- Context provider pattern for GPU coordinator access
- Update existing components to use coordinated GPU context

### **Phase 2: Animation Infrastructure** *(2 weeks)*
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

### **Phase 3: Advanced Animation Features** *(1-2 weeks)*
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

### **Phase 4: Performance & Polish** *(1 week)*
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

---

## 🎯 **Success Metrics**

### **Performance Targets**
- ✅ **120fps Animation**: 10+ animated charts simultaneously
- ✅ **<1ms Frame Time**: For animation progress updates
- ✅ **~10x Resource Efficiency**: vs separate GPU contexts per chart
- ✅ **Smooth Interruptions**: No janky animation redirections

### **Developer Experience Goals**
- ✅ **Simple API**: `<BarMark animate duration={800} easing={cubicOut} />`
- ✅ **Familiar Patterns**: Svelte `tweened()` integration throughout
- ✅ **Easy Racing Charts**: Minimal configuration for complex animations
- ✅ **Debugging Tools**: Clear visibility into animation state and performance

### **Architectural Benefits**
- ✅ **Consistent Patterns**: Aligns with existing reactive architecture
- ✅ **Clean Separation**: JavaScript control, GPU execution boundary
- ✅ **Resource Efficiency**: Shared GPU resources across dashboard
- ✅ **Extensible Foundation**: Easy to add new animation types and behaviors

---

## 🔍 **Architectural Validation**

This animation and GPU coordination strategy maintains and extends the core architectural principles:

**✅ Database-First Processing**: Animations work on pre-aggregated data
**✅ Priority-Based Scale Resolution**: Animation system respects scale conflicts  
**✅ Reactive Derivations**: Animation state flows through existing reactive patterns
**✅ Grammar of Graphics**: Animations are mark-based, not chart-type specific
**✅ Resource Sharing**: GPU coordination eliminates resource duplication
**✅ Separation of Concerns**: Clear boundaries between control and execution

**Bottom Line**: This architecture delivers professional-grade animated dashboards with GPU performance and Svelte simplicity, while maintaining the clean, extensible codebase established in the current system.