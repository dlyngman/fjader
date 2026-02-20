type BrushPhase = 'idle' | 'creating' | 'moving' | 'resizing';
type ResizeEdge = 'start' | 'end' | null;
type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se' | null;

export class BrushState1D {
	// Data-space bounds (source of truth)
	dataMin: number | Date | null = $state(null);
	dataMax: number | Date | null = $state(null);

	// Interaction phase
	phase: BrushPhase = $state('idle');
	resizeEdge: ResizeEdge = $state(null);

	// Derived
	active = $derived(this.dataMin != null && this.dataMax != null);

	// Screen coordinate conversions (using D3 scale)
	screenMin(scale: (v: any) => number): number {
		return scale(this.dataMin);
	}

	screenMax(scale: (v: any) => number): number {
		return scale(this.dataMax);
	}

	screenExtent(scale: (v: any) => number): [number, number] {
		return [this.screenMin(scale), this.screenMax(scale)].sort((a, b) => a - b) as [number, number];
	}

	// Set from screen coordinates (during gesture)
	setFromScreen(
		screenMin: number,
		screenMax: number,
		scale: { invert: (v: number) => number }
	): void {
		// Convert to data space first, then sort data values
		// This handles inverted scales (like Y-axis) correctly
		const data1 = scale.invert(screenMin);
		const data2 = scale.invert(screenMax);
		const sorted = [data1, data2].sort((a, b) => a - b);
		this.dataMin = sorted[0];
		this.dataMax = sorted[1];
	}

	// Shift by delta (for move gesture)
	shiftByScreen(screenDelta: number, scale: { invert: (v: number) => number }): void {
		const dataDelta = scale.invert(screenDelta) - scale.invert(0);
		(this.dataMin as number) += dataDelta;
		(this.dataMax as number) += dataDelta;
	}

	clear(): void {
		this.dataMin = null;
		this.dataMax = null;
		this.phase = 'idle';
		this.resizeEdge = null;
	}

	// Normalize to ensure dataMin <= dataMax (swap if needed)
	normalize(): void {
		if (this.dataMin != null && this.dataMax != null && this.dataMin > this.dataMax) {
			const temp = this.dataMin;
			this.dataMin = this.dataMax;
			this.dataMax = temp;
		}
	}

	// Set both values (Svelte 5 batches these updates automatically)
	setExtent(min: number | Date, max: number | Date): void {
		this.dataMin = min;
		this.dataMax = max;
	}

	// Validate brush for current scale
	validate(scale: { domain: () => number[] }, scaleType: string): boolean {
		if (!this.active) return true;

		// Log scales require positive values
		if (scaleType === 'log' || scaleType === 'log10') {
			if ((this.dataMin as number) <= 0 || (this.dataMax as number) <= 0) {
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
		this.dataMin = Math.max(this.dataMin as number, domainMin);
		this.dataMax = Math.min(this.dataMax as number, domainMax);

		// Clear if collapsed
		if ((this.dataMin as number) >= (this.dataMax as number)) {
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

	phase: BrushPhase = $state('idle');
	resizeCorner: ResizeCorner = $state(null);

	active = $derived(this.x.active && this.y.active);

	clear(): void {
		this.x.clear();
		this.y.clear();
		this.phase = 'idle';
		this.resizeCorner = null;
	}
}
