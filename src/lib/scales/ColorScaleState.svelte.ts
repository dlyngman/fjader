// src/lib/scales/ColorScaleState.svelte.ts
import { scaleOrdinal } from 'd3-scale';
import type { ScaleOrdinal } from 'd3-scale';
import {
	createD3Scale,
	getOrdinalColors,
	bakeGradient,
	bakeInterpolator,
	bakePalette,
	getSchemeType,
	parseColorToRGBA,
	resolveColorScaleTypes,
	getResolvedInterpolator,
	transformTypeToGPU,
	applyTransform,
	colorScaleTicks
} from './color-utils';
import type { RGBA, D3ColorScale } from './color-utils';
import type { FieldIdentity } from '$lib/query-engine/categorical-identity';
import type { ColorScaleType, ColorTransformType } from '$lib/types';
import type { ScaleRegistry } from './ScaleRegistry.svelte';
import { COLOR_RAMP_RESOLUTION, type GPUCoordinator } from '$lib/gpu/GPUCoordinator.svelte';

interface ColorScaleConfig {
	field: string;
	scheme?: string;
	type?: ColorScaleType;
	domain?: (string | number)[];
	reverse?: boolean;
	midpoint?: number;
	constant?: number; // symlog constant C (default 1)
	exponent?: number; // pow exponent (default 1)
}

/** Must match ColorConfig in ColorScaleShaderLib. */
const COLOR_CONFIG_BYTES = 48;
/** slotBase meaning "the channel already carries a palette index". */
const NO_SLOT_TABLE = 0xffffffff;

interface ColorConfigParams {
	type: number;
	rampOffset?: number;
	paletteOffset?: number;
	paletteSize?: number;
	domainMin?: number;
	domainMax?: number;
	transformType?: number;
	transformParam?: number;
	/** Base into the shared identity slot table, or NO_SLOT_TABLE. */
	slotBase?: number;
}

/**
 * Reactive state for a GPU-backed color scale.
 *
 * Handles both continuous (sequential, diverging, cyclical) and discrete (ordinal) scales.
 * Manages GPU slot allocation and buffer uploads.
 */
export class ColorScaleState {
	// Identity
	#field: string;
	#registry: ScaleRegistry;
	#gpuCoordinator: GPUCoordinator | null;
	#scaleId: string = crypto.randomUUID(); // Unique ID for ViewManager registration

	// GPU slot indices (allocated from registry)
	#configSlot: number = -1;
	#rampSlot: number = -1; // Used by continuous scales
	#paletteSlot: number = -1; // Used by ordinal scales

	// Scale configuration (scheme is reactive so legends re-render on scheme change)
	#scheme: string = $state('');
	#scaleType: ColorScaleType = $state('sequential');
	#renderType: 'ordinal' | 'sequential' | 'diverging' | 'cyclical' = 'sequential';
	#transformType: ColorTransformType = 'linear';
	#reverse: boolean;
	#midpoint: number | undefined; // For diverging scales
	#constant: number; // symlog C parameter
	#exponent: number; // pow exponent

	// Reactive state
	domain: (string | number)[] = $state([]);
	ready: boolean = $state(false);
	#activeValues: Set<string | number> | null = $state(null); // null = all active, Set = only these active

	// Bumped on any visual-config change (transform type, constant, exponent, scheme).
	// Legend components read this to know when to re-render the gradient.
	_version: number = $state(0);

	// D3 scale instance (for legends and CPU lookups)
	#d3Scale: D3ColorScale | null = null;

	// Ordinal category mapping (string -> 0-based index, -1 = null/unknown)
	#categoryMap: Map<string | number, number> = new Map();
	/**
	 * The engine's id <-> value bijection for this scale's field (step 3b).
	 * A live reference, never a copy — the dim appends when a second table
	 * registers the same field.
	 */
	#identity: FieldIdentity | null = null;
	/**
	 * id -> palette rank, ASSIGNED ONCE AND NEVER REASSIGNED.
	 *
	 * Not the position in the current domain, which is what the CASE encoded and
	 * what makes a colour move when its neighbours come and go. A category that
	 * is filtered out keeps its rank reserved, so when it returns it returns in
	 * the same colour. That is the whole point: a legend that reshuffles on
	 * every filter is worse than a gap in the palette.
	 *
	 * Ranks are handed out in domain order on first sight, so an untouched chart
	 * still gets palette colours 0, 1, 2... in order. Churn leaves gaps, and
	 * enough churn walks past the palette's 32 entries and wraps — the same wrap
	 * a chart with more than 32 categories already gets, reached sooner.
	 *
	 * Cleared only when identity itself is replaced (a data reload), where ids
	 * stop meaning anything and holding colours to them would be wrong.
	 */
	#paletteRank: Map<number, number> = new Map();
	#nextRank = 0;
	/**
	 * id -> rank as a dense array, packed into the shared identity slot table so
	 * the fragment shader can resolve a channel id to a palette index. -1 for an
	 * id this scale has never ranked.
	 */
	slotTable: Float32Array = new Float32Array(0);
	/** Bumped on every slotTable rebuild; the packer uploads only on a change. */
	slotVersion: number = 0;
	/**
	 * Where this scale's block sits in the shared identity slot table. Assigned
	 * by the coordinator's packer, which also patches it into the uploaded
	 * config — the config is written when the scale changes, while the base can
	 * move on any frame a neighbouring scale resizes.
	 */
	#slotBase: number = -1;

	/** Called by the packer when this scale's block moves. */
	setSlotBase(base: number): void {
		this.#slotBase = base;
	}

	// ViewManager integration - tracks tables this scale has registered columns for
	#registeredTables: Set<string> = new Set();
	#viewsCreated: Set<string> = new Set(); // Tables that have had their view column created (one-shot)

	constructor(
		config: ColorScaleConfig,
		registry: ScaleRegistry,
		gpuCoordinator: GPUCoordinator | null
	) {
		this.#field = config.field;
		this.#scheme = config.scheme || 'viridis';
		this.#reverse = config.reverse ?? false;
		this.#midpoint = config.midpoint;
		this.#constant = config.constant ?? 1;
		this.#exponent = config.exponent ?? 1;
		this.#registry = registry;
		this.#gpuCoordinator = gpuCoordinator;

		// Explicit type wins, fallback to inference from scheme
		this.#scaleType = config.type || getSchemeType(this.#scheme) || 'sequential';

		// Resolve into render type (ramp vs palette) + transform type (normalization math)
		const resolved = resolveColorScaleTypes(this.#scaleType, this.#scheme);
		this.#renderType = resolved.renderType;
		this.#transformType = resolved.transformType;

		console.log(
			`[ColorScaleState] Created for ${this.#field}: type=${this.#scaleType}, render=${this.#renderType}, transform=${this.#transformType}, scheme=${this.#scheme}`
		);

		// Set initial domain
		this.domain = config.domain || [];

		// Allocate GPU slots
		this.#allocateSlots();

		// Initial GPU upload (if domain is ready)
		if (this.domain.length > 0) {
			this.#uploadToGPU();
		}
	}

	// ============================================================
	// GETTERS
	// ============================================================

	get field(): string {
		return this.#field;
	}

	get scheme(): string {
		return this.#scheme;
	}

	get scaleType(): ColorScaleType {
		return this.#scaleType;
	}

	get activeValues(): Set<string | number> | null {
		return this.#activeValues;
	}

	get isOrdinal(): boolean {
		return this.#renderType === 'ordinal';
	}

	get isContinuous(): boolean {
		return this.#renderType !== 'ordinal';
	}

	/**
	 * GPU slot information for registry cleanup.
	 */
	get gpuSlots(): { configSlot: number; rampSlot: number; paletteSlot: number } {
		return {
			configSlot: this.#configSlot,
			rampSlot: this.#rampSlot,
			paletteSlot: this.#paletteSlot
		};
	}

	/**
	 * The config slot index (used by marks for colorScaleIndex).
	 */
	get gpuIndex(): number {
		return this.#configSlot;
	}

	/**
	 * D3 scale for legends and CPU-side color lookups.
	 */
	get d3Scale(): D3ColorScale | null {
		return this.#d3Scale;
	}

	/**
	 * Unique scale ID for ViewManager registration.
	 */
	get scaleId(): string {
		return this.#scaleId;
	}

	// ============================================================
	// SLOT ALLOCATION
	// ============================================================

	#allocateSlots(): void {
		// Always need a config slot
		this.#configSlot = this.#registry.allocateColorSlot();

		// Allocate type-specific slot
		if (this.isOrdinal) {
			this.#paletteSlot = this.#registry.allocatePaletteSlot();
		} else {
			this.#rampSlot = this.#registry.allocateRampSlot();
		}
	}

	/**
	 * Swap slots when changing between ordinal and continuous.
	 */
	#swapSlots(newTypeIsOrdinal: boolean): void {
		if (newTypeIsOrdinal) {
			this.#registry.releaseRampSlot(this.#rampSlot);
			this.#rampSlot = -1;
			this.#paletteSlot = this.#registry.allocatePaletteSlot();
		} else {
			this.#registry.releasePaletteSlot(this.#paletteSlot);
			this.#paletteSlot = -1;
			this.#rampSlot = this.#registry.allocateRampSlot();
		}
	}

	// ============================================================
	// DATA PROCESSING (Required by Marks)
	// ============================================================

	/**
	 * Converts raw data into GPU-ready values.
	 * - Ordinal: string -> 0-based index (-1 = null/unknown, 0+ = categories)
	 * - Continuous: number -> f32 value (pass-through)
	 *
	 * Fast path: If data is already a Float32Array (from ViewManager-derived view),
	 * returns it directly without processing.
	 */
	processDataForGPU(data: (string | number | null)[] | ArrayLike<number>): Float32Array {
		// Fast path: already Float32Array from derived view (zero-copy)
		if (data instanceof Float32Array) {
			return data;
		}

		if (this.isOrdinal) {
			if (this.hasIdentity) {
				// The query selects the id column CAST to REAL, so this arrives as
				// a Float32Array and returns above. Reaching here with raw values
				// means something upstream stopped selecting it — and mapping them
				// to domain positions would hand the shader positions where it
				// expects ids, which it would resolve as some other category's
				// rank rather than fail.
				console.error(
					`[ColorScaleState] "${this.#field}" has identity but received raw category ` +
						`values; the query should select its __dplot_*_idx column. Colours will be wrong.`
				);
			}
			const indices = new Float32Array(data.length);
			for (let i = 0; i < data.length; i++) {
				const val = data[i];
				// -1 = null/unknown, 0+ = valid categories (matches ViewManager convention)
				indices[i] = val == null ? -1 : (this.#categoryMap.get(val) ?? -1);
			}
			return indices;
		}

		// Continuous: convert to Float32Array
		return new Float32Array(data as number[]);
	}

	// ============================================================
	// GPU UPLOAD
	// ============================================================

	/**
	 * Domain clamped to valid values for the current transform.
	 * Log requires strictly positive bounds; other transforms pass through.
	 * The raw `domain` is preserved so the legend can show the full data range
	 * (with nullColor for out-of-domain values).
	 */
	#effectiveDomain(): number[] {
		const lo = this.domain[0] as number;
		const hi = this.domain[this.domain.length - 1] as number;
		if (this.#transformType === 'log') {
			const LOG_CLAMP = 1e-6;
			return [Math.max(lo, LOG_CLAMP), Math.max(hi, LOG_CLAMP)];
		}
		return [lo, hi];
	}

	#uploadToGPU(): void {
		if (!this.#gpuCoordinator) {
			console.warn('[ColorScaleState] No GPU coordinator, skipping upload');
			return;
		}

		if (this.domain.length === 0) {
			return;
		}

		if (this.isOrdinal) {
			// Ordinal: D3 scale needs the full categorical domain (strings).
			// effectiveDomain is only meaningful for continuous scales.
			//
			// The ranks have to be refreshed BEFORE this, because the CPU scale
			// is built to agree with them: d3's scaleOrdinal assigns colours by
			// position in its domain, and once a category's rank has outlived a
			// disappearance its rank and its domain position differ. Left alone,
			// the legend and the tooltip swatch would show one colour while the
			// GPU drew another — the two disagreeing quietly, on exactly the
			// charts the stable rank exists for.
			this.#refreshRanks();
			this.#d3Scale = this.#hasRanks()
				? this.#buildRankedOrdinalScale()
				: createD3Scale(this.#scheme, this.domain as number[], { reverse: this.#reverse });
			this.#uploadOrdinal();
		} else {
			const effectiveDomain = this.#effectiveDomain();
			this.#d3Scale = createD3Scale(this.#scheme, effectiveDomain, {
				reverse: this.#reverse,
				midpoint: this.#midpoint,
				transform: this.#scaleType,
				constant: this.#constant,
				exponent: this.#exponent
			});
			this.#uploadContinuous(effectiveDomain);
		}

		this.ready = true;
	}

	#uploadContinuous(effectiveDomain: number[]): void {
		const hasTransform = this.#transformType !== 'linear';
		const isDiverging = this.#renderType === 'diverging';

		let rampData: Float32Array;

		if (hasTransform && !isDiverging) {
			// Non-linear sequential/cyclical: bake from raw interpolator so the ramp
			// is linearly spaced in color space.  The GPU shader applies the transform
			// to normalize data values before indexing into this ramp.
			const interpolator = getResolvedInterpolator(this.#scheme, this.#reverse);
			if (interpolator) {
				rampData = bakeInterpolator(interpolator, COLOR_RAMP_RESOLUTION);
			} else {
				rampData = bakeGradient(
					this.#d3Scale as Parameters<typeof bakeGradient>[0],
					COLOR_RAMP_RESOLUTION
				);
			}
		} else {
			// Linear, or diverging+transform: bake from D3 scale.
			// For diverging, the D3 scale bakes the midpoint into the ramp, so the
			// GPU can use linear normalization. (Diverging+transform quantizes the
			// transform into 256 ramp stops — acceptable for typical diverging data.)
			rampData = bakeGradient(
				this.#d3Scale as Parameters<typeof bakeGradient>[0],
				COLOR_RAMP_RESOLUTION
			);
		}

		this.#gpuCoordinator!.writeColorRamp(this.#rampSlot, rampData as Float32Array<ArrayBuffer>);

		// For sequential/cyclical + transform: GPU does the transform, so upload
		// pre-transformed bounds.  For diverging + transform: GPU does linear
		// normalization (transform is baked into ramp), so upload raw bounds.
		const gpuTransformType =
			hasTransform && !isDiverging ? this.#transformType : ('linear' as const);
		const param = this.#transformType === 'symlog' ? this.#constant : this.#exponent;
		const domainMin = applyTransform(effectiveDomain[0], gpuTransformType, param);
		const domainMax = applyTransform(effectiveDomain[1], gpuTransformType, param);

		const config = this.#buildColorConfig({
			type: this.#getRenderTypeInt(),
			rampOffset: this.#rampSlot * COLOR_RAMP_RESOLUTION,
			domainMin,
			domainMax,
			transformType: transformTypeToGPU(gpuTransformType),
			transformParam: param
		});
		this.#gpuCoordinator!.writeColorConfig(this.#configSlot, config);
	}

	/**
	 * Adopt the engine's id <-> value bijection for this field.
	 *
	 * A different FieldIdentity object means a rebuilt dim (a data reload), so
	 * every rank is stale — the same object-swap signature BandScaleState uses,
	 * and for the same reason: ids from the old dim are still in range against
	 * the new one and simply mean other categories.
	 */
	setIdentity(identity: FieldIdentity): void {
		const previous = this.#identity;
		this.#identity = identity;
		if (previous && previous !== identity && !previous.present) {
			this.#paletteRank.clear();
			this.#nextRank = 0;
		}
		this.#refreshRanks();
	}

	/** True once this scale's channel carries dim ids rather than palette indices. */
	get hasIdentity(): boolean {
		return this.isOrdinal && (this.#identity?.present ?? false);
	}

	/**
	 * Hand a rank to every domain category that does not have one, then rebuild
	 * the dense table. Existing ranks are never touched, which is what makes a
	 * colour survive its category disappearing.
	 */
	#refreshRanks(): void {
		const identity = this.#identity;
		if (!identity?.present) return;

		for (const value of this.domain) {
			const id = identity.ids.get(value as never);
			if (id === undefined || this.#paletteRank.has(id)) continue;
			this.#paletteRank.set(id, this.#nextRank++);
		}

		const table = new Float32Array(identity.values.length);
		table.fill(-1);
		for (const [id, rank] of this.#paletteRank) {
			if (id >= 0 && id < table.length) table[id] = rank;
		}
		this.slotTable = table;
		this.slotVersion++;
	}

	#hasRanks(): boolean {
		return this.hasIdentity && this.#paletteRank.size > 0;
	}

	/**
	 * An ordinal scale whose range is permuted to match the palette ranks, so
	 * `getColor(value)` returns the colour the GPU actually draws.
	 *
	 * d3 would otherwise index its range by domain position. Handing it an
	 * explicit range indexed the same way, with each entry taken at that
	 * category's rank, makes the two agree by construction rather than by both
	 * happening to be domain order.
	 */
	#buildRankedOrdinalScale(): ScaleOrdinal<string, string> {
		let colors = getOrdinalColors(this.#scheme) ?? [];
		if (this.#reverse) colors = [...colors].reverse();
		const identity = this.#identity!;

		const range = this.domain.map((value) => {
			const id = identity.ids.get(value as never);
			const rank = id === undefined ? undefined : this.#paletteRank.get(id);
			// Same wrap the shader applies, so an over-32 palette agrees too.
			return rank === undefined ? ColorScaleState.NULL_COLOR : colors[rank % colors.length];
		});

		// No .unknown(): it widens d3's third type param past D3ColorScale, and
		// the unranked case is already handled by the range entries below. An
		// out-of-domain value therefore cycles the range exactly as it does on
		// the scale this replaces.
		return scaleOrdinal<string, string>().domain(this.domain.map(String)).range(range);
	}

	/**
	 * Source value for a channel id — the decode side of the encode the query
	 * performs, for tooltips and legends. Undefined without identity, where the
	 * channel carries a palette index and the caller should read the domain.
	 */
	categoryAt(id: number): string | number | undefined {
		if (!this.hasIdentity) return undefined;
		return this.#identity!.values[id] as string | number | undefined;
	}

	#uploadOrdinal(): void {
		// Rebuild category map (string -> 0-based index)
		this.#categoryMap.clear();
		this.domain.forEach((cat, i) => this.#categoryMap.set(cat, i));
		// New categories in the domain need ranks before the palette is sized.
		this.#refreshRanks();

		// Bake and upload palette
		const paletteData = bakePalette(this.#scheme, { reverse: this.#reverse });
		this.#gpuCoordinator.writeColorPalette(
			this.#paletteSlot,
			paletteData as Float32Array<ArrayBuffer>
		);

		// Build and upload config struct
		// paletteSize is the modulus the shader wraps a rank with, so it has to
		// span the RANK space, not the current domain. Ranks outlive the
		// categories that earned them, so after any churn nextRank exceeds
		// domain.length — and wrapping a rank of 5 over a domain of 3 lands it on
		// rank 2's colour, undoing exactly the stability the ranks are for.
		//
		// Capped at 32, the palette's size, so a chart with more categories than
		// that wraps as it always has. Floored at 1: this is a u32 modulus and 0
		// is undefined behaviour in WGSL.
		const rankSpace = this.hasIdentity ? this.#nextRank : this.domain.length;
		const config = this.#buildColorConfig({
			type: 0, // ORDINAL
			paletteOffset: this.#paletteSlot * 32,
			paletteSize: Math.min(Math.max(rankSpace, 1), 32),
			slotBase: this.hasIdentity ? this.#slotBase : undefined
		});
		this.#gpuCoordinator.writeColorConfig(this.#configSlot, config);
	}

	/**
	 * Get integer type code for the render type (matches GPU constants).
	 */
	#getRenderTypeInt(): number {
		switch (this.#renderType) {
			case 'ordinal':
				return 0;
			case 'sequential':
				return 1;
			case 'diverging':
				return 2;
			case 'cyclical':
				return 3;
			default:
				return 1;
		}
	}

	/**
	 * Build the ColorConfig struct as ArrayBuffer.
	 * Uses DataView for correct binary layout (mixed f32/u32).
	 *
	 * MUST MATCH WGSL LAYOUT:
	 * struct ColorConfig {
	 *   domainMin: f32,         // byte 0  — pre-transformed for non-linear
	 *   domainMax: f32,         // byte 4  — pre-transformed for non-linear
	 *   rampOffset: u32,        // byte 8
	 *   paletteOffset: u32,     // byte 12
	 *   paletteSize: u32,       // byte 16
	 *   scaleType: u32,         // byte 20 — render type
	 *   transformType: u32,     // byte 24 — normalization transform
	 *   transformParam: f32,    // byte 28 — symlog C or pow exponent
	 * }; // 32 bytes total
	 */
	#buildColorConfig(params: ColorConfigParams): ArrayBuffer {
		const buffer = new ArrayBuffer(COLOR_CONFIG_BYTES);
		const view = new DataView(buffer);
		const LE = true; // Little Endian (WebGPU standard)

		// f32 fields
		view.setFloat32(0, params.domainMin ?? 0, LE);
		view.setFloat32(4, params.domainMax ?? 0, LE);

		// u32 fields
		view.setUint32(8, params.rampOffset ?? 0, LE);
		view.setUint32(12, params.paletteOffset ?? 0, LE);
		view.setUint32(16, params.paletteSize ?? 0, LE);
		view.setUint32(20, params.type ?? 0, LE);
		view.setUint32(24, params.transformType ?? 0, LE);
		view.setFloat32(28, params.transformParam ?? 0, LE);
		view.setUint32(32, params.slotBase ?? NO_SLOT_TABLE, LE);

		return buffer;
	}

	// ============================================================
	// VIEWMANAGER INTEGRATION
	// ============================================================

	/**
	 * Register this scale for a source table. After domain is set,
	 * the view will be created with the index column (one-shot).
	 */
	registerTable(sourceTable: string): void {
		this.#registeredTables.add(sourceTable);
		this.#maybeCreateView(sourceTable);
	}

	/**
	 * Create view for a table if both table is registered and domain is known.
	 * Only creates once per table (one-shot).
	 */
	#maybeCreateView(sourceTable: string): void {
		// Only create once per table
		if (this.#viewsCreated.has(sourceTable)) {
			return;
		}

		// Need domain to be ready
		if (!this.isOrdinal || this.domain.length === 0) {
			return;
		}

		this.#viewsCreated.add(sourceTable);
	}

	#unregisterFromViewManager(): void {
		this.#registeredTables.clear();
		this.#viewsCreated.clear();
	}

	// ============================================================
	// DOMAIN UPDATES
	// ============================================================

	/**
	 * Update the domain. Triggers GPU re-upload.
	 * Also triggers one-shot view creation for registered tables.
	 */
	setDomain(newDomain: (string | number)[]): void {
		if (!newDomain || newDomain.length === 0) return;

		// Check if domain actually changed
		const domainChanged =
			newDomain.length !== this.domain.length || newDomain.some((v, i) => v !== this.domain[i]);

		if (!domainChanged) return;

		this.domain = [...newDomain];
		this.#uploadToGPU();

		// Domain order changed — clear one-shot guard to force view recreation
		// so the CASE expression matches the new domain→index mapping.
		this.#viewsCreated.clear();
		for (const table of this.#registeredTables) {
			this.#maybeCreateView(table);
		}
	}

	/**
	 * Update the scheme. Triggers GPU re-upload.
	 */
	setScheme(newScheme: string): void {
		if (newScheme === this.#scheme) return;

		const newSchemeType = getSchemeType(newScheme);
		const wasOrdinal = this.isOrdinal;

		// Re-resolve render/transform types with new scheme
		// If the scale type is a transform type (log/symlog/etc.), keep it;
		// otherwise infer from the new scheme.
		const effectiveType =
			this.#transformType !== 'linear' ? this.#scaleType : newSchemeType || 'sequential';
		const resolved = resolveColorScaleTypes(effectiveType, newScheme);
		const nowOrdinal = resolved.renderType === 'ordinal';

		// Swap slots if changing between ordinal and continuous
		if (wasOrdinal !== nowOrdinal) {
			this.#swapSlots(nowOrdinal);
		}

		this.#scheme = newScheme;
		this.#scaleType = effectiveType;
		this.#renderType = resolved.renderType;
		this.#transformType = resolved.transformType;
		this._version++;

		if (this.domain.length > 0) {
			this.#uploadToGPU();
			// Trigger re-render - registry will invalidate charts using this scale
			this.#registry.invalidateChartsUsingScale(this);
		}
	}

	/**
	 * Update the normalization transform. Triggers GPU re-upload.
	 * Called when the user changes the color scale type (e.g., linear → symlog)
	 * while keeping the same field.
	 */
	setTransform(scaleType: ColorScaleType, constant?: number, exponent?: number): void {
		const resolved = resolveColorScaleTypes(scaleType, this.#scheme);

		// No change — bail
		if (
			resolved.transformType === this.#transformType &&
			(constant ?? 1) === this.#constant &&
			(exponent ?? 1) === this.#exponent
		) {
			return;
		}

		this.#scaleType = scaleType;
		this.#renderType = resolved.renderType;
		this.#transformType = resolved.transformType;
		this.#constant = constant ?? 1;
		this.#exponent = exponent ?? 1;
		this._version++;

		if (this.domain.length > 0) {
			this.#uploadToGPU();
			this.#registry.invalidateChartsUsingScale(this);
		}
	}

	// ============================================================
	// MARK REGISTRATION (for domain aggregation)
	// ============================================================

	/**
	 * Register a mark's data extent with this scale.
	 */
	addMark(extent: (string | number)[], markId: string): void {
		// For now, simple domain overwrite
		// TODO: Aggregate across multiple marks if needed
		this.setDomain(extent);
	}

	/**
	 * Unregister a mark from this scale.
	 */
	removeMark(markId: string): void {
		// TODO: Remove mark's contribution to domain
	}

	// ============================================================
	// CPU-SIDE COLOR LOOKUP & TICKS
	// ============================================================

	/**
	 * Generate transform-aware tick values for the legend.
	 *
	 * For log/sqrt/pow: delegates to a d3 log/pow scale's .ticks() which
	 * produces decade-spaced values.
	 * For symlog: mirrors SymlogScaleState.getTicks() — D3 symlog's .ticks()
	 * is linear, so we delegate to scaleLog for each half ± zero.
	 * For linear: uses d3-array's linear ticks.
	 */
	ticks(count: number = 5): number[] {
		if (this.domain.length < 2) return [];
		const lo = this.domain[0] as number;
		const hi = this.domain[this.domain.length - 1] as number;
		if (!isFinite(lo) || !isFinite(hi) || lo >= hi) return [];

		return colorScaleTicks(lo, hi, count, this.#transformType, this.#constant, this.#exponent);
	}

	/** CSS color for the null/unmappable sentinel (matches GPU default nullColor). */
	static readonly NULL_COLOR = '#808080';

	/**
	 * Get color for a value (CPU-side lookup).
	 * Returns NULL_COLOR for values that are unmappable under the current
	 * transform (e.g. non-positive values under log), mirroring the GPU shader.
	 */
	getColor(value: string | number): string {
		if (!this.#d3Scale) return '#000000';
		if (this.#transformType === 'log' && typeof value === 'number' && value <= 0) {
			return ColorScaleState.NULL_COLOR;
		}
		return (this.#d3Scale as (v: string | number) => string)(value);
	}

	/**
	 * Get color as RGBA array (0-1 range).
	 */
	getColorRGBA(value: string | number): RGBA {
		const cssColor = this.getColor(value);
		return parseColorToRGBA(cssColor);
	}

	// ============================================================
	// ACTIVE VALUES (selection feedback)
	// ============================================================

	setActiveValues(values: Iterable<string | number>): void {
		this.#activeValues = values instanceof Set ? values : new Set(values);
	}

	clearActiveValues(): void {
		this.#activeValues = null;
	}

	isActive(value: string | number): boolean {
		return this.#activeValues == null || this.#activeValues.has(value);
	}

	// ============================================================
	// CLEANUP
	// ============================================================

	destroy(): void {
		// Unregister from ViewManager
		this.#unregisterFromViewManager();

		// Slots are released by registry via gpuSlots getter
		this.#activeValues = null;
		this.#d3Scale = null;
		this.#categoryMap.clear();
		this.ready = false;
	}
}
