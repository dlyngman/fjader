// PointerInputProcessor.js
// export class PointerInputProcessor {
//   constructor() {
//     this.samples = [];
//     this.maxSamples = 20;

//     // Prediction state (per-axis)
//     this.predicted = { x: 0, y: 0 };
//     this.corrected = { x: 0, y: 0 };
//     this.error = { x: 0, y: 0 };
//     this.velocity = { x: 0, y: 0 };
//     this.lastSampleTime = 0;

//     // Tuning parameters
//     this.errorCorrectionRate = 4.0; // Hz - how fast to blend out errors
//     this.maxPredictionAge = 50; // ms - confidence drops to 0 after this
//   }

//   // addSample(screenX, screenY, timestamp) {
//   //   console.log('Raw sample:', {
//   //     x: screenX.toFixed(2),
//   //     y: screenY.toFixed(2),
//   //     dt: this.samples.length > 0
//   //       ? (timestamp - this.samples[this.samples.length - 1].t).toFixed(1)
//   //       : 'first'
//   //   });

//   //   this.samples.push({ x: screenX, y: screenY, t: timestamp });

//   //   if (this.samples.length > this.maxSamples) {
//   //     this.samples.shift();
//   //   }

//   //   // Update ground truth
//   //   this.corrected.x = screenX;
//   //   this.corrected.y = screenY;

//   //   // Only calculate error if we have a prior prediction
//   //   if (this.samples.length > 1) {
//   //     this.error.x = this.predicted.x - this.corrected.x;
//   //     this.error.y = this.predicted.y - this.corrected.y;
//   //   } else {
//   //     // First sample: initialize prediction, no error yet
//   //     this.predicted.x = screenX;
//   //     this.predicted.y = screenY;
//   //     this.error.x = 0;
//   //     this.error.y = 0;
//   //   }

//   //   // Update velocity from recent samples
//   //   this.#updateVelocity(timestamp);

//   //   this.lastSampleTime = timestamp;
//   // }

//   addSample(screenX, screenY, timestamp) {
//       if (this.lastSampleTime === 0) {
//           // This is the very first sample. Initialize everything.
//           this.samples.push({ x: screenX, y: screenY, t: timestamp });
//           this.lastSampleTime = timestamp;
//           this.corrected.x = screenX;
//           this.corrected.y = screenY;
//           this.predicted.x = screenX; // Prediction starts at the first known point
//           this.predicted.y = screenY;
//           return;
//       }

//       // --- Correct Error Calculation ---
//       // 1. Calculate how much time has passed since the last sample.
//       const dt = (timestamp - this.lastSampleTime) / 1000.0;

//       if (dt > 0) {
//           // 2. Predict where the cursor SHOULD have been at this new timestamp,
//           //    based on the state from the *previous* sample.
//           const predictionAtNewTimeX = this.corrected.x + this.velocity.x * dt;
//           const predictionAtNewTimeY = this.corrected.y + this.velocity.y * dt;

//           // 3. The error is the difference between that prediction and the actual ground truth.
//           this.error.x = predictionAtNewTimeX - screenX;
//           this.error.y = predictionAtNewTimeY - screenY;
//       }
//       // If dt is 0, the error remains what it was.

//       // Update state with the new ground truth
//       this.samples.push({ x: screenX, y: screenY, t: timestamp });
//       if (this.samples.length > this.maxSamples) {
//           this.samples.shift();
//       }
//       this.corrected.x = screenX;
//       this.corrected.y = screenY;
//       this.lastSampleTime = timestamp;

//       // Update velocity model based on the new history
//       this.#updateVelocity(timestamp);
//   }

//   #updateVelocity(timestamp) {
//     if (this.samples.length < 2) {
//       this.velocity.x = 0;
//       this.velocity.y = 0;
//       return;
//     }

//     // Simple velocity from last two samples
//     const recent = this.samples[this.samples.length - 1];
//     const previous = this.samples[this.samples.length - 2];
//     const dt = (recent.t - previous.t) / 1000.0;

//     if (dt > 0) {
//       this.velocity.x = (recent.x - previous.x) / dt;
//       this.velocity.y = (recent.y - previous.y) / dt;
//     }
//   }

//   getPosition(currentTime, axis) {
//     if (this.samples.length === 0) return null;

//     const dt = (currentTime - this.lastSampleTime) / 1000.0;

//     // Extrapolate forward from corrected position
//     this.predicted[axis] = this.corrected[axis] + this.velocity[axis] * dt;

//     // Apply error correction decay
//     const decay = Math.exp(-this.errorCorrectionRate * dt);
//     this.error[axis] *= decay;

//     // Return error-corrected prediction
//     const position = this.predicted[axis] - this.error[axis];

//     // Calculate confidence based on sample age
//     const age = currentTime - this.lastSampleTime;
//     const confidence = Math.max(0, 1 - age / this.maxPredictionAge);

//     return {
//       cursorPosition: position,
//       velocity: this.velocity[axis],
//       confidence,
//       predictionError: this.error[axis] // for debugging
//     };
//   }

//   reset() {
//     this.samples = [];
//     this.predicted = { x: 0, y: 0 };
//     this.corrected = { x: 0, y: 0 };
//     this.error = { x: 0, y: 0 };
//     this.velocity = { x: 0, y: 0 };
//     this.lastSampleTime = 0;
//   }
// }

export class PointerInputProcessor {
	constructor() {
		this.samples = [];
		this.maxSamples = 20;

		// --- State from the last time getPosition was called ---
		this.lastQueryTime = 0;
		this.lastPosition = { x: 0, y: 0 };
		this.lastVelocity = { x: 0, y: 0 };

		// --- Error Correction State ---
		this.error = { x: 0, y: 0 };

		// --- Tuning Parameters ---
		this.errorCorrectionRate = 8.0; // Hz
		this.velocityUpdateAlpha = 0.15; // How much to smooth new velocity calculations
	}

	reset() {
		this.samples = [];
		this.lastQueryTime = 0;
		this.lastPosition = { x: 0, y: 0 };
		this.lastVelocity = { x: 0, y: 0 };
		this.error = { x: 0, y: 0 };
	}

	addSample(screenX, screenY, timestamp) {
		if (this.lastQueryTime === 0) {
			// First ever sample
			this.lastQueryTime = timestamp;
			this.lastPosition = { x: screenX, y: screenY };
			return;
		}

		// --- The Correct Error Calculation ---
		// Predict where we thought we were at the time the sample arrived.
		const dt = (timestamp - this.lastQueryTime) / 1000.0;
		const predictedX = this.lastPosition.x + this.lastVelocity.x * dt;
		const predictedY = this.lastPosition.y + this.lastVelocity.y * dt;

		// The error is the difference between that specific prediction and the ground truth.
		this.error.x += screenX - predictedX;
		this.error.y += screenY - predictedY;

		// Update the velocity model with the new information.
		this.#updateVelocity(screenX, screenY, timestamp);
	}

	#updateVelocity(x, y, t) {
		this.samples.push({ x, y, t });
		if (this.samples.length > this.maxSamples) {
			this.samples.shift();
		}
		if (this.samples.length < 2) return;

		// Calculate a new velocity estimate from the last two samples.
		const last = this.samples[this.samples.length - 1];
		const prev = this.samples[this.samples.length - 2];
		const dt = (last.t - prev.t) / 1000.0;
		if (dt < 0.001) return; // Avoid division by zero

		const newVelocityX = (last.x - prev.x) / dt;
		const newVelocityY = (last.y - prev.y) / dt;

		// --- CRUCIAL STEP ---
		// Smooth the velocity update using an EMA. This prevents the velocity
		// from jumping wildly with each new sample, which is a major source of jitter.
		this.lastVelocity.x += (newVelocityX - this.lastVelocity.x) * this.velocityUpdateAlpha;
		this.lastVelocity.y += (newVelocityY - this.lastVelocity.y) * this.velocityUpdateAlpha;
	}

	getPosition(currentTime, axis) {
		const dt = (currentTime - this.lastQueryTime) / 1000.0;

		// Predict forward from the last state
		const predictedPosition = this.lastPosition[axis] + this.lastVelocity[axis] * dt;

		// Calculate the correction to apply
		const decay = Math.exp(-this.errorCorrectionRate * dt);
		const correction = this.error[axis] * (1.0 - decay);
		const finalPosition = predictedPosition + correction;

		// --- THIS IS THE FIX ---
		// The internal state is updated with the PURE, UNCORRECTED prediction.
		// It continues on its smooth path, ignoring the correction.
		this.lastPosition[axis] = predictedPosition;

		this.error[axis] *= decay;
		this.lastQueryTime = currentTime;

		return {
			cursorPosition: finalPosition,
			confidence: 1.0 // Confidence is now implicit in the model
		};
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

export class SimpleScalarSmoother {
	#lastUpdate = 0;
	#currentValue = 0;
	#tau = 0.03; // 20ms smoothing

	update(value, timestamp) {
		const dt = (timestamp - this.#lastUpdate) / 1000;

		if (this.#lastUpdate === 0) {
			this.#currentValue = value;
		} else {
			const alpha = 1 - Math.exp(-dt / this.#tau);
			this.#currentValue += (value - this.#currentValue) * alpha;
		}

		this.#lastUpdate = timestamp;
	}

	get value() {
		return this.#currentValue;
	}

	reset() {
		this.#lastUpdate = 0;
		this.#currentValue = 0;
	}
}
