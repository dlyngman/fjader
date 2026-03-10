/**
 * M4 Decimation Compute Shader
 *
 * GPU compute shader that implements the M4 algorithm for line decimation.
 * For each pixel bin, keeps 4 representative points (First, Last, Min-Y, Max-Y)
 * to preserve visual fidelity while dramatically reducing vertex count.
 *
 * Uses 7 compute passes:
 *   Pass 0 (initBins): Read JS decision + init bin atomics
 *   Pass 1 (binPoints): Bin each point (if decimating)
 *   Pass 2 (findMinMaxIndices): Find indices of min/max Y points per bin
 *   Pass 3 (emitOutput): Write decimated x/y/series/color arrays
 *   Pass 4 (compact): Pack non-NaN points contiguously
 *   Pass 5a (passthroughXY): Copy raw x,y → output + set indirect count
 *   Pass 5b (passthroughSC): Copy raw series,color → output
 *
 * JS owns the decimate/passthrough decision via LODController. The decision
 * is written to config.decimationMode (1=decimate, 2=passthrough) and read by INIT_BINS.
 * drawIndirect lets the GPU control its own instance count.
 *
 * Passthrough is split into two sub-dispatches (XY + series/color) to stay
 * within the 8 storage buffer per-stage limit.
 *
 * Bind group layout:
 *   Group 0: Input data + config + bins
 *   Group 1: Control buffer (OR output arrays)
 *   Group 2: Global scale SSBO (shared with render pipeline)
 */

const WORKGROUP_SIZE = 256;

/**
 * Shared type definitions used across all kernels.
 */
const SHARED_TYPES = /* wgsl */ `
struct ScaleParam {
	p1: f32,
	p2: f32,
	p3: f32,
	p4: f32,
};

struct M4Config {
	pointCount: u32,
	numBins: u32,
	numSeries: u32,
	xScaleIndex: u32,
	_reserved0: u32,
	_reserved1: u32,
	_reserved2: u32,
	decimationMode: u32,
};

struct M4Bin {
	firstIdx: atomic<u32>,
	lastIdx: atomic<u32>,
	minYSortable: atomic<u32>,
	maxYSortable: atomic<u32>,
	minYIdx: atomic<u32>,
	maxYIdx: atomic<u32>,
};

fn floatToSortableUint(f: f32) -> u32 {
	let bits = bitcast<u32>(f);
	return select(~bits, bits ^ 0x80000000u, (bits & 0x80000000u) == 0u);
}
`;

/**
 * Pass 0: Read JS decision + initialize bins.
 *
 * Thread 0 reads the JS-driven decimate/passthrough decision from config.decimationMode,
 * writes the decision flag to control[4], and sets instance count.
 * All threads unconditionally init bins.
 *
 * Control buffer layout: [vertexCount, instanceCount, firstVertex,
 * firstInstance, shouldDecimate]. drawIndirect reads first 4 u32s only.
 *
 * Group 0: inputLayout (data dummies + config + bins)
 * Group 1: controlLayout (control)
 * Group 2: globalScaleLayout (scaleParams — unused but bound for layout compatibility)
 */
const INIT_BINS_SHADER = /* wgsl */ `
${SHARED_TYPES}

@group(0) @binding(4) var<uniform> config: M4Config;
@group(0) @binding(5) var<storage, read_write> bins: array<M4Bin>;
@group(1) @binding(0) var<storage, read_write> control: array<atomic<u32>>;
@group(2) @binding(0) var<storage, read> scaleParams: array<ScaleParam>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let binKey = gid.x;
	let totalBins = config.numSeries * config.numBins;

	// Thread 0: read JS decision, set instance count
	if (binKey == 0u) {
		let outputSize = config.numBins * config.numSeries * 4u;
		// JS sets _pad: 1 = decimate, 2 = passthrough
		let shouldDec = config.decimationMode == 1u;
		atomicStore(&control[4], select(0u, 1u, shouldDec));
		atomicStore(&control[1], select(0u, outputSize, shouldDec));
	}

	// Always init bins — cheap and ensures clean state for potential decimation.
	if (binKey >= totalBins) { return; }

	atomicStore(&bins[binKey].firstIdx, 0xFFFFFFFFu);
	atomicStore(&bins[binKey].lastIdx, 0u);
	atomicStore(&bins[binKey].minYSortable, 0xFFFFFFFFu);
	atomicStore(&bins[binKey].maxYSortable, 0u);
	atomicStore(&bins[binKey].minYIdx, 0xFFFFFFFFu);
	atomicStore(&bins[binKey].maxYIdx, 0xFFFFFFFFu);
}
`;

/**
 * Pass 1: Bin each point by scaled x position.
 *
 * Only runs binning when decimating (control[4] == 1).
 * Early-exits entirely in passthrough mode.
 *
 * Group 0: inputLayout (x, y, series, [color dummy], config, bins)
 * Group 1: controlLayout (control)
 * Group 2: globalScaleLayout (scaleParams)
 */
const BIN_POINTS_SHADER = /* wgsl */ `
${SHARED_TYPES}

@group(0) @binding(0) var<storage, read> xValues: array<f32>;
@group(0) @binding(1) var<storage, read> yValues: array<f32>;
@group(0) @binding(2) var<storage, read> seriesValues: array<f32>;
@group(0) @binding(4) var<uniform> config: M4Config;
@group(0) @binding(5) var<storage, read_write> bins: array<M4Bin>;
@group(1) @binding(0) var<storage, read_write> control: array<atomic<u32>>;
@group(2) @binding(0) var<storage, read> scaleParams: array<ScaleParam>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	// Only bin if decimating
	if (atomicLoad(&control[4]) == 0u) { return; }

	let idx = gid.x;
	if (idx >= config.pointCount) { return; }

	let x = xValues[idx];
	let y = yValues[idx];

	// Skip NaN points
	if (x != x || y != y) { return; }

	let scale = scaleParams[config.xScaleIndex];
	let domainMin = scale.p1;
	let domainMax = scale.p2;

	let t = (x - domainMin) / (domainMax - domainMin);

	// Series: 0-indexed from ViewManager (-1 = null/unknown, 0+ = categories)
	let seriesF = seriesValues[idx];
	if (seriesF < 0.0 || seriesF != seriesF) { return; }
	let series = u32(seriesF);
	if (series >= config.numSeries) { return; }

	// Bin assignment: boundary bins capture off-screen points for line connectivity.
	// Bins 0 and numBins-1 are boundary bins; bins 1..numBins-2 map to viewport pixels.
	var bin: u32;
	if (t < 0.0) {
		bin = 0u;
	} else if (t > 1.0) {
		bin = config.numBins - 1u;
	} else {
		let innerBins = config.numBins - 2u;
		bin = 1u + min(u32(floor(t * f32(innerBins))), innerBins - 1u);
	}
	let binKey = series * config.numBins + bin;

	atomicMin(&bins[binKey].firstIdx, idx);
	atomicMax(&bins[binKey].lastIdx, idx);

	let ySortable = floatToSortableUint(y);
	atomicMin(&bins[binKey].minYSortable, ySortable);
	atomicMax(&bins[binKey].maxYSortable, ySortable);
}
`;

/**
 * Pass 2: Find indices of min/max Y points.
 * Each thread re-checks if its Y value matches the bin's min/max.
 * Uses atomicMin for deterministic tie-breaking (smallest index wins).
 *
 * Early-exits entirely in passthrough mode (no work needed).
 *
 * Group 0: inputLayout (x, y, series, [color dummy], config, bins)
 * Group 1: controlLayout (control — only reads shouldDecimate)
 * Group 2: globalScaleLayout (scaleParams)
 */
const FIND_MINMAX_SHADER = /* wgsl */ `
${SHARED_TYPES}

@group(0) @binding(0) var<storage, read> xValues: array<f32>;
@group(0) @binding(1) var<storage, read> yValues: array<f32>;
@group(0) @binding(2) var<storage, read> seriesValues: array<f32>;
@group(0) @binding(4) var<uniform> config: M4Config;
@group(0) @binding(5) var<storage, read_write> bins: array<M4Bin>;
@group(1) @binding(0) var<storage, read_write> control: array<atomic<u32>>;
@group(2) @binding(0) var<storage, read> scaleParams: array<ScaleParam>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	if (atomicLoad(&control[4]) == 0u) { return; }

	let idx = gid.x;
	if (idx >= config.pointCount) { return; }

	let x = xValues[idx];
	let y = yValues[idx];

	if (x != x || y != y) { return; }

	let scale = scaleParams[config.xScaleIndex];
	let domainMin = scale.p1;
	let domainMax = scale.p2;

	let t = (x - domainMin) / (domainMax - domainMin);

	// Series: 0-indexed (matches binPoints pass)
	let seriesF = seriesValues[idx];
	if (seriesF < 0.0 || seriesF != seriesF) { return; }
	let series = u32(seriesF);
	if (series >= config.numSeries) { return; }

	// Boundary bin clamping (matches binPoints pass)
	var bin: u32;
	if (t < 0.0) {
		bin = 0u;
	} else if (t > 1.0) {
		bin = config.numBins - 1u;
	} else {
		let innerBins = config.numBins - 2u;
		bin = 1u + min(u32(floor(t * f32(innerBins))), innerBins - 1u);
	}
	let binKey = series * config.numBins + bin;

	let ySortable = floatToSortableUint(y);

	if (ySortable == atomicLoad(&bins[binKey].minYSortable)) {
		atomicMin(&bins[binKey].minYIdx, idx);
	}
	if (ySortable == atomicLoad(&bins[binKey].maxYSortable)) {
		atomicMin(&bins[binKey].maxYIdx, idx);
	}
}
`;

/**
 * Pass 3: Emit decimated output arrays.
 * Each thread processes one bin, collecting up to 4 unique indices
 * (first, last, minY, maxY), sorting by original index to preserve
 * x-order, and writing x/y/series/color to output arrays.
 * Empty bins output NaN, causing the vertex shader to discard segments.
 *
 * Always runs (no decision check). In passthrough mode, all bins are empty
 * (pass 1 skips binning), so this writes NaN everywhere — harmless since
 * pass 5a/5b overwrites with raw data.
 *
 * Group 0: emitInputLayout (x, y, color, config, bins)
 * Group 1: outputLayout (xOut, yOut, seriesOut, colorOut)
 */
const EMIT_OUTPUT_SHADER = /* wgsl */ `
${SHARED_TYPES}

// Note: seriesValues not bound here — series is derived from binKey / numBins.
// This keeps total storage buffers within WebGPU default limit.
@group(0) @binding(0) var<storage, read> xValues: array<f32>;
@group(0) @binding(1) var<storage, read> yValues: array<f32>;
@group(0) @binding(2) var<storage, read> colorValues: array<f32>;
@group(0) @binding(3) var<uniform> config: M4Config;
@group(0) @binding(4) var<storage, read_write> bins: array<M4Bin>;
@group(1) @binding(0) var<storage, read_write> xOut: array<f32>;
@group(1) @binding(1) var<storage, read_write> yOut: array<f32>;
@group(1) @binding(2) var<storage, read_write> seriesOut: array<f32>;
@group(1) @binding(3) var<storage, read_write> colorOut: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let binKey = gid.x;
	let totalBins = config.numSeries * config.numBins;
	if (binKey >= totalBins) { return; }

	let outBase = binKey * 4u;
	let firstIdx = atomicLoad(&bins[binKey].firstIdx);

	// Empty bin: write NaN to all 4 output slots
	// Use var to avoid const-expression NaN (WGSL disallows NaN in const context)
	if (firstIdx == 0xFFFFFFFFu) {
		var nanBits = 0x7FC00000u;
		let nan = bitcast<f32>(nanBits);
		for (var i = 0u; i < 4u; i++) {
			xOut[outBase + i] = nan;
			yOut[outBase + i] = nan;
			seriesOut[outBase + i] = nan;
			colorOut[outBase + i] = nan;
		}
		return;
	}

	let lastIdx = atomicLoad(&bins[binKey].lastIdx);
	let minYIdx = atomicLoad(&bins[binKey].minYIdx);
	let maxYIdx = atomicLoad(&bins[binKey].maxYIdx);

	// Collect up to 4 unique indices, sorted by original index (= x-order)
	var indices: array<u32, 4>;
	var count = 0u;

	// Insert in sorted order, skip duplicates
	var candidates = array<u32, 4>(firstIdx, lastIdx, minYIdx, maxYIdx);

	// Simple insertion sort for up to 4 candidates
	for (var c = 0u; c < 4u; c++) {
		let candidate = candidates[c];
		// Check if already present
		var isDuplicate = false;
		for (var k = 0u; k < count; k++) {
			if (indices[k] == candidate) {
				isDuplicate = true;
				break;
			}
		}
		if (isDuplicate) { continue; }

		// Insert in sorted position
		var insertPos = count;
		for (var k = 0u; k < count; k++) {
			if (candidate < indices[k]) {
				insertPos = k;
				break;
			}
		}
		// Shift elements right
		for (var k = count; k > insertPos; k--) {
			indices[k] = indices[k - 1u];
		}
		indices[insertPos] = candidate;
		count++;
	}

	// Derive series value from bin key (0-indexed, matching ViewManager convention).
	// Vertex shader uses != comparison for series breaks, so any distinct values work.
	let seriesVal = f32(binKey / config.numBins);

	// Write unique points, fill remaining slots with last unique point
	for (var i = 0u; i < 4u; i++) {
		let srcIdx = indices[min(i, count - 1u)];
		xOut[outBase + i] = xValues[srcIdx];
		yOut[outBase + i] = yValues[srcIdx];
		seriesOut[outBase + i] = seriesVal;
		colorOut[outBase + i] = colorValues[srcIdx];
	}
}
`;

/**
 * Pass 4: Compact non-NaN output points and deduplicate.
 * After the emit pass, empty bins contain NaN. This pass packs real data
 * points contiguously so line segments connect them directly.
 * Consecutive duplicate coordinates are also removed.
 *
 * Each series thread atomically adds its compacted count to the indirect
 * draw buffer's instanceCount (control[1]).
 *
 * Early-exits entirely in passthrough mode.
 *
 * One thread per series (sequential scan). For 3 series x 6400 slots each,
 * this completes in microseconds with no thread contention.
 *
 * Group 0: fillLayout (config + output arrays)
 * Group 1: controlLayout (control)
 */
const COMPACT_SHADER = /* wgsl */ `
struct M4Config {
	pointCount: u32,
	numBins: u32,
	numSeries: u32,
	xScaleIndex: u32,
	_reserved0: u32,
	_reserved1: u32,
	_reserved2: u32,
	decimationMode: u32,
};

@group(0) @binding(0) var<uniform> config: M4Config;
@group(0) @binding(1) var<storage, read_write> xOut: array<f32>;
@group(0) @binding(2) var<storage, read_write> yOut: array<f32>;
@group(0) @binding(3) var<storage, read_write> seriesOut: array<f32>;
@group(0) @binding(4) var<storage, read_write> colorOut: array<f32>;
@group(1) @binding(0) var<storage, read_write> control: array<atomic<u32>>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	if (atomicLoad(&control[4]) == 0u) { return; }

	let series = gid.x;
	if (series >= config.numSeries) { return; }

	let start = series * 4u * config.numBins;
	let end = start + 4u * config.numBins;

	// Pack non-NaN points to the front, skipping consecutive duplicates.
	var writeIdx = start;
	var nanBits = 0x7FC00000u;
	var lastX: f32 = bitcast<f32>(nanBits);
	var lastY: f32 = bitcast<f32>(nanBits);

	for (var i = start; i < end; i++) {
		let x = xOut[i];
		if (x != x) { continue; }
		let y = yOut[i];
		if (x == lastX && y == lastY) { continue; }

		if (writeIdx != i) {
			xOut[writeIdx] = x;
			yOut[writeIdx] = y;
			seriesOut[writeIdx] = seriesOut[i];
			colorOut[writeIdx] = colorOut[i];
		}
		lastX = x;
		lastY = y;
		writeIdx++;
	}

	// NaN-pad remaining slots
	let nan = bitcast<f32>(nanBits);
	for (var i = writeIdx; i < end; i++) {
		xOut[i] = nan;
		yOut[i] = nan;
		seriesOut[i] = nan;
		colorOut[i] = nan;
	}

	// Instance count is set by pass 0 (outputSize) — compact only reorganizes
	// data within each series block, it doesn't change the total count.
	// The vertex shader discards NaN-padded entries at the end of each block.
}
`;

/**
 * Pass 5a: Passthrough copy — raw x,y → output + set indirect count.
 *
 * When density is below the decimation threshold, copies raw x/y data
 * directly to the output buffers. Thread 0 sets instanceCount.
 * Split from series/color copy to stay within 8 storage buffer limit.
 *
 * Early-exits entirely in decimate mode.
 *
 * Group 0: passthroughInputLayout (data0, data1, config, control)
 * Group 1: halfOutputLayout (out0, out1)
 */
const PASSTHROUGH_XY_SHADER = /* wgsl */ `
struct M4Config {
	pointCount: u32,
	numBins: u32,
	numSeries: u32,
	xScaleIndex: u32,
	_reserved0: u32,
	_reserved1: u32,
	_reserved2: u32,
	decimationMode: u32,
};

@group(0) @binding(0) var<storage, read> xIn: array<f32>;
@group(0) @binding(1) var<storage, read> yIn: array<f32>;
@group(0) @binding(2) var<uniform> config: M4Config;
@group(0) @binding(3) var<storage, read_write> control: array<atomic<u32>>;
@group(1) @binding(0) var<storage, read_write> xOut: array<f32>;
@group(1) @binding(1) var<storage, read_write> yOut: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	// Only run in passthrough mode
	if (atomicLoad(&control[4]) == 1u) { return; }

	let idx = gid.x;

	// Thread 0 sets instance count to raw point count
	if (idx == 0u) {
		atomicStore(&control[1], config.pointCount);
	}

	if (idx >= config.pointCount) { return; }

	xOut[idx] = xIn[idx];
	yOut[idx] = yIn[idx];
}
`;

/**
 * Pass 5b: Passthrough copy — raw series,color → output.
 *
 * Companion to pass 5a. Copies series/color channels.
 * Split to stay within 8 storage buffer limit.
 *
 * Early-exits entirely in decimate mode.
 *
 * Group 0: passthroughInputLayout (data0, data1, config, control)
 * Group 1: halfOutputLayout (out0, out1)
 */
const PASSTHROUGH_SC_SHADER = /* wgsl */ `
struct M4Config {
	pointCount: u32,
	numBins: u32,
	numSeries: u32,
	xScaleIndex: u32,
	_reserved0: u32,
	_reserved1: u32,
	_reserved2: u32,
	decimationMode: u32,
};

@group(0) @binding(0) var<storage, read> seriesIn: array<f32>;
@group(0) @binding(1) var<storage, read> colorIn: array<f32>;
@group(0) @binding(2) var<uniform> config: M4Config;
@group(0) @binding(3) var<storage, read_write> control: array<atomic<u32>>;
@group(1) @binding(0) var<storage, read_write> seriesOut: array<f32>;
@group(1) @binding(1) var<storage, read_write> colorOut: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	// Only run in passthrough mode
	if (atomicLoad(&control[4]) == 1u) { return; }

	let idx = gid.x;
	if (idx >= config.pointCount) { return; }

	seriesOut[idx] = seriesIn[idx];
	colorOut[idx] = colorIn[idx];
}
`;

export {
	WORKGROUP_SIZE,
	INIT_BINS_SHADER,
	BIN_POINTS_SHADER,
	FIND_MINMAX_SHADER,
	EMIT_OUTPUT_SHADER,
	COMPACT_SHADER,
	PASSTHROUGH_XY_SHADER,
	PASSTHROUGH_SC_SHADER
};
