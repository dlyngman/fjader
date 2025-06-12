// src/lib/utils/performance.js

/**
 * Performance benchmarking and monitoring tools for DivePlot
 */

/**
 * GPU performance metrics collector
 */
export class GPUPerformanceProfiler {
  constructor(name = 'GPUProfiler') {
    this.name = name;
    this.metrics = {
      frameCount: 0,
      totalRenderTime: 0,
      averageRenderTime: 0,
      maxRenderTime: 0,
      minRenderTime: Infinity,
      resourceCreationTime: 0,
      resourceCreationCount: 0,
      batchEfficiency: {
        totalBatches: 0,
        totalCharts: 0,
        averageChartsPerBatch: 0
      }
    };
    this.frameTimings = [];
    this.resourceTimings = [];
    this.isActive = false;
    this.startTime = null;
  }

  start() {
    if (this.isActive) {
      console.warn('Performance profiler already active');
      return;
    }

    this.isActive = true;
    this.startTime = performance.now();
    this.reset();
    
    console.log(`📊 GPU Performance profiling started: ${this.name}`);
  }

  stop() {
    if (!this.isActive) {
      console.warn('Performance profiler not active');
      return null;
    }

    this.isActive = false;
    const duration = performance.now() - this.startTime;
    
    // Finalize metrics
    this.metrics.averageRenderTime = this.metrics.totalRenderTime / this.metrics.frameCount;
    this.metrics.batchEfficiency.averageChartsPerBatch = 
      this.metrics.batchEfficiency.totalCharts / this.metrics.batchEfficiency.totalBatches;

    const report = this.generateReport(duration);
    console.log(`📊 GPU Performance profiling stopped: ${this.name}`);
    
    return report;
  }

  recordFrameTime(startTime, endTime) {
    if (!this.isActive) return;

    const frameTime = endTime - startTime;
    this.frameTimings.push(frameTime);
    
    this.metrics.frameCount++;
    this.metrics.totalRenderTime += frameTime;
    this.metrics.maxRenderTime = Math.max(this.metrics.maxRenderTime, frameTime);
    this.metrics.minRenderTime = Math.min(this.metrics.minRenderTime, frameTime);
  }

  recordResourceCreation(startTime, endTime, resourceType) {
    if (!this.isActive) return;

    const creationTime = endTime - startTime;
    this.resourceTimings.push({ time: creationTime, type: resourceType });
    
    this.metrics.resourceCreationCount++;
    this.metrics.resourceCreationTime += creationTime;
  }

  recordBatchInfo(batchCount, chartCount) {
    if (!this.isActive) return;

    this.metrics.batchEfficiency.totalBatches += batchCount;
    this.metrics.batchEfficiency.totalCharts += chartCount;
  }

  reset() {
    this.metrics = {
      frameCount: 0,
      totalRenderTime: 0,
      averageRenderTime: 0,
      maxRenderTime: 0,
      minRenderTime: Infinity,
      resourceCreationTime: 0,
      resourceCreationCount: 0,
      batchEfficiency: {
        totalBatches: 0,
        totalCharts: 0,
        averageChartsPerBatch: 0
      }
    };
    this.frameTimings = [];
    this.resourceTimings = [];
  }

  generateReport(duration) {
    const avgFPS = 1000 / this.metrics.averageRenderTime;
    const percentile95 = this.calculatePercentile(this.frameTimings, 95);
    const percentile99 = this.calculatePercentile(this.frameTimings, 99);

    return {
      summary: {
        name: this.name,
        duration: duration,
        totalFrames: this.metrics.frameCount,
        averageFPS: avgFPS,
        averageFrameTime: this.metrics.averageRenderTime,
        maxFrameTime: this.metrics.maxRenderTime,
        minFrameTime: this.metrics.minRenderTime,
        p95FrameTime: percentile95,
        p99FrameTime: percentile99
      },
      resources: {
        totalCreated: this.metrics.resourceCreationCount,
        totalCreationTime: this.metrics.resourceCreationTime,
        averageCreationTime: this.metrics.resourceCreationTime / this.metrics.resourceCreationCount,
        byType: this.groupResourcesByType()
      },
      batching: {
        ...this.metrics.batchEfficiency,
        efficiency: this.metrics.batchEfficiency.averageChartsPerBatch > 1 ? 'good' : 'poor'
      },
      frameTimings: this.frameTimings.slice(), // Copy for analysis
      warnings: this.generateWarnings(avgFPS, percentile95)
    };
  }

  calculatePercentile(values, percentile) {
    if (values.length === 0) return 0;
    
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[index];
  }

  groupResourcesByType() {
    const grouped = {};
    for (const timing of this.resourceTimings) {
      if (!grouped[timing.type]) {
        grouped[timing.type] = { count: 0, totalTime: 0 };
      }
      grouped[timing.type].count++;
      grouped[timing.type].totalTime += timing.time;
    }
    
    // Calculate averages
    for (const type in grouped) {
      grouped[type].averageTime = grouped[type].totalTime / grouped[type].count;
    }
    
    return grouped;
  }

  generateWarnings(avgFPS, p95FrameTime) {
    const warnings = [];
    
    if (avgFPS < 30) {
      warnings.push({
        type: 'performance',
        severity: 'error',
        message: `Low average FPS: ${avgFPS.toFixed(1)} (target: >30)`
      });
    } else if (avgFPS < 60) {
      warnings.push({
        type: 'performance',
        severity: 'warning',
        message: `Below optimal FPS: ${avgFPS.toFixed(1)} (target: 60)`
      });
    }
    
    if (p95FrameTime > 33.33) { // 30 FPS threshold
      warnings.push({
        type: 'consistency',
        severity: 'warning',
        message: `Inconsistent frame times: 95th percentile is ${p95FrameTime.toFixed(1)}ms`
      });
    }
    
    if (this.metrics.batchEfficiency.averageChartsPerBatch < 1.5) {
      warnings.push({
        type: 'batching',
        severity: 'info',
        message: 'Low batching efficiency - consider consolidating mark types'
      });
    }
    
    return warnings;
  }
}

/**
 * Resource usage monitor for memory analysis
 */
export class ResourceUsageMonitor {
  constructor() {
    this.snapshots = [];
    this.isMonitoring = false;
    this.interval = null;
    this.snapshotInterval = 1000; // 1 second
  }

  start(intervalMs = 1000) {
    if (this.isMonitoring) {
      console.warn('Resource monitoring already active');
      return;
    }

    this.isMonitoring = true;
    this.snapshotInterval = intervalMs;
    this.snapshots = [];
    
    // Take initial snapshot
    this.takeSnapshot();
    
    // Set up periodic snapshots
    this.interval = setInterval(() => {
      this.takeSnapshot();
    }, this.snapshotInterval);
    
    console.log('📊 Resource usage monitoring started');
  }

  stop() {
    if (!this.isMonitoring) {
      console.warn('Resource monitoring not active');
      return null;
    }

    this.isMonitoring = false;
    
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    console.log('📊 Resource usage monitoring stopped');
    return this.generateUsageReport();
  }

  takeSnapshot() {
    const timestamp = Date.now();
    
    // Get GPU coordinator stats if available
    let gpuStats = null;
    if (typeof window !== 'undefined' && window.__DEBUG_GPU_COORDINATOR) {
      try {
        gpuStats = window.__DEBUG_GPU_COORDINATOR.getPerformanceStats();
      } catch (error) {
        // Ignore errors in stats collection
      }
    }
    
    // Get browser memory info if available
    let memoryInfo = null;
    if (performance.memory) {
      memoryInfo = {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
      };
    }
    
    this.snapshots.push({
      timestamp,
      gpuStats,
      memoryInfo
    });
  }

  generateUsageReport() {
    if (this.snapshots.length < 2) {
      return { error: 'Insufficient data for analysis' };
    }

    const firstSnapshot = this.snapshots[0];
    const lastSnapshot = this.snapshots[this.snapshots.length - 1];
    const duration = lastSnapshot.timestamp - firstSnapshot.timestamp;

    const report = {
      duration,
      snapshotCount: this.snapshots.length,
      trends: this.analyzeTrends(),
      resourceLeaks: this.detectResourceLeaks(),
      memoryUsage: this.analyzeMemoryUsage(),
      recommendations: []
    };

    // Generate recommendations
    if (report.resourceLeaks.detected) {
      report.recommendations.push({
        type: 'memory',
        priority: 'high',
        message: 'Resource leaks detected - check component cleanup logic'
      });
    }

    if (report.memoryUsage.growthRate > 1024 * 1024) { // 1MB/second
      report.recommendations.push({
        type: 'memory',
        priority: 'medium',
        message: 'High memory growth rate detected'
      });
    }

    return report;
  }

  analyzeTrends() {
    const gpuResourceCounts = this.snapshots
      .filter(s => s.gpuStats)
      .map(s => s.gpuStats.registeredCharts);

    const memoryUsages = this.snapshots
      .filter(s => s.memoryInfo)
      .map(s => s.memoryInfo.usedJSHeapSize);

    return {
      gpuResources: {
        min: Math.min(...gpuResourceCounts),
        max: Math.max(...gpuResourceCounts),
        trend: this.calculateTrend(gpuResourceCounts)
      },
      memoryUsage: {
        min: Math.min(...memoryUsages),
        max: Math.max(...memoryUsages),
        trend: this.calculateTrend(memoryUsages)
      }
    };
  }

  detectResourceLeaks() {
    const gpuSnapshots = this.snapshots.filter(s => s.gpuStats);
    
    if (gpuSnapshots.length < 3) {
      return { detected: false, reason: 'insufficient_data' };
    }

    // Check for consistently growing resource counts
    let growthStreak = 0;
    for (let i = 1; i < gpuSnapshots.length; i++) {
      const prev = gpuSnapshots[i - 1].gpuStats;
      const curr = gpuSnapshots[i].gpuStats;
      
      if (curr.registeredCharts > prev.registeredCharts) {
        growthStreak++;
      } else {
        growthStreak = 0;
      }
    }

    const leakThreshold = Math.floor(gpuSnapshots.length * 0.7); // 70% of snapshots showing growth
    
    return {
      detected: growthStreak >= leakThreshold,
      confidence: growthStreak / gpuSnapshots.length,
      details: {
        growthStreak,
        totalSnapshots: gpuSnapshots.length,
        threshold: leakThreshold
      }
    };
  }

  analyzeMemoryUsage() {
    const memorySnapshots = this.snapshots.filter(s => s.memoryInfo);
    
    if (memorySnapshots.length < 2) {
      return { available: false };
    }

    const first = memorySnapshots[0].memoryInfo;
    const last = memorySnapshots[memorySnapshots.length - 1].memoryInfo;
    const duration = memorySnapshots[memorySnapshots.length - 1].timestamp - memorySnapshots[0].timestamp;
    
    const growthBytes = last.usedJSHeapSize - first.usedJSHeapSize;
    const growthRate = growthBytes / (duration / 1000); // bytes per second

    return {
      available: true,
      initialUsage: first.usedJSHeapSize,
      finalUsage: last.usedJSHeapSize,
      growth: growthBytes,
      growthRate,
      peakUsage: Math.max(...memorySnapshots.map(s => s.memoryInfo.usedJSHeapSize))
    };
  }

  calculateTrend(values) {
    if (values.length < 2) return 'insufficient_data';
    
    const first = values[0];
    const last = values[values.length - 1];
    const change = last - first;
    const percentChange = (change / first) * 100;
    
    if (Math.abs(percentChange) < 5) return 'stable';
    return percentChange > 0 ? 'increasing' : 'decreasing';
  }
}

/**
 * Comprehensive benchmark suite
 */
export class DivePlotBenchmark {
  constructor() {
    this.performanceProfiler = new GPUPerformanceProfiler('Benchmark');
    this.resourceMonitor = new ResourceUsageMonitor();
    this.results = {};
  }

  async runComprehensiveBenchmark(options = {}) {
    const {
      duration = 30000, // 30 seconds
      chartCount = 4,
      dataPoints = 1000,
      markTypes = ['dots'],
      interactionTests = true
    } = options;

    console.group('🚀 Starting DivePlot Comprehensive Benchmark');
    console.log('Configuration:', { duration, chartCount, dataPoints, markTypes });

    const benchmarkStart = performance.now();
    this.results = {};

    try {
      // Phase 1: Resource Creation
      console.log('📋 Phase 1: Resource Creation Benchmark');
      await this.benchmarkResourceCreation(chartCount, markTypes);

      // Phase 2: Rendering Performance
      console.log('🎨 Phase 2: Rendering Performance Benchmark');
      this.performanceProfiler.start();
      this.resourceMonitor.start();
      
      await this.benchmarkRendering(duration, dataPoints);
      
      const renderResults = this.performanceProfiler.stop();
      const resourceResults = this.resourceMonitor.stop();

      // Phase 3: Interaction Performance (if enabled)
      if (interactionTests) {
        console.log('🖱️ Phase 3: Interaction Performance Benchmark');
        await this.benchmarkInteractions();
      }

      // Compile final results
      this.results = {
        configuration: { duration, chartCount, dataPoints, markTypes },
        rendering: renderResults,
        resources: resourceResults,
        interactions: this.results.interactions || null,
        totalDuration: performance.now() - benchmarkStart
      };

      this.generateBenchmarkReport();
      
    } catch (error) {
      console.error('❌ Benchmark failed:', error);
      this.results.error = error.message;
    } finally {
      console.groupEnd();
    }

    return this.results;
  }

  async benchmarkResourceCreation(chartCount, markTypes) {
    // This would need integration with actual chart creation
    // For now, simulate the timing
    const creationTimes = [];
    
    for (let i = 0; i < chartCount; i++) {
      const start = performance.now();
      
      // Simulate resource creation delay
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const end = performance.now();
      creationTimes.push(end - start);
    }

    this.results.resourceCreation = {
      chartCount,
      totalTime: creationTimes.reduce((sum, time) => sum + time, 0),
      averageTime: creationTimes.reduce((sum, time) => sum + time, 0) / creationTimes.length,
      timings: creationTimes
    };
  }

  async benchmarkRendering(duration, dataPoints) {
    // This would integrate with actual rendering loop
    // For now, simulate render cycles
    const startTime = performance.now();
    let frameCount = 0;
    
    while (performance.now() - startTime < duration) {
      const frameStart = performance.now();
      
      // Simulate render work
      await new Promise(resolve => setTimeout(resolve, 8)); // ~120fps target
      
      const frameEnd = performance.now();
      this.performanceProfiler.recordFrameTime(frameStart, frameEnd);
      frameCount++;
    }

    console.log(`✅ Rendered ${frameCount} frames in ${duration}ms`);
  }

  async benchmarkInteractions() {
    // Simulate various interaction scenarios
    const interactions = ['pan', 'zoom', 'crosshair'];
    const results = {};

    for (const interaction of interactions) {
      const timings = [];
      
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        // Simulate interaction processing
        await new Promise(resolve => setTimeout(resolve, 5));
        const end = performance.now();
        
        timings.push(end - start);
      }

      results[interaction] = {
        averageTime: timings.reduce((sum, time) => sum + time, 0) / timings.length,
        maxTime: Math.max(...timings),
        minTime: Math.min(...timings)
      };
    }

    this.results.interactions = results;
  }

  generateBenchmarkReport() {
    console.group('📊 Benchmark Results Summary');
    
    if (this.results.rendering) {
      const r = this.results.rendering.summary;
      console.log(`🎨 Rendering Performance:`);
      console.log(`  Average FPS: ${r.averageFPS.toFixed(1)}`);
      console.log(`  Frame Time: ${r.averageFrameTime.toFixed(2)}ms (max: ${r.maxFrameTime.toFixed(2)}ms)`);
      
      if (r.averageFPS >= 60) {
        console.log('  ✅ Excellent performance');
      } else if (r.averageFPS >= 30) {
        console.log('  ⚠️ Acceptable performance');
      } else {
        console.log('  ❌ Poor performance - optimization needed');
      }
    }

    if (this.results.resources && this.results.resources.memoryUsage.available) {
      const m = this.results.resources.memoryUsage;
      const growthMB = m.growth / (1024 * 1024);
      console.log(`💾 Memory Usage:`);
      console.log(`  Growth: ${growthMB.toFixed(2)}MB over ${(this.results.configuration.duration / 1000).toFixed(1)}s`);
      console.log(`  Growth Rate: ${(m.growthRate / 1024).toFixed(2)}KB/s`);
    }

    if (this.results.resourceCreation) {
      const rc = this.results.resourceCreation;
      console.log(`🔧 Resource Creation:`);
      console.log(`  Average Time: ${rc.averageTime.toFixed(2)}ms per chart`);
      console.log(`  Total Time: ${rc.totalTime.toFixed(2)}ms for ${rc.chartCount} charts`);
    }

    console.groupEnd();
  }

  exportResults() {
    return JSON.stringify(this.results, null, 2);
  }
}

// Global benchmark utilities for development
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  window.DivePlotBenchmark = new DivePlotBenchmark();
  
  // Add quick benchmark function to global debug interface
  if (window.DivePlotDebug) {
    window.DivePlotDebug.benchmark = {
      async quick() {
        console.log('🚀 Running quick benchmark...');
        const results = await window.DivePlotBenchmark.runComprehensiveBenchmark({
          duration: 10000, // 10 seconds
          chartCount: 2,
          interactionTests: false
        });
        return results;
      },
      
      async full() {
        console.log('🚀 Running full benchmark...');
        const results = await window.DivePlotBenchmark.runComprehensiveBenchmark({
          duration: 30000, // 30 seconds
          chartCount: 4,
          interactionTests: true
        });
        return results;
      }
    };
  }
}