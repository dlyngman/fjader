// Enhanced GPU coordination exports
export { 
  GPUCoordinator, 
  setGPUCoordinator, 
  getGPUContext 
} from './GPUCoordinator.svelte.js';

// Performance monitoring and debugging utilities
export { 
  ComponentDebugger,
  ResourceTracker,
  devUtils
} from '../utils/development.js';

// Error handling utilities
export { 
  GPUError,
  WebGPUNotSupportedError,
  ResourceCreationError,
  handleGPUError
} from './errors.js';

// Resource management utilities
export {
  createSharedResource,
  releaseSharedResource,
  trackResourceUsage
} from './resourceUtils.js';