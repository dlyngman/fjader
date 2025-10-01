// PointerInputProcessor.js
export class PointerInputProcessor {
  constructor() {
    this.samples = [];
    this.maxSamples = 100;
    
    // α-β filter state
    this.x = 0;
    this.vx = 0;
    this.lastUpdateTime = 0;
    this.initialized = false;
    
    // Tuned for responsive tracking
    this.tauMs = 50;   // Fast response time
    this.k = 1;      // Critical damping
  }

  addSample(screenX, screenY, timestamp) {
    this.samples.push({ t: timestamp, x: screenX, y: screenY });
    
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
    
    const cutoffTime = timestamp - 200;
    while (this.samples.length > 1 && this.samples[0].t < cutoffTime) {
      this.samples.shift();
    }

    console.log('Sample timing:', {
      count: this.samples.length,
      timestamps: this.samples.map(s => s.t),
      gaps: this.samples.slice(1).map((s, i) => s.t - this.samples[i].t),
      newest: this.samples[this.samples.length - 1]?.t,
      oldest: this.samples[0]?.t,
      span: this.samples.length > 0 ? 
        this.samples[this.samples.length - 1].t - this.samples[0].t : 0
    });
  }

  getPosition(currentTime, axis) {
    // Cap dt to prevent instability
    const rawDt = (currentTime - this.lastUpdateTime) / 1000;
    const dt = Math.min(rawDt, 0.1); // Cap at 100ms
    
    if (dt <= 0) return null;
    
    // Always predict forward
    this.x = this.x + this.vx * dt;
    
    // Try to get measurement
    const measurement = this.#getMeasurement(currentTime, axis);
    
    if (measurement) {
      // Initialize on first measurement
      if (!this.initialized) {
        this.x = measurement.position;
        this.vx = 0;
        this.initialized = true;
        this.lastUpdateTime = currentTime;
        return { cursorPosition: this.x, confidence: 1.0 };
      }
      
      // Correction step
      const residual = measurement.position - this.x;
      
      // Calculate gains
      const alpha = 1 - Math.exp(-dt * 1000 / this.tauMs);
      const beta = this.k * alpha * alpha;
      
      // Update position
      this.x = this.x + alpha * residual;
      
      // Update velocity with clamping
      const velocityDelta = (beta * residual) / dt;
      const maxVelDelta = 5; // px/ms per update
      const clampedVelDelta = Math.max(-maxVelDelta, Math.min(maxVelDelta, velocityDelta));
      this.vx = this.vx + clampedVelDelta;
      
      // Clamp absolute velocity
      this.vx = Math.max(-3, Math.min(3, this.vx));
    }
    
    this.lastUpdateTime = currentTime;
    console.log('processor getting position', currentTime, this.x)
    return {
      cursorPosition: this.x,
      confidence: measurement ? 1.0 : 0.5
    };
  }

  #getMeasurement(currentTime, axis) {
    if (this.samples.length === 0) return null;
    
    const latest = this.samples[this.samples.length - 1];
    const age = currentTime - latest.t;
    
    // Use latest if reasonably fresh
    if (age < 50) {
      return {
        position: axis === 'x' ? latest.x : latest.y,
        confidence: 1.0
      };
    }
    
    return null;
  }

  reset() {
    this.samples = [];
    this.x = 0;
    this.vx = 0;
    this.lastUpdateTime = 0;
    this.initialized = false;
  }
}


export class SimplePointerProcessor {
  samples = [];
  maxSamples = 10;
  
  reset() {
    this.samples = [];
  }
  
  addSample(screenX, screenY, timestamp) {
    this.samples.push({ x: screenX, y: screenY, t: timestamp });
    
    // Keep only recent samples
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
    
    // Trim by age too
    const cutoff = timestamp - 200;
    while (this.samples.length > 1 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }
  
  getPosition(currentTime, axis) {
    if (this.samples.length === 0) return null;
    
    const latest = this.samples[this.samples.length - 1];
    
    // If latest sample is fresh (< 50ms old), just use it
    if (currentTime - latest.t < 50) {
      return {
        position: axis === 'x' ? latest.x : latest.y,
        confidence: 1.0
      };
    }
    
    // If we only have one sample or it's very old, use it but low confidence
    if (this.samples.length < 2 || currentTime - latest.t > 100) {
      return {
        position: axis === 'x' ? latest.x : latest.y,
        confidence: 0.3
      };
    }
    
    // Simple extrapolation from last two samples
    const prev = this.samples[this.samples.length - 2];
    const dt = latest.t - prev.t;
    const coord = axis === 'x' ? 'x' : 'y';
    const velocity = (latest[coord] - prev[coord]) / dt;
    const age = currentTime - latest.t;
    
    return {
      position: latest[coord] + velocity * age,
      confidence: 0.7
    };
  }
}
