// src/lib/gpu/errors.js

/**
 * Base class for GPU-related errors
 */
export class GPUError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'GPUError';
    this.context = context;
    this.timestamp = Date.now();
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      context: this.context,
      timestamp: this.timestamp,
      stack: this.stack
    };
  }
}

/**
 * Error thrown when WebGPU is not supported
 */
export class WebGPUNotSupportedError extends GPUError {
  constructor(reason = 'Unknown') {
    super(`WebGPU is not supported: ${reason}`, { reason });
    this.name = 'WebGPUNotSupportedError';
  }

  static detect() {
    if (typeof navigator === 'undefined') {
      return new WebGPUNotSupportedError('Running in non-browser environment');
    }
    
    if (!navigator.gpu) {
      return new WebGPUNotSupportedError('navigator.gpu not available');
    }
    
    return null; // WebGPU appears to be supported
  }
}

/**
 * Error thrown when GPU resource creation fails
 */
export class ResourceCreationError extends GPUError {
  constructor(resourceType, details = {}) {
    super(`Failed to create GPU resource: ${resourceType}`, { 
      resourceType, 
      ...details 
    });
    this.name = 'ResourceCreationError';
  }
}

/**
 * Error thrown when GPU context configuration fails
 */
export class ContextConfigurationError extends GPUError {
  constructor(details = {}) {
    super('Failed to configure WebGPU context', details);
    this.name = 'ContextConfigurationError';
  }
}

/**
 * Error thrown when render operations fail
 */
export class RenderError extends GPUError {
  constructor(stage, details = {}) {
    super(`Render error in stage: ${stage}`, { stage, ...details });
    this.name = 'RenderError';
  }
}

/**
 * Error recovery strategies
 */
export const ErrorRecoveryStrategies = {
  RETRY: 'retry',
  FALLBACK: 'fallback',
  DISABLE: 'disable',
  ABORT: 'abort'
};

/**
 * Enhanced error handler with recovery strategies
 */
export function handleGPUError(error, context = {}) {
  const errorInfo = {
    error: error instanceof GPUError ? error.toJSON() : {
      name: error.name || 'UnknownError',
      message: error.message || 'Unknown error occurred',
      stack: error.stack
    },
    context,
    timestamp: Date.now(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    webgpuSupported: typeof navigator !== 'undefined' ? !!navigator.gpu : false
  };

  // Log error with context
  console.error('🚨 GPU Error:', errorInfo);

  // Determine recovery strategy based on error type
  let strategy = ErrorRecoveryStrategies.ABORT;
  
  if (error instanceof WebGPUNotSupportedError) {
    strategy = ErrorRecoveryStrategies.FALLBACK;
  } else if (error instanceof ResourceCreationError) {
    strategy = ErrorRecoveryStrategies.RETRY;
  } else if (error instanceof ContextConfigurationError) {
    strategy = ErrorRecoveryStrategies.RETRY;
  } else if (error instanceof RenderError) {
    strategy = ErrorRecoveryStrategies.FALLBACK;
  }

  // Apply recovery strategy
  const recovery = {
    strategy,
    shouldRetry: strategy === ErrorRecoveryStrategies.RETRY,
    shouldFallback: strategy === ErrorRecoveryStrategies.FALLBACK,
    shouldDisable: strategy === ErrorRecoveryStrategies.DISABLE,
    shouldAbort: strategy === ErrorRecoveryStrategies.ABORT,
    
    // Retry with exponential backoff
    async retry(fn, maxAttempts = 3) {
      if (!this.shouldRetry) return false;
      
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
          await fn();
          console.log(`✅ Recovery successful after ${attempt} attempts`);
          return true;
        } catch (retryError) {
          console.warn(`⚠️ Retry attempt ${attempt} failed:`, retryError.message);
          if (attempt === maxAttempts) {
            console.error(`❌ All ${maxAttempts} retry attempts failed`);
            return false;
          }
        }
      }
      return false;
    },
    
    // Fallback to alternative rendering
    fallback(fallbackFn) {
      if (!this.shouldFallback) return false;
      
      try {
        console.log('🔄 Attempting fallback strategy...');
        fallbackFn();
        console.log('✅ Fallback strategy successful');
        return true;
      } catch (fallbackError) {
        console.error('❌ Fallback strategy failed:', fallbackError);
        return false;
      }
    }
  };

  // Send error to monitoring service in production
  if (context.reportErrors && typeof window !== 'undefined') {
    try {
      // This would integrate with your error reporting service
      window.dispatchEvent(new CustomEvent('diveplot-error', {
        detail: errorInfo
      }));
    } catch (reportingError) {
      console.warn('Failed to report error:', reportingError);
    }
  }

  return {
    errorInfo,
    recovery
  };
}

/**
 * Error boundary utility for components
 */
export class GPUErrorBoundary {
  constructor(componentName, options = {}) {
    this.componentName = componentName;
    this.maxRetries = options.maxRetries || 3;
    this.retryCount = 0;
    this.lastError = null;
    this.fallbackFn = options.fallbackFn;
    this.onError = options.onError;
  }

  async execute(fn) {
    try {
      const result = await fn();
      this.retryCount = 0; // Reset on success
      return result;
    } catch (error) {
      this.lastError = error;
      const handled = handleGPUError(error, { 
        component: this.componentName,
        retryCount: this.retryCount 
      });

      // Call custom error handler if provided
      if (this.onError) {
        this.onError(error, handled);
      }

      // Attempt recovery
      if (handled.recovery.shouldRetry && this.retryCount < this.maxRetries) {
        this.retryCount++;
        console.log(`🔄 Retrying ${this.componentName} (attempt ${this.retryCount}/${this.maxRetries})`);
        
        // Wait before retry
        await new Promise(resolve => 
          setTimeout(resolve, Math.pow(2, this.retryCount) * 100)
        );
        
        return this.execute(fn);
      }

      // Try fallback if available
      if (handled.recovery.shouldFallback && this.fallbackFn) {
        console.log(`🔄 Using fallback for ${this.componentName}`);
        return this.fallbackFn();
      }

      // Re-throw if no recovery possible
      throw error;
    }
  }

  reset() {
    this.retryCount = 0;
    this.lastError = null;
  }

  getStatus() {
    return {
      componentName: this.componentName,
      retryCount: this.retryCount,
      maxRetries: this.maxRetries,
      hasError: !!this.lastError,
      lastError: this.lastError?.message
    };
  }
}

/**
 * Development error utilities
 */
export const devErrorUtils = {
  /**
   * Simulate various GPU errors for testing
   */
  simulate: {
    webgpuNotSupported() {
      throw new WebGPUNotSupportedError('Simulated for testing');
    },
    
    resourceCreationFailed(resourceType = 'buffer') {
      throw new ResourceCreationError(resourceType, { 
        simulated: true,
        reason: 'Testing error handling' 
      });
    },
    
    contextConfigurationFailed() {
      throw new ContextConfigurationError({ 
        simulated: true,
        reason: 'Testing context configuration error' 
      });
    },
    
    renderFailed(stage = 'draw') {
      throw new RenderError(stage, { 
        simulated: true,
        reason: 'Testing render error' 
      });
    }
  },

  /**
   * Test error recovery mechanisms
   */
  testRecovery: {
    async retryMechanism() {
      console.log('🧪 Testing retry mechanism...');
      
      let attempts = 0;
      const testFn = () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Simulated failure');
        }
        return 'Success!';
      };

      const boundary = new GPUErrorBoundary('TestComponent', { maxRetries: 3 });
      
      try {
        const result = await boundary.execute(testFn);
        console.log(`✅ Retry test completed: ${result} (took ${attempts} attempts)`);
      } catch (error) {
        console.log(`❌ Retry test failed after ${attempts} attempts:`, error.message);
      }
    },

    fallbackMechanism() {
      console.log('🧪 Testing fallback mechanism...');
      
      const boundary = new GPUErrorBoundary('TestComponent', {
        fallbackFn: () => 'Fallback result'
      });
      
      boundary.execute(() => {
        throw new RenderError('test-stage');
      }).then(result => {
        console.log(`✅ Fallback test completed: ${result}`);
      }).catch(error => {
        console.log(`❌ Fallback test failed:`, error.message);
      });
    }
  }
};

// Development-only global error utilities
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  window.DivePlotErrorUtils = devErrorUtils;
}