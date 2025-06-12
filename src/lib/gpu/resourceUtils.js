// src/lib/gpu/resourceUtils.js

import { ResourceCreationError } from './errors.js';

/**
 * Resource lifecycle states
 */
export const ResourceState = {
  CREATING: 'creating',
  READY: 'ready',
  DESTROYING: 'destroying',
  DESTROYED: 'destroyed',
  ERROR: 'error'
};

/**
 * Enhanced resource wrapper with lifecycle management
 */
export class ManagedResource {
  constructor(id, resource, metadata = {}) {
    this.id = id;
    this.resource = resource;
    this.metadata = metadata;
    this.state = ResourceState.READY;
    this.refCount = 0;
    this.createdAt = Date.now();
    this.lastUsed = Date.now();
    this.dependencies = new Set();
    this.dependents = new Set();
  }

  addRef() {
    if (this.state !== ResourceState.READY) {
      console.warn(`⚠️ Adding reference to resource ${this.id} in state ${this.state}`);
    }
    this.refCount++;
    this.lastUsed = Date.now();
    return this.refCount;
  }

  removeRef() {
    if (this.refCount > 0) {
      this.refCount--;
      this.lastUsed = Date.now();
    }
    return this.refCount;
  }

  addDependency(resourceId) {
    this.dependencies.add(resourceId);
  }

  addDependent(resourceId) {
    this.dependents.add(resourceId);
  }

  canDestroy() {
    return this.refCount === 0 && this.dependents.size === 0;
  }

  destroy() {
    if (this.state === ResourceState.DESTROYED) {
      console.warn(`⚠️ Resource ${this.id} already destroyed`);
      return;
    }

    if (!this.canDestroy()) {
      console.warn(`⚠️ Cannot destroy resource ${this.id}: refCount=${this.refCount}, dependents=${this.dependents.size}`);
      return false;
    }

    this.state = ResourceState.DESTROYING;
    
    try {
      // WebGPU resources don't always have explicit destroy methods
      if (this.resource && typeof this.resource.destroy === 'function') {
        this.resource.destroy();
      }
      this.state = ResourceState.DESTROYED;
      console.debug(`🗑️ Resource ${this.id} destroyed successfully`);
      return true;
    } catch (error) {
      this.state = ResourceState.ERROR;
      console.error(`❌ Failed to destroy resource ${this.id}:`, error);
      return false;
    }
  }

  getInfo() {
    return {
      id: this.id,
      type: this.metadata.type || 'unknown',
      state: this.state,
      refCount: this.refCount,
      age: Date.now() - this.createdAt,
      timeSinceLastUse: Date.now() - this.lastUsed,
      dependencies: Array.from(this.dependencies),
      dependents: Array.from(this.dependents),
      canDestroy: this.canDestroy()
    };
  }
}

/**
 * Advanced resource manager with dependency tracking and lifecycle management
 */
export class ResourceManager {
  constructor(name) {
    this.name = name;
    this.resources = new Map();
    this.factories = new Map();
    this.cleanupInterval = null;
    this.cleanupIntervalMs = 30000; // 30 seconds
    this.maxAge = 300000; // 5 minutes
    this.enabled = true;
  }

  /**
   * Register a factory function for creating resources of a specific type
   */
  registerFactory(type, factoryFn, dependencies = []) {
    this.factories.set(type, {
      create: factoryFn,
      dependencies
    });
  }

  /**
   * Create or retrieve a shared resource with automatic dependency management
   */
  async createSharedResource(id, type, factoryOptions = {}) {
    const existing = this.resources.get(id);
    
    if (existing) {
      if (existing.state === ResourceState.READY) {
        existing.addRef();
        console.debug(`♻️ Reusing resource ${id} (refs: ${existing.refCount})`);
        return existing.resource;
      } else {
        console.warn(`⚠️ Resource ${id} exists but is in state ${existing.state}`);
      }
    }

    const factory = this.factories.get(type);
    if (!factory) {
      throw new ResourceCreationError(type, { 
        reason: `No factory registered for type: ${type}`,
        id 
      });
    }

    console.debug(`🆕 Creating new resource ${id} of type ${type}`);

    // Create managed resource wrapper
    const managedResource = new ManagedResource(id, null, {
      type,
      factoryOptions,
      ...factoryOptions.metadata
    });
    
    managedResource.state = ResourceState.CREATING;
    this.resources.set(id, managedResource);

    try {
      // Create dependencies first
      const dependencyResources = {};
      for (const depType of factory.dependencies) {
        const depId = `${depType}-shared`;
        dependencyResources[depType] = await this.createSharedResource(depId, depType);
        managedResource.addDependency(depId);
        
        // Add reverse dependency
        const depResource = this.resources.get(depId);
        if (depResource) {
          depResource.addDependent(id);
        }
      }

      // Create the actual resource
      const resource = await factory.create(factoryOptions, dependencyResources);
      
      managedResource.resource = resource;
      managedResource.state = ResourceState.READY;
      managedResource.addRef();

      console.debug(`✅ Resource ${id} created successfully`);
      return resource;

    } catch (error) {
      managedResource.state = ResourceState.ERROR;
      this.resources.delete(id);
      
      console.error(`❌ Failed to create resource ${id}:`, error);
      throw new ResourceCreationError(type, { 
        reason: error.message,
        id,
        originalError: error 
      });
    }
  }

  /**
   * Release a reference to a shared resource
   */
  releaseSharedResource(id) {
    const resource = this.resources.get(id);
    if (!resource) {
      console.warn(`⚠️ Attempted to release unknown resource: ${id}`);
      return false;
    }

    const refCount = resource.removeRef();
    console.debug(`🔄 Released resource ${id} (refs: ${refCount})`);

    // Don't immediately destroy - let cleanup cycle handle it
    return true;
  }

  /**
   * Force immediate cleanup of unused resources
   */
  cleanup(force = false) {
    const now = Date.now();
    const toDestroy = [];

    for (const [id, resource] of this.resources) {
      const shouldDestroy = force || (
        resource.canDestroy() && 
        (now - resource.lastUsed) > this.maxAge
      );

      if (shouldDestroy) {
        toDestroy.push(id);
      }
    }

    let destroyedCount = 0;
    for (const id of toDestroy) {
      const resource = this.resources.get(id);
      if (resource && resource.destroy()) {
        this.resources.delete(id);
        destroyedCount++;
        
        // Clean up dependency references
        for (const depId of resource.dependencies) {
          const depResource = this.resources.get(depId);
          if (depResource) {
            depResource.dependents.delete(id);
          }
        }
      }
    }

    if (destroyedCount > 0) {
      console.debug(`🧹 Cleaned up ${destroyedCount} unused resources`);
    }

    return destroyedCount;
  }

  /**
   * Start automatic cleanup cycle
   */
  startCleanup() {
    if (this.cleanupInterval) {
      console.warn(`⚠️ Cleanup already running for ${this.name}`);
      return;
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalMs);

    console.debug(`🧹 Started automatic cleanup for ${this.name}`);
  }

  /**
   * Stop automatic cleanup cycle
   */
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      console.debug(`⏹️ Stopped automatic cleanup for ${this.name}`);
    }
  }

  /**
   * Get comprehensive resource statistics
   */
  getStats() {
    const stats = {
      totalResources: this.resources.size,
      byState: {},
      byType: {},
      totalRefs: 0,
      orphanedResources: 0,
      oldResources: 0,
      memoryEstimate: 0
    };

    const now = Date.now();

    for (const resource of this.resources.values()) {
      const info = resource.getInfo();
      
      // Count by state
      stats.byState[info.state] = (stats.byState[info.state] || 0) + 1;
      
      // Count by type
      stats.byType[info.type] = (stats.byType[info.type] || 0) + 1;
      
      // Total references
      stats.totalRefs += info.refCount;
      
      // Orphaned resources (no references)
      if (info.refCount === 0) {
        stats.orphanedResources++;
      }
      
      // Old resources
      if (info.age > this.maxAge) {
        stats.oldResources++;
      }
      
      // Memory estimate (rough)
      if (resource.metadata.estimatedSize) {
        stats.memoryEstimate += resource.metadata.estimatedSize;
      }
    }

    return stats;
  }

  /**
   * Get detailed information about all resources
   */
  getDetailedInfo() {
    return Array.from(this.resources.values()).map(resource => resource.getInfo());
  }

  /**
   * Destroy all resources and cleanup
   */
  destroy() {
    this.stopCleanup();
    
    const forcedCleanup = this.cleanup(true);
    console.log(`🧹 ${this.name} destroyed, cleaned up ${forcedCleanup} resources`);
    
    this.resources.clear();
    this.factories.clear();
  }
}

/**
 * Convenience functions for common resource operations
 */

let globalResourceManager = null;

export function getGlobalResourceManager() {
  if (!globalResourceManager) {
    globalResourceManager = new ResourceManager('global');
    globalResourceManager.startCleanup();
  }
  return globalResourceManager;
}

export async function createSharedResource(id, type, options = {}) {
  const manager = getGlobalResourceManager();
  return manager.createSharedResource(id, type, options);
}

export function releaseSharedResource(id) {
  const manager = getGlobalResourceManager();
  return manager.releaseSharedResource(id);
}

export function trackResourceUsage() {
  const manager = getGlobalResourceManager();
  return manager.getStats();
}

/**
 * Resource usage monitoring utility
 */
export class ResourceMonitor {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.interval = options.interval || 10000; // 10 seconds
    this.maxHistory = options.maxHistory || 100;
    this.history = [];
    this.intervalId = null;
    this.onAlert = options.onAlert;
    this.thresholds = {
      orphanedResources: options.orphanedThreshold || 10,
      oldResources: options.oldResourceThreshold || 5,
      totalResources: options.totalResourceThreshold || 50,
      ...options.thresholds
    };
  }

  start() {
    if (!this.enabled || this.intervalId) return;

    this.intervalId = setInterval(() => {
      this.checkResources();
    }, this.interval);

    console.debug('📊 Resource monitoring started');
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.debug('📊 Resource monitoring stopped');
    }
  }

  checkResources() {
    const stats = trackResourceUsage();
    const timestamp = Date.now();
    
    this.history.push({ ...stats, timestamp });
    
    // Keep history size manageable
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // Check for alerts
    this.checkAlerts(stats);
  }

  checkAlerts(stats) {
    const alerts = [];

    if (stats.orphanedResources > this.thresholds.orphanedResources) {
      alerts.push({
        type: 'orphaned_resources',
        message: `High number of orphaned resources: ${stats.orphanedResources}`,
        severity: 'warning',
        value: stats.orphanedResources,
        threshold: this.thresholds.orphanedResources
      });
    }

    if (stats.oldResources > this.thresholds.oldResources) {
      alerts.push({
        type: 'old_resources',
        message: `High number of old resources: ${stats.oldResources}`,
        severity: 'warning',
        value: stats.oldResources,
        threshold: this.thresholds.oldResources
      });
    }

    if (stats.totalResources > this.thresholds.totalResources) {
      alerts.push({
        type: 'total_resources',
        message: `High total resource count: ${stats.totalResources}`,
        severity: 'error',
        value: stats.totalResources,
        threshold: this.thresholds.totalResources
      });
    }

    if (alerts.length > 0 && this.onAlert) {
      this.onAlert(alerts, stats);
    }
  }

  getHistory() {
    return [...this.history];
  }

  getLatestStats() {
    return this.history[this.history.length - 1] || null;
  }
}

// Development utilities
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  window.DivePlotResourceManager = getGlobalResourceManager();
}