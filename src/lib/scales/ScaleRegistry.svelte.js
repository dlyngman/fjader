import { setContext, getContext, hasContext } from 'svelte';
import { LinearScaleState } from "./LinearScaleState.svelte";
import { BandScaleState } from "./BandScaleState.svelte";
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

  getOrCreateScale(name, type='linear') {
    // console.log(`🔍 Registry ${this.registryId} getting scale: ${name} (${type})`);
    if (!this.scales[type].has(name)) {
      // console.log(`🆕 Registry ${this.registryId} creating NEW scale: ${name} (${type})`);
      if (type === 'linear') {
        this.scales[type].set(name, new LinearScaleState(name));
      } else if (type === 'band') {
        this.scales[type].set(name, new BandScaleState(name));
      } else if (type === 'ordinal') {
        // Default color scale - this could be made configurable
        this.scales[type].set(name,  scaleOrdinal()
      	  .range(['#EFB605', '#FFF84A', '#FF0266'])
      	  .domain(['Adelie', 'Gentoo', 'Chinstrap']));
      }
    } else {
      // console.log(`♻️ Registry ${this.registryId} reusing existing scale: ${name} (${type})`);
    }
    return this.scales[type].get(name);
  }
  
}

// Create and set the Scale Registry context
export function setScaleRegistry() {
  const state = new ScaleRegistry();
  return setContext('scale-registry', state);
}

// Retrieve a specific scale from the Scale Registry context
export function getScaleState(name, type='linear') {
  const scaleRegistry = getContext('scale-registry');
  
  if (!scaleRegistry) {
    console.error('Scale Registry context missing. Make sure to call setScaleRegistry() in a parent component.');
    return null;
  }

  const scaleInstance = scaleRegistry.getOrCreateScale(name, type);
  
  // // ✅ ADD: Debug what we're returning
  // console.log(`🎯 getScaleState(${name}, ${type}) returning:`, {
  //   registryId: scaleRegistry.registryId,
  //   scaleInstance,
  //   scaleInstanceId: scaleInstance?.name,
  //   scaleObject: scaleInstance
  // });
  
  return scaleRegistry.getOrCreateScale(name, type);
}