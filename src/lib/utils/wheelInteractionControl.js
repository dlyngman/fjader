/**
 * Wheel interaction control to prevent scroll hijacking
 *
 * Tracks hover dwell time and scroll momentum to intelligently decide
 * when to capture wheel events for chart zoom vs allow page scroll.
 *
 * @example
 * const control = new WheelInteractionControl({ dwellTimeMs: 250 });
 *
 * // On pointer enter
 * control.handlePointerEnter();
 *
 * // On wheel event
 * if (control.shouldCaptureWheel(event)) {
 *   event.preventDefault();
 *   // Handle zoom
 * }
 */
export class WheelInteractionControl {
	/**
	 * @param {Object} config - Configuration options
	 * @param {number} [config.dwellTimeMs=250] - Time pointer must hover before capturing wheel (ms)
	 * @param {number} [config.momentumThreshold=150] - Max time between wheel events to detect scrolling momentum (ms)
	 * @param {boolean} [config.enabled=true] - Whether control is active (false = always capture)
	 */
	constructor(config = {}) {
		this.dwellTimeMs = config.dwellTimeMs ?? 250;
		this.momentumThreshold = config.momentumThreshold ?? 150;
		this.enabled = config.enabled ?? true;

		// State
		this.hoverStartTime = null;
		this.lastWheelTime = 0;
		this.isActive = false; // Has dwell time elapsed?
	}

	/**
	 * Call when pointer enters the chart area
	 * Starts the dwell timer
	 */
	handlePointerEnter() {
		if (!this.enabled) {
			this.isActive = true;
			return;
		}
		this.hoverStartTime = performance.now();
		this.isActive = false;
	}

	/**
	 * Call when pointer leaves the chart area
	 * Resets all state
	 */
	handlePointerLeave() {
		this.hoverStartTime = null;
		this.isActive = false;
		this.lastWheelTime = 0;
	}

	/**
	 * Determines if wheel event should be captured for chart interaction
	 * or passed through for page scroll
	 *
	 * @param {WheelEvent} event - The wheel event (unused but kept for future enhancements)
	 * @returns {boolean} true if wheel should be captured, false if it should pass through
	 */
	shouldCaptureWheel(event) {
		if (!this.enabled) return true;

		const now = performance.now();

		// If already active (dwell time has elapsed), always capture
		if (this.isActive) {
			return true;
		}

		// Not active yet - check if we should activate or detect page scrolling
		if (this.hoverStartTime) {
			const dwellElapsed = now - this.hoverStartTime;

			// Check momentum (rapid scrolling) BEFORE dwell time completes
			const timeSinceLastWheel = now - this.lastWheelTime;
			const hadPreviousWheel = this.lastWheelTime > 0;
			this.lastWheelTime = now;

			// Rapid successive wheel events during dwell = page scrolling momentum
			if (hadPreviousWheel && timeSinceLastWheel < this.momentumThreshold) {
				// Momentum detected - restart dwell timer and let page scroll
				this.hoverStartTime = now;
				return false;
			}

			// Check if dwell time has elapsed
			if (dwellElapsed >= this.dwellTimeMs) {
				this.isActive = true;
				return true;
			} else {
				// Not enough dwell time yet
				return false;
			}
		}

		// No hover start time set - shouldn't happen, but fail safe
		return false;
	}

	/**
	 * Resets all state (useful for programmatic reset)
	 */
	reset() {
		this.hoverStartTime = null;
		this.lastWheelTime = 0;
		this.isActive = false;
	}
}
