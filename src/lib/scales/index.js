// src/lib/scales/index.js
export {
  setScaleRegistry,
  getScaleState,
} from './ScaleRegistry.svelte.js'

export { LinearScaleState } from './LinearScaleState.svelte.js'
export { BandScaleState } from './BandScaleState.svelte.js'
export { 
  SCALE_PRIORITIES, 
  resolveScaleType,
  resolveScaleConfiguration  // NEW export
} from './ScalePriorities.js';

// NEW exports for extensible configuration
export { 
  RESOLUTION_STRATEGIES, 
  SCALE_CONFIG_SCHEMAS,
  validateConfigValue 
} from './ScaleConfigurationSchemas.js';