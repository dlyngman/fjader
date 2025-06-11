import { setContext, getContext, hasContext } from 'svelte';
import { LinearScaleState } from "./LinearScaleState.svelte";
// import { BandScaleState } from "./BandScaleState.svelte";
// import { BandScaleStateCSS } from "./BandScaleStateCSS.svelte";
import { scaleLinear, scaleLog, scaleSqrt, scaleOrdinal } from 'd3-scale';

// Define the Scale Registry state class
class ScaleRegistry {
  constructor() {
    this.scales = {
      linear: new Map(),
      band: new Map(),
      bandCSS: new Map(),
      ordinal: new Map(),
    }
    // this.registryId = crypto.randomUUID();
  }

  getOrCreateScale(name, type='linear') {
    // console.log('Registry ID', this.registryId)
    // console.log('Current scales', this.scales)
    // console.log(`Scale type: ${type}`);
    // console.log(this.scales)
    if (!this.scales[type].has(name)) {
      // console.log(`Creating new scale: ${name}`);
      if (type === 'linear') {
        this.scales[type].set(name, new LinearScaleState(name));
      } else if (type === 'band') {
        this.scales[type].set(name, new BandScaleState(name));
      } else if (type === 'bandCSS') {
        this.scales[type].set(name, new BandScaleStateCSS(name));
      } else if (type === 'ordinal') {
        // check if some options object exists, then assign range, domain. Otherwise defaults?
        this.scales[type].set(name,  scaleOrdinal()
      	.range(['#EFB605', '#FFF84A', '#FF0266'])
      	.domain(['Adelie', 'Gentoo', 'Chinstrap']));
      }
    } else {
      // console.log(`Found existing scale: ${name}`);
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
// Add type of scale?
export function getScaleState(name, type='linear') {
  const scaleRegistry = getContext('scale-registry');
  
  if (!scaleRegistry) {
    console.error('Scale Registry context missing. Make sure to call setScaleRegistry() in a parent component.');
    return null;
  }
  
  return scaleRegistry.getOrCreateScale(name, type);
}

// // Helper to get the parent state directly if needed
// export function getScaleRegistry() {
//   const scaleRegistry = getContext('parent-state');
  
//   if (!scaleRegistry) {
//     console.error('Scale Registry context missing. Make sure to call setScaleRegistry() in a parent component.');
//     return null;
//   }
  
//   return scaleRegistry;
// }