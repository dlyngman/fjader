/**
 * M4 Decimation Compute Shader
 *
 * GPU compute shader that implements the M4 algorithm for line decimation.
 * For each pixel bin, keeps 4 representative points (First, Last, Min-Y, Max-Y)
 * to preserve visual fidelity while dramatically reducing vertex count.
 *
 * Uses 5 compute passes:
 *   Pass 0 (initBins): Reset bin atomics to sentinel values
 *   Pass 1 (binPoints): Assign each point to a pixel bin, track first/last/minY/maxY
 *   Pass 2 (findMinMaxIndices): Find indices of min/max Y points per bin
 *   Pass 3 (emitOutput): Write decimated x/y/series/color arrays
 *   Pass 4 (compact): Pack non-NaN points contiguously, deduplicate
 *
 * Bind group layout:
 *   Group 0: Input data + config + bins
 *   Group 1: Output arrays
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
 * Pass 0: Initialize all bins to sentinel values.
 * Runs on GPU to avoid CPU→GPU transfer during zoom/pan.
 */
const INIT_BINS_SHADER = /* wgsl */ `
${SHARED_TYPES}

@group(0) @binding(4) var<uniform> config: M4Config;
@group(0) @binding(5) var<storage, read_write> bins: array<M4Bin>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let binKey = gid.x;
	let totalBins = config.numSeries * config.numBins;
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
 * Uses atomics to track first/last index and min/max y per bin.
 * Domain bounds are read from the shared scale SSBO.
 */
const BIN_POINTS_SHADER = /* wgsl */ `
${SHARED_TYPES}

@group(0) @binding(0) var<storage, read> xValues: array<f32>;
@group(0) @binding(1) var<storage, read> yValues: array<f32>;
@group(0) @binding(2) var<storage, read> seriesValues: array<f32>;
@group(0) @binding(4) var<uniform> config: M4Config;
@group(0) @binding(5) var<storage, read_write> bins: array<M4Bin>;
@group(2) @binding(0) var<storage, read> scaleParams: array<ScaleParam>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
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
 */
const FIND_MINMAX_SHADER = /* wgsl */ `
${SHARED_TYPES}

@group(0) @binding(0) var<storage, read> xValues: array<f32>;
@group(0) @binding(1) var<storage, read> yValues: array<f32>;
@group(0) @binding(2) var<storage, read> seriesValues: array<f32>;
@group(0) @binding(4) var<uniform> config: M4Config;
@group(0) @binding(5) var<storage, read_write> bins: array<M4Bin>;
@group(2) @binding(0) var<storage, read> scaleParams: array<ScaleParam>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
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
 */
const EMIT_OUTPUT_SHADER = /* wgsl */ `
${SHARED_TYPES}

// Note: seriesValues not bound here — series is derived from binKey / numBins.
// This keeps total storage buffers at 8 (within WebGPU default limit).
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
 * After the emit pass, empty bins contain NaN. Instead of fill-forward
 * (which created runs of identical points causing zero-length segments),
 * this pass packs real data points contiguously so line segments connect
 * them directly. Consecutive duplicate coordinates are also removed.
 *
 * One thread per series (sequential scan). For 3 series × 6400 slots each,
 * this completes in microseconds with no thread contention.
 */
const COMPACT_SHADER = /* wgsl */ `
struct M4Config {
	pointCount: u32,
	numBins: u32,
	numSeries: u32,
	xScaleIndex: u32,
};

@group(0) @binding(0) var<uniform> config: M4Config;
@group(0) @binding(1) var<storage, read_write> xOut: array<f32>;
@group(0) @binding(2) var<storage, read_write> yOut: array<f32>;
@group(0) @binding(3) var<storage, read_write> seriesOut: array<f32>;
@group(0) @binding(4) var<storage, read_write> colorOut: array<f32>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
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
}
`;

export {
	WORKGROUP_SIZE,
	INIT_BINS_SHADER,
	BIN_POINTS_SHADER,
	FIND_MINMAX_SHADER,
	EMIT_OUTPUT_SHADER,
	COMPACT_SHADER
};
