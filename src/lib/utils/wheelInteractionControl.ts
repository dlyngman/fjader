interface WheelInteractionConfig {
	dwellTimeMs?: number;
	momentumThreshold?: number;
	enabled?: boolean;
}

export class WheelInteractionControl {
	dwellTimeMs: number;
	momentumThreshold: number;
	enabled: boolean;

	hoverStartTime: number | null;
	lastWheelTime: number;
	isActive: boolean;

	constructor(config: WheelInteractionConfig = {}) {
		this.dwellTimeMs = config.dwellTimeMs ?? 250;
		this.momentumThreshold = config.momentumThreshold ?? 150;
		this.enabled = config.enabled ?? true;

		this.hoverStartTime = null;
		this.lastWheelTime = 0;
		this.isActive = false;
	}

	handlePointerEnter(): void {
		if (!this.enabled) {
			this.isActive = true;
			return;
		}
		this.hoverStartTime = performance.now();
		this.isActive = false;
	}

	handlePointerLeave(): void {
		this.hoverStartTime = null;
		this.isActive = false;
		this.lastWheelTime = 0;
	}

	shouldCaptureWheel(_event: WheelEvent): boolean {
		if (!this.enabled) return true;

		const now = performance.now();

		if (this.isActive) {
			return true;
		}

		if (this.hoverStartTime) {
			const dwellElapsed = now - this.hoverStartTime;

			const timeSinceLastWheel = now - this.lastWheelTime;
			const hadPreviousWheel = this.lastWheelTime > 0;
			this.lastWheelTime = now;

			if (hadPreviousWheel && timeSinceLastWheel < this.momentumThreshold) {
				this.hoverStartTime = now;
				return false;
			}

			if (dwellElapsed >= this.dwellTimeMs) {
				this.isActive = true;
				return true;
			} else {
				return false;
			}
		}

		return false;
	}

	reset(): void {
		this.hoverStartTime = null;
		this.lastWheelTime = 0;
		this.isActive = false;
	}
}
