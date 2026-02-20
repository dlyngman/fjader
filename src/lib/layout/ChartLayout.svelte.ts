// lib/layout/ChartLayout.svelte.ts

interface Margin {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

interface Point {
	x: number;
	y: number;
}

interface AxesResult {
	xInBounds: boolean;
	yInBounds: boolean;
	innerPoint: Point;
}

export interface ChartLayoutConfig {
	margin?: Partial<Margin>;
	height?: number;
	clipPadding?: number;
}

interface ResolvedConfig {
	margin: Margin;
	height: number;
	clipPadding: number;
}

/**
 * ChartLayout manages all chart dimensions, margins, and coordinate transformations.
 * OPTIMIZED FOR ZERO-GC INTERACTION LOOPS.
 */
export class ChartLayout {
	// Reactive state
	width = $state<number | null>(0);
	height = $state(0);
	margin = $state<Margin>({ top: 0, right: 0, bottom: 0, left: 0 });

	config: ResolvedConfig;
	chartId: string;

	// --- ZERO-GC BUFFERS ---
	// Reused objects to prevent allocation during high-frequency events (pointermove, wheel)
	_axesBuffer: AxesResult = {
		xInBounds: false,
		yInBounds: false,
		innerPoint: { x: 0, y: 0 }
	};

	_pointBuffer: Point = { x: 0, y: 0 };

	constructor(config: ChartLayoutConfig = {}) {
		const defaults: ResolvedConfig = {
			margin: { top: 30, right: 50, bottom: 35, left: 75 },
			height: 250,
			clipPadding: 0
		};

		this.config = { ...defaults, ...config, margin: { ...defaults.margin, ...config.margin } };

		// Initialize state
		this.height = this.config.height;
		this.margin = this.config.margin; // Triggers reactivity

		this.chartId = crypto.randomUUID();
	}

	// --- COMPUTED PROPERTIES (Getters) ---

	get innerWidth(): number {
		return this.width ? Math.max(0, this.width - this.margin.left - this.margin.right) : 0;
	}

	get innerHeight(): number {
		return Math.max(0, this.height - this.margin.top - this.margin.bottom);
	}

	get isReady(): boolean {
		return (
			this.width !== null &&
			this.width > 0 &&
			this.height > 0 &&
			this.innerWidth > 0 &&
			this.innerHeight > 0
		);
	}

	get innerTransform(): string {
		return `translate(${this.margin.left}, ${this.margin.top})`;
	}

	get clipPathId(): string {
		return `mask-${this.chartId}`;
	}

	get clipPathUrl(): string {
		return `url(#${this.clipPathId})`;
	}

	// Warning: accessing this creates a new object. Use mostly for debugging.
	get dimensions() {
		return {
			width: this.width,
			height: this.height,
			innerWidth: this.innerWidth,
			innerHeight: this.innerHeight,
			margin: this.margin
		};
	}

	// --- METHODS ---

	updateWidth = (newWidth: number): void => {
		this.width = newWidth;
	};

	updateHeight = (newHeight: number): void => {
		this.height = newHeight;
	};

	updateMargin = (newMargin: Partial<Margin>): void => {
		this.margin = { ...this.margin, ...newMargin };
	};

	reset = (): void => {
		this.width = null;
		this.height = this.config.height;
		this.margin = { ...this.config.margin };
	};

	// --- HOT PATH METHODS (Optimized) ---

	// OPTIMIZED: Mutates shared buffer instead of returning new {x,y}
	toInnerCoordinates = (point: Point): Point => {
		this._pointBuffer.x = point.x - this.margin.left;
		this._pointBuffer.y = point.y - this.margin.top;
		return this._pointBuffer;
	};

	// Alias for converting specific x/y numbers (Better for internal use)
	toInnerRaw = (x: number, y: number): Point => {
		this._pointBuffer.x = x - this.margin.left;
		this._pointBuffer.y = y - this.margin.top;
		return this._pointBuffer;
	};

	toScreenCoordinates = (innerPoint: Point): Point => {
		this._pointBuffer.x = innerPoint.x + this.margin.left;
		this._pointBuffer.y = innerPoint.y + this.margin.top;
		return this._pointBuffer;
	};

	// OPTIMIZED: Returns primitive boolean
	isWithinInnerBounds = (point: Point): boolean => {
		const x = point.x - this.margin.left;
		const y = point.y - this.margin.top;

		return x >= 0 && x <= this.innerWidth && y >= 0 && y <= this.innerHeight;
	};

	getActiveAxes = (point: Point): AxesResult => {
		const ix = point.x - this.margin.left;
		const iy = point.y - this.margin.top;

		const inX = ix >= 0 && ix <= this.innerWidth;
		const inY = iy >= 0 && iy <= this.innerHeight;

		this._axesBuffer.xInBounds = inX;
		this._axesBuffer.yInBounds = inY;
		this._axesBuffer.innerPoint.x = ix;
		this._axesBuffer.innerPoint.y = iy;

		return this._axesBuffer;
	};

	getDebugInfo = () => {
		return {
			config: this.config,
			width: this.width,
			height: this.height,
			margin: this.margin,
			innerWidth: this.innerWidth,
			innerHeight: this.innerHeight,
			isReady: this.isReady,
			chartId: this.chartId
		};
	};

	getContextData() {
		const layout = this;

		return {
			get width() {
				return layout.width;
			},
			get height() {
				return layout.height;
			},
			get innerWidth() {
				return layout.innerWidth;
			},
			get innerHeight() {
				return layout.innerHeight;
			},
			get margin() {
				return layout.margin;
			},
			get chartId() {
				return layout.chartId;
			},
			get clipPathId() {
				return layout.clipPathId;
			},
			get clipPathUrl() {
				return layout.clipPathUrl;
			},
			get isReady() {
				return layout.isReady;
			},
			get innerTransform() {
				return layout.innerTransform;
			},
			get dimensions() {
				return layout.dimensions;
			},

			updateWidth: layout.updateWidth,
			updateHeight: layout.updateHeight,
			updateMargin: layout.updateMargin,
			toInnerCoordinates: layout.toInnerCoordinates,
			toScreenCoordinates: layout.toScreenCoordinates,
			isWithinInnerBounds: layout.isWithinInnerBounds,
			getActiveAxes: layout.getActiveAxes,
			reset: layout.reset,
			getDebugInfo: layout.getDebugInfo
		};
	}
}
