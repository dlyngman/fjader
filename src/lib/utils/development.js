// src/lib/utils/development.js

/**
 * Development utilities and debugging tools for DivePlot
 * Only available in development mode
 */

// Global debugging utilities
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  
  /**
   * Global debugging interface for the browser console
   */
  window.DivePlotDebug = {
    
    /**
     * Get comprehensive information about GPU coordination
     */
    gpu() {
      const coordinator = window.__DEBUG_GPU_COORDINATOR;
      if (!coordinator) {
        console.error('❌ No GPU coordinator found. Make sure debugging is enabled.');
        return null;
      }
      
      return {
        logState: () => coordinator.debug().logState(),
        analyzeUsage: () => coordinator.debug().analyzeUsage(),
        getStats: () => coordinator.debug().getStats(),
        
        // Quick stats display
        quickStats() {
          const stats = coordinator.getPerformanceStats();
          
          console.log('📊 GPU Coordination Quick Stats:');
          console.table({
            'Registered Charts': stats.registeredCharts,
            'Mark Type Batches': stats.renderBatches.markTypeBatches,
            'Z-Index Batches': stats.renderBatches.zIndexBatches,
            'Shared Pipelines': stats.resourceStats.pipelines.length,
            'Shared Shaders': stats.resourceStats.shaders.length,
            'Uniform Buffers': stats.resourceStats.uniformBuffers.length
          });
          
          // Show resource sharing efficiency
          const totalPipelineRefs = stats.resourceStats.pipelines.reduce((sum, p) => sum + p.refCount, 0);
          const avgPipelineRefs = totalPipelineRefs / Math.max(stats.resourceStats.pipelines.length, 1);
          
          if (avgPipelineRefs > 2) {
            console.log('✅ Resource sharing efficiency: Excellent');
          } else if (avgPipelineRefs > 1) {
            console.log('⚠️ Resource sharing efficiency: Moderate'); 
          } else {
            console.log('❌ Resource sharing efficiency: Poor');
          }
          
          return stats;
        },
        
        // Chart-specific debugging
        debugChart(chartId) {
          if (!chartId) {
            console.log('Available charts:', Array.from(coordinator._registeredCharts.keys()));
            return;
          }
          return coordinator.debug().debugChart(chartId);
        },
        
        // Resource usage analysis
        analyzeResourceSharing() {
          const stats = coordinator.getPerformanceStats();
          const pipelines = stats.resourceStats.pipelines;
          const shaders = stats.resourceStats.shaders;
          
          if (pipelines.length === 0 && shaders.length === 0) {
            console.log('📊 No shared resources found');
            console.log('💡 This might indicate:');
            console.log('  - Charts are still initializing');
            console.log('  - Only one chart is active');
            console.log('  - Resource sharing is not working properly');
            return;
          }
          
          console.group('🔧 Resource Sharing Analysis');
          
          if (pipelines.length > 0) {
            console.log('🔀 Shared Pipelines:');
            pipelines.forEach(pipeline => {
              console.log(`  Pipeline: ${pipeline.type}`);
              console.log(`    References: ${pipeline.refCount}`);
              console.log(`    Age: ${(pipeline.ageMs / 1000).toFixed(1)}s`);
              
              if (pipeline.refCount === 1) {
                console.log(`    ⚠️ Only one reference - consider consolidation`);
              } else if (pipeline.refCount > 5) {
                console.log(`    ✅ High sharing efficiency`);
              } else {
                console.log(`    ✅ Good sharing efficiency`);
              }
              console.log('');
            });
          }
          
          if (shaders.length > 0) {
            console.log('🎨 Shared Shaders:');
            shaders.forEach(shader => {
              console.log(`  Shader: ${shader.type}`);
              console.log(`    References: ${shader.refCount}`);
              console.log(`    Age: ${(shader.ageMs / 1000).toFixed(1)}s`);
            });
          }
          
          // Overall efficiency assessment
          const totalPipelineRefs = pipelines.reduce((sum, p) => sum + p.refCount, 0);
          const totalShaderRefs = shaders.reduce((sum, s) => sum + s.refCount, 0);
          const avgPipelineSharing = totalPipelineRefs / Math.max(pipelines.length, 1);
          const avgShaderSharing = totalShaderRefs / Math.max(shaders.length, 1);
          
          console.log('📈 Overall Efficiency:');
          console.log(`  Average pipeline sharing: ${avgPipelineSharing.toFixed(1)} charts per pipeline`);
          console.log(`  Average shader sharing: ${avgShaderSharing.toFixed(1)} charts per shader`);
          
          if (avgPipelineSharing > 3) {
            console.log('  ✅ Excellent resource utilization');
          } else if (avgPipelineSharing > 1.5) {
            console.log('  ✅ Good resource utilization');
          } else {
            console.log('  ⚠️ Consider consolidating mark types for better sharing');
          }
          
          // Memory savings estimate
          const estimatedSavings = ((totalPipelineRefs + totalShaderRefs) - (pipelines.length + shaders.length)) / (totalPipelineRefs + totalShaderRefs) * 100;
          console.log(`  💾 Estimated memory savings: ~${estimatedSavings.toFixed(0)}% vs individual contexts`);
          
          console.groupEnd();
        }
      };
    },
    
    /**
     * Scale registry debugging
     */
    scales() {
      // This would need access to the scale registry
      // Implementation depends on how we expose scale debugging
      console.log('🎯 Scale debugging not yet implemented');
    },
    
    /**
     * WebGPU context debugging for individual charts
     */
    webgpu(chartId) {
      const canvases = document.querySelectorAll('canvas');
      
      if (!chartId) {
        console.log(`Found ${canvases.length} canvas elements`);
        canvases.forEach((canvas, i) => {
          console.log(`Canvas ${i}:`, {
            width: canvas.width,
            height: canvas.height,
            transform: canvas.style.transform
          });
        });
        return;
      }
      
      // Chart-specific WebGPU debugging
      console.log(`🎯 WebGPU debugging for chart ${chartId} not yet implemented`);
    },
    
    /**
     * Performance monitoring utilities
     */
    performance: {
      startMonitoring() {
        if (window.__DIVEPLOT_PERF_MONITOR) {
          console.warn('Performance monitoring already active');
          return;
        }
        
        window.__DIVEPLOT_PERF_MONITOR = {
          frameCount: 0,
          totalTime: 0,
          maxTime: 0,
          minTime: Infinity,
          start: performance.now(),
          frameTimes: [],
          originalRAF: window.requestAnimationFrame
        };
        
        const monitor = window.__DIVEPLOT_PERF_MONITOR;
        
        // Override requestAnimationFrame to track frame timing
        window.requestAnimationFrame = function(callback) {
          return monitor.originalRAF.call(this, function(timestamp) {
            const frameStart = performance.now();
            const result = callback(timestamp);
            const frameTime = performance.now() - frameStart;
            
            monitor.frameCount++;
            monitor.totalTime += frameTime;
            monitor.maxTime = Math.max(monitor.maxTime, frameTime);
            monitor.minTime = Math.min(monitor.minTime, frameTime);
            monitor.frameTimes.push(frameTime);
            
            // Keep last 1000 frame times for analysis
            if (monitor.frameTimes.length > 1000) {
              monitor.frameTimes.shift();
            }
            
            return result;
          });
        };
        
        console.log('📊 Performance monitoring started');
      },
      
      stopMonitoring() {
        const monitor = window.__DIVEPLOT_PERF_MONITOR;
        if (!monitor) {
          console.warn('Performance monitoring not active');
          return null;
        }
        
        // Restore original requestAnimationFrame
        if (monitor.originalRAF) {
          window.requestAnimationFrame = monitor.originalRAF;
        }
        
        const totalDuration = performance.now() - monitor.start;
        const avgFrameTime = monitor.totalTime / monitor.frameCount;
        const avgFPS = 1000 / avgFrameTime;
        
        // Calculate percentiles
        const sortedFrameTimes = monitor.frameTimes.slice().sort((a, b) => a - b);
        const p95Index = Math.floor(sortedFrameTimes.length * 0.95);
        const p99Index = Math.floor(sortedFrameTimes.length * 0.99);
        const p95Time = sortedFrameTimes[p95Index] || 0;
        const p99Time = sortedFrameTimes[p99Index] || 0;
        
        // Generate comprehensive report
        console.group('📊 Performance Report');
        console.log(`Duration: ${(totalDuration / 1000).toFixed(2)}s`);
        console.log(`Frame Count: ${monitor.frameCount.toLocaleString()}`);
        console.log(`Average Frame Time: ${avgFrameTime.toFixed(2)}ms`);
        console.log(`Average FPS: ${avgFPS.toFixed(1)}`);
        console.log(`Max Frame Time: ${monitor.maxTime.toFixed(2)}ms`);
        console.log(`Min Frame Time: ${monitor.minTime.toFixed(2)}ms`);
        console.log(`95th Percentile: ${p95Time.toFixed(2)}ms`);
        console.log(`99th Percentile: ${p99Time.toFixed(2)}ms`);
        
        // Performance assessment
        console.log('\n📈 Performance Assessment:');
        if (avgFPS >= 60) {
          console.log('✅ Excellent performance - consistently above 60 FPS');
        } else if (avgFPS >= 30) {
          console.log('⚠️ Acceptable performance - above 30 FPS');
        } else {
          console.log('❌ Poor performance - below 30 FPS average');
        }
        
        if (p95Time > 33.33) { // 30 FPS threshold
          console.log('⚠️ Inconsistent frame times detected');
        } else {
          console.log('✅ Consistent frame timing');
        }
        
        if (monitor.maxTime > 100) {
          console.log('⚠️ Frame spikes over 100ms detected');
        }
        
        // GPU coordination info if available
        const coordinator = window.__DEBUG_GPU_COORDINATOR;
        if (coordinator) {
          console.log('\n🔧 GPU Coordination Stats:');
          try {
            const stats = coordinator.getPerformanceStats();
            console.log(`Registered Charts: ${stats.registeredCharts}`);
            console.log(`Mark Type Batches: ${stats.renderBatches.markTypeBatches}`);
            console.log(`Shared Pipelines: ${stats.resourceStats.pipelines.length}`);
            console.log(`Shared Shaders: ${stats.resourceStats.shaders.length}`);
            
            // Resource sharing efficiency
            const totalRefs = stats.resourceStats.pipelines.reduce((sum, p) => sum + p.refCount, 0);
            const avgRefs = totalRefs / Math.max(stats.resourceStats.pipelines.length, 1);
            
            if (avgRefs > 2) {
              console.log('✅ Resource sharing working efficiently');
            } else if (avgRefs > 1) {
              console.log('⚠️ Moderate resource sharing');
            } else {
              console.log('❌ Poor resource sharing - check mark types');
            }
            
          } catch (error) {
            console.log('❌ Could not retrieve GPU stats');
          }
        }
        
        console.groupEnd();
        console.log('📊 Performance monitoring stopped');
        
        // Clean up
        const report = {
          duration: totalDuration,
          frameCount: monitor.frameCount,
          avgFrameTime,
          avgFPS,
          maxFrameTime: monitor.maxTime,
          minFrameTime: monitor.minTime,
          p95FrameTime: p95Time,
          p99FrameTime: p99Time
        };
        
        delete window.__DIVEPLOT_PERF_MONITOR;
        return report;
      },
      
      getStats() {
        const monitor = window.__DIVEPLOT_PERF_MONITOR;
        if (!monitor) {
          console.warn('Performance monitoring not active');
          return null;
        }
        
        const currentDuration = performance.now() - monitor.start;
        const avgFrameTime = monitor.totalTime / monitor.frameCount;
        return {
          frameCount: monitor.frameCount,
          duration: currentDuration,
          avgFrameTime,
          avgFPS: 1000 / avgFrameTime,
          maxFrameTime: monitor.maxTime,
          minFrameTime: monitor.minTime
        };
      }
    },
    
    /**
     * Help display
     */
    help() {
      console.group('🔍 DivePlot Debug Commands');
      console.log('DivePlotDebug.gpu() - GPU coordination debugging');
      console.log('DivePlotDebug.gpu().quickStats() - Quick GPU stats');
      console.log('DivePlotDebug.gpu().debugChart(id) - Debug specific chart');
      console.log('DivePlotDebug.webgpu() - WebGPU context info');
      console.log('DivePlotDebug.performance.startMonitoring() - Start perf monitoring');
      console.log('DivePlotDebug.performance.stopMonitoring() - Stop and report');
      console.log('DivePlotDebug.help() - Show this help');
      console.groupEnd();
    }
  };
  
  // Auto-display help on first load
  console.log('🔍 DivePlot debugging enabled. Type DivePlotDebug.help() for available commands.');
}

/**
 * Component-level debugging utilities
 */
export class ComponentDebugger {
  constructor(componentName, componentId) {
    this.componentName = componentName;
    this.componentId = componentId;
    this.enabled = process.env.NODE_ENV === 'development';
  }
  
  log(message, data) {
    if (!this.enabled) return;
    console.log(`🔧 [${this.componentName}:${this.componentId}] ${message}`, data || '');
  }
  
  warn(message, data) {
    if (!this.enabled) return;
    console.warn(`⚠️ [${this.componentName}:${this.componentId}] ${message}`, data || '');
  }
  
  error(message, error) {
    if (!this.enabled) return;
    console.error(`❌ [${this.componentName}:${this.componentId}] ${message}`, error || '');
  }
  
  time(label) {
    if (!this.enabled) return;
    console.time(`⏱️ [${this.componentName}:${this.componentId}] ${label}`);
  }
  
  timeEnd(label) {
    if (!this.enabled) return;
    console.timeEnd(`⏱️ [${this.componentName}:${this.componentId}] ${label}`);
  }
  
  group(title) {
    if (!this.enabled) return;
    console.group(`📁 [${this.componentName}:${this.componentId}] ${title}`);
  }
  
  groupEnd() {
    if (!this.enabled) return;
    console.groupEnd();
  }
}

/**
 * Resource tracking utility for debugging memory usage
 */
export class ResourceTracker {
  constructor(name) {
    this.name = name;
    this.resources = new Map();
    this.enabled = process.env.NODE_ENV === 'development';
  }
  
  track(id, resource, metadata = {}) {
    if (!this.enabled) return;
    
    this.resources.set(id, {
      resource,
      created: Date.now(),
      metadata
    });
    
    console.debug(`📋 [${this.name}] Tracking resource: ${id}`);
  }
  
  untrack(id) {
    if (!this.enabled) return;
    
    const tracked = this.resources.get(id);
    if (tracked) {
      const lifetime = Date.now() - tracked.created;
      console.debug(`🗑️ [${this.name}] Untracking resource: ${id} (lifetime: ${lifetime}ms)`);
      this.resources.delete(id);
    }
  }
  
  getStats() {
    if (!this.enabled) return null;
    
    const now = Date.now();
    const stats = {
      totalResources: this.resources.size,
      byType: {},
      oldestResource: null,
      newestResource: null
    };
    
    for (const [id, data] of this.resources) {
      const type = data.metadata.type || 'unknown';
      stats.byType[type] = (stats.byType[type] || 0) + 1;
      
      const age = now - data.created;
      if (!stats.oldestResource || age > stats.oldestResource.age) {
        stats.oldestResource = { id, age };
      }
      if (!stats.newestResource || age < stats.newestResource.age) {
        stats.newestResource = { id, age };
      }
    }
    
    return stats;
  }
  
  logStats() {
    if (!this.enabled) return;
    
    const stats = this.getStats();
    console.group(`📊 Resource Stats: ${this.name}`);
    console.log(`Total: ${stats.totalResources}`);
    console.log('By Type:', stats.byType);
    if (stats.oldestResource) {
      console.log(`Oldest: ${stats.oldestResource.id} (${stats.oldestResource.age}ms)`);
    }
    console.groupEnd();
  }
}

// Export development utilities
export const devUtils = {
  ComponentDebugger,
  ResourceTracker
};