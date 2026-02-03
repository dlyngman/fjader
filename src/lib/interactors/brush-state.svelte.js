export class BrushState1D {
	// Data-space bounds (source of truth)
	dataMin = $state(null);
	dataMax = $state(null);

	// Interaction phase
	phase = $state('idle'); // 'idle' | 'creating' | 'moving' | 'resizing'
	resizeEdge = $state(null); // 'start' | 'end' | null

	// Derived
	active = $derived(this.dataMin != null && this.dataMax != null);

	// Screen coordinate conversions (using D3 scale)
	screenMin(scale) {
		return scale(this.dataMin);
	}

	screenMax(scale) {
		return scale(this.dataMax);
	}

	screenExtent(scale) {
		return [this.screenMin(scale), this.screenMax(scale)].sort((a, b) => a - b);
	}

	// Set from screen coordinates (during gesture)
	setFromScreen(screenMin, screenMax, scale) {
		// Convert to data space first, then sort data values
		// This handles inverted scales (like Y-axis) correctly
		const data1 = scale.invert(screenMin);
		const data2 = scale.invert(screenMax);
		const sorted = [data1, data2].sort((a, b) => a - b);
		this.dataMin = sorted[0];
		this.dataMax = sorted[1];
	}

	// Shift by delta (for move gesture)
	shiftByScreen(screenDelta, scale) {
		const dataDelta = scale.invert(screenDelta) - scale.invert(0);
		this.dataMin += dataDelta;
		this.dataMax += dataDelta;
	}

	clear() {
		this.dataMin = null;
		this.dataMax = null;
		this.phase = 'idle';
		this.resizeEdge = null;
	}

	// Normalize to ensure dataMin <= dataMax (swap if needed)
	normalize() {
		if (this.dataMin != null && this.dataMax != null && this.dataMin > this.dataMax) {
			const temp = this.dataMin;
			this.dataMin = this.dataMax;
			this.dataMax = temp;
		}
	}

	// Set both values (Svelte 5 batches these updates automatically)
	setExtent(min, max) {
		this.dataMin = min;
		this.dataMax = max;
	}

	// Validate brush for current scale
	validate(scale, scaleType) {
		if (!this.active) return true;

		// Log scales require positive values
		if (scaleType === 'log' || scaleType === 'log10') {
			if (this.dataMin <= 0 || this.dataMax <= 0) {
				this.clear();
				return false;
			}
		}

		// Time scales require Date objects
		if (scaleType === 'time' || scaleType === 'utc') {
			if (!(this.dataMin instanceof Date) || !(this.dataMax instanceof Date)) {
				this.clear();
				return false;
			}
		}

		// Clamp to domain bounds
		const [domainMin, domainMax] = scale.domain();
		this.dataMin = Math.max(this.dataMin, domainMin);
		this.dataMax = Math.min(this.dataMax, domainMax);

		// Clear if collapsed
		if (this.dataMin >= this.dataMax) {
			this.clear();
			return false;
		}

		return true;
	}
}

export class BrushState2D {
	// X and Y dimensions
	x = new BrushState1D();
	y = new BrushState1D();

	phase = $state('idle');
	resizeCorner = $state(null); // 'nw' | 'ne' | 'sw' | 'se' | null

	active = $derived(this.x.active && this.y.active);

	clear() {
		this.x.clear();
		this.y.clear();
		this.phase = 'idle';
		this.resizeCorner = null;
	}
}
