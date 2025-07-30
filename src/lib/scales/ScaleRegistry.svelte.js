// src/lib/scales/ScaleRegistry.svelte.js
import { setContext, getContext } from 'svelte';
import { LinearScaleState } from "./LinearScaleState.svelte.js";
import { BandScaleState } from "./BandScaleState.svelte.js";
import { scaleOrdinal } from 'd3-scale';

// Define the Scale Registry state class
class ScaleRegistry {
  constructor() {
    this.registryId = Math.random().toString(36).slice(2, 8);
    console.log(`🏗️ NEW ScaleRegistry created: ${this.registryId}`);

    this.scales = {
      linear: new Map(),
      band: new Map(),
      ordinal: new Map(),
    }
  }

  // ✅ ENHANCED: Accept configuration parameter
  getOrCreateScale(name, type='linear', config = {}) {
    // Create unique key that includes configuration
    const configKey = Object.keys(config).length > 0 ? `-${JSON.stringify(config)}` : '';
    const key = `${name}-${type}${configKey}`;
    
    if (!this.scales[type].has(key)) {
      console.log(`🆕 Registry ${this.registryId} creating NEW scale: ${name} (${type})`, {
        config: Object.keys(config).length > 0 ? config : 'default'
      });
      
      if (type === 'linear') {
        this.scales[type].set(key, new LinearScaleState(name, undefined, type, undefined, config));
      } else if (type === 'band') {
        this.scales[type].set(key, new BandScaleState(name, [], config));
      } else if (type === 'ordinal') {
        // Default color scale - this could be made configurable
        this.scales[type].set(key, scaleOrdinal()
          .range(['#EFB605', '#FFF84A', '#FF0266'])
          .domain(['Adelie', 'Gentoo', 'Chinstrap']));
      }
    } else {
      console.log(`♻️ Registry ${this.registryId} reusing existing scale: ${name} (${type})`);
    }
    
    return this.scales[type].get(key);
  }
}

// Create and set the Scale Registry context
export function setScaleRegistry() {
  const state = new ScaleRegistry();
  return setContext('scale-registry', state);
}

// ✅ ENHANCED: Retrieve a specific scale with configuration support
export function getScaleState(name, type='linear', config = {}) {
  const scaleRegistry = getContext('scale-registry');
  
  if (!scaleRegistry) {
    console.error('Scale Registry context missing. Make sure to call setScaleRegistry() in a parent component.');
    return null;
  }

  const scaleInstance = scaleRegistry.getOrCreateScale(name, type, config);
  
  return scaleInstance;
}