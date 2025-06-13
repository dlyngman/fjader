// Future Bar Mark Examples with proper scale type checking

// ===== BarXMark.svelte (Vertical bars) =====
/*
<script>
  import { DataClient } from '$lib/data-clients/DataClient.svelte.js';
  import { getContext, onMount, onDestroy, untrack } from 'svelte';
  import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
  import { Rects } from '$lib/components'; // Future Rects renderer

  let { 
    table, 
    selection, 
    x,        // Categorical data (species, categories)
    y,        // Continuous data (aggregated values)
    color, 
    alpha = 0.8,
    limit = 5000 
  } = $props();

  const coordinator = getContext('mosaic-coordinator');
  const c = getContext('chart');
  const markId = `barx-${crypto.randomUUID().slice(0, 8)}`;

  // Vertical bars: MANDATE categorical x, PREFER continuous y
  c.registerScaleType('x', 'band', SCALE_PRIORITIES.MANDATE, markId);   // MUST be band
  c.registerScaleType('y', 'linear', SCALE_PRIORITIES.PREFER, markId);  // Prefer linear

  // Check what we actually got after scale resolution
  let actualXScaleType = $derived(c.scaleTypes?.x || 'band');
  let actualYScaleType = $derived(c.scaleTypes?.y || 'linear');

  // Strict validation: BarX REQUIRES band scale for x-axis
  let scaleCompatibilityError = $derived.by(() => {
    if (actualXScaleType !== 'band') {
      return `BarXMark requires band scale for x-axis, got: ${actualXScaleType}`;
    }
    
    // Y-axis is more flexible but warn if unexpected
    if (actualYScaleType !== 'linear' && actualYScaleType !== 'identity') {
      return `BarXMark works best with linear y-axis, got: ${actualYScaleType}`;
    }
    
    return null;
  });

  // ... DataClient setup ...
</script>

{#if scaleCompatibilityError}
  <text fill="red">Scale Error: {scaleCompatibilityError}</text>
{:else if client?.arrowTable}
  <Rects
    data={client.arrowTable}
    dataVersion={client.dataVersion}
    xScaleType={actualXScaleType}  <!-- Pass ACTUAL resolved types -->
    yScaleType={actualYScaleType}
    alpha={alpha}
    baseline="zero"
  />
{/if}
*/

// ===== BarYMark.svelte (Horizontal bars) =====
/*
<script>
  // ... similar setup ...

  // Horizontal bars: PREFER continuous x, MANDATE categorical y  
  c.registerScaleType('x', 'linear', SCALE_PRIORITIES.PREFER, markId);
  c.registerScaleType('y', 'band', SCALE_PRIORITIES.MANDATE, markId);

  let actualXScaleType = $derived(c.scaleTypes?.x || 'linear');
  let actualYScaleType = $derived(c.scaleTypes?.y || 'band');

  let scaleCompatibilityError = $derived.by(() => {
    if (actualYScaleType !== 'band') {
      return `BarYMark requires band scale for y-axis, got: ${actualYScaleType}`;
    }
    return null;
  });
</script>

{#if scaleCompatibilityError}
  <text fill="red">Scale Error: {scaleCompatibilityError}</text>
{:else if client?.arrowTable}
  <Rects
    data={client.arrowTable}
    dataVersion={client.dataVersion}
    xScaleType={actualXScaleType}  <!-- ACTUAL types, not requested -->
    yScaleType={actualYScaleType}
    alpha={alpha}
    baseline="zero"
    orientation="horizontal"
  />
{/if}
*/

// ===== RectMark.svelte (General rectangles - Very flexible) =====
/*
<script>
  // General rectangles are very flexible
  c.registerScaleType('x', 'linear', SCALE_PRIORITIES.ACCEPT, markId);  // Accept anything
  c.registerScaleType('y', 'linear', SCALE_PRIORITIES.ACCEPT, markId);

  let actualXScaleType = $derived(c.scaleTypes?.x || 'linear');
  let actualYScaleType = $derived(c.scaleTypes?.y || 'linear');

  // RectMark is very flexible - can work with any scale type
  let scaleCompatibilityError = $derived.by(() => {
    // Only error for truly unsupported scale types (none currently)
    return null;
  });
</script>

{#if client?.arrowTable}
  <Rects
    data={client.arrowTable}
    dataVersion={client.dataVersion}
    xScaleType={actualXScaleType}  <!-- Adapts to whatever was resolved -->
    yScaleType={actualYScaleType}
    alpha={alpha}
  />
{/if}
*/

// ===== Usage Examples =====

/*
<!-- This works fine - dots adapt to whatever scales are resolved -->
<DotsMark 
  table="penguins" 
  x="bill_length" 
  y="bill_depth"
  preferredXScaleType="linear"   <!-- Preference, not guarantee -->
  preferredYScaleType="linear" 
/>

<!-- This will MANDATE band scale for x-axis -->
<BarXMark 
  table="sales" 
  x="category" 
  y={sum("amount")}
  <!-- No scale type props needed - BarX knows what it needs -->
/>

<!-- Mixing marks: BarX mandates band x-axis, dots adapt -->
<ChartContainer xLabel="category" yLabel="amount">
  <!-- This mandates x must be band scale -->
  <BarXMark table="sales" x="category" y={sum("amount")} />
  
  <!-- This adapts: will get band x-axis, warns in console -->
  <DotsMark table="sales" x="category" y="individual_sales" 
            preferredXScaleType="linear" />  <!-- Will get band instead -->
</ChartContainer>

<!-- This would error - incompatible requirements -->
<ChartContainer xLabel="sales" yLabel="category">
  <!-- This mandates x must be linear -->
  <SomeLinearOnlyMark x="sales" y="category" />
  
  <!-- This mandates x must be band - CONFLICT! -->  
  <BarXMark x="sales" y="category" />  <!-- Error: incompatible requirements -->
</ChartContainer>
*/

// ===== API Benefits =====

// 1. **Explicit Requirements**
//    - Each mark clearly states what it needs (MANDATE/PREFER/ACCEPT)
//    - Clear error messages when requirements conflict
//    - Visible validation logic in mark components

// 2. **Flexible Adaptation**
//    - Marks can adapt to resolved scale types
//    - Warnings when marks get something different than preferred
//    - Graceful degradation for compatible scale types

// 3. **No Hidden Magic**
//    - All scale checking happens in mark components
//    - Developer can see exactly what's happening
//    - Easy to debug scale resolution issues

// 4. **Clear Error Messages**
//    - "BarXMark requires band scale for x-axis, got: linear"
//    - "Scale types resolved differently than preferred"
//    - Helps developers understand mark requirements

// 5. **Composable and Predictable**
//    - Can mix marks with different requirements
//    - Priority system resolves conflicts deterministically  
//    - Clear rules for what works together