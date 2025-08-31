// src/lib/scales/ScaleRegistry.svelte.js
import { setContext, getContext } from 'svelte';
import { LinearScaleState } from "./LinearScaleState.svelte.js";
import { BandScaleState } from "./BandScaleState.svelte.js";
import { scaleOrdinal } from 'd3-scale';

class ScaleRegistry {
  // #scaleUsage = $state(new Map());

  constructor() {
    this.registryId = Math.random().toString(36).slice(2, 8);
    console.log(`🏗️ NEW ScaleRegistry created: ${this.registryId}`);

    this.scales = {
      linear: new Map(),
      band: new Map(),
      ordinal: new Map(),
    }

    this.scaleUsage = $state(new Map());
  }

  getOrCreateScale(name, type='linear', config = {}, chartId = null, gpuCoordinator = null) {
    // Create unique key that includes configuration
    const configKey = Object.keys(config).length > 0 ? `-${JSON.stringify(config)}` : '';
    const key = `${name}-${type}${configKey}`;
    
    if (!this.scales[type].has(key)) {
      console.log(`🆕 Registry ${this.registryId} creating NEW scale: ${name} (${type})`, {
        config: Object.keys(config).length > 0 ? config : 'default'
      });
      
      if (type === 'linear') {
        this.scales[type].set(key, new LinearScaleState(name, undefined, type, undefined, config, gpuCoordinator));
      } else if (type === 'band') {
        this.scales[type].set(key, new BandScaleState(name, [], config));
      } else if (type === 'ordinal') {
        // TODO: fix color scale support, simple default for penguins dataset:
        this.scales[type].set(key, scaleOrdinal()
          .range(['#EFB605', '#FFF84A', '#FF0266'])
          .domain(['Adelie', 'Gentoo', 'Chinstrap']));
      }
    } else {
      console.log(`♻️ Registry ${this.registryId} reusing existing scale: ${name} (${type})`);
    }
    const scale = this.scales[type].get(key);

    if (chartId && scale) {
      if (!this.scaleUsage.has(scale)) {
        this.scaleUsage.set(scale, new Set());
      }
      this.scaleUsage.get(scale).add(chartId);
      console.log('scale usage from registration', this.scaleUsage)
    }

    return scale;
    // return this.scales[type].get(key);
  }

  removeChartUsage(chartId) {
    for (const [scale, chartIds] of this.scaleUsage) {
      chartIds.delete(chartId);
      if (chartIds.size === 0) {
        this.scaleUsage.delete(scale);
      }
    }
  }
}



// Create and set the Scale Registry context
export function setScaleRegistry() {
  const state = new ScaleRegistry();
  return setContext('scale-registry', state);
}

// Retrieve a specific scale with configuration support
export function getScaleState(name, type='linear', config = {}, gpuCoordinator = null, chartId = null) {
  const scaleRegistry = getContext('scale-registry');
  
  if (!scaleRegistry) {
    console.error('Scale Registry context missing. Make sure to call setScaleRegistry() in a parent component.');
    return null;
  }

  const scaleInstance = scaleRegistry.getOrCreateScale(name, type, config, chartId, gpuCoordinator);
  
  return scaleInstance;
}