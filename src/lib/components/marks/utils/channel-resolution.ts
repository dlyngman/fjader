import type { DataAccessor } from '$lib/data/DataAccessor';
import type { AnyScaleState } from '$lib/scales';

type ArrayLike = Float32Array | Int32Array | Uint32Array | number[] | string[];

interface ResolveChannelParams {
	value: unknown;
	channel?: string;
	dataAccessor?: DataAccessor;
	tryColumns?: string[];
	instanceCount: number;
	fallback?: number;
}

interface ResolveChannelDataParams extends ResolveChannelParams {
	scaleState?: AnyScaleState;
	scaleType?: string;
	markId?: string;
	suppressUnmappedWarning?: boolean;
}

/**
 * Resolves a channel prop to raw data array.
 *
 * Resolution priority (CRITICAL - order matters!):
 * 1. Transform Overrides (tryColumns) - e.g., 'x0' from stack transform
 * 2. Direct Array/TypedArray Props - e.g., x={[1,2,3]} for No-DB mode
 * 3. Constant Numeric Props - e.g., x1={0} for baseline
 * 4. Default Data Column (channel) - e.g., 'x1' from SQL query
 * 5. Fallback Value - e.g., alpha defaults to 0.8
 */
export function resolveChannel({
	value,
	channel,
	dataAccessor,
	tryColumns,
	instanceCount,
	fallback
}: ResolveChannelParams): ArrayLike | null {
	if (!instanceCount) return null;

	// 1. Transform Overrides
	if (dataAccessor && tryColumns) {
		for (const col of tryColumns) {
			const data = dataAccessor.getColumn(col);
			if (data) {
				return data;
			}
		}
	}

	// 2. Direct Array/TypedArray Prop
	if (Array.isArray(value) || ArrayBuffer.isView(value)) {
		if ((value as ArrayLike).length !== instanceCount) {
			throw new Error(
				`Channel array length mismatch: expected ${instanceCount} items, got ${(value as ArrayLike).length}. ` +
					`Each channel must have the same length as the instance count.`
			);
		}
		return value as ArrayLike;
	}

	// 3. Constant Numeric Prop
	if (typeof value === 'number') {
		const arr = new Float32Array(instanceCount);
		arr.fill(value);
		return arr;
	}

	// 4. Default Data Column
	if (dataAccessor && channel) {
		const data = dataAccessor.getColumn(channel);
		if (data) return data;
	}

	// 5. Fallback
	if (fallback !== undefined) {
		const arr = new Float32Array(instanceCount);
		arr.fill(fallback);
		return arr;
	}

	return null;
}

export function toFloat32(data: ArrayLike | null): Float32Array | null {
	if (!data) return null;
	if (data instanceof Float32Array) return data;
	return new Float32Array(data as number[]);
}

/**
 * Resolve channel data for GPU rendering in one call.
 * Combines resolveChannel() + optional band/point scale mapping + toFloat32().
 */
export function resolveChannelData({
	value,
	channel,
	dataAccessor,
	tryColumns,
	instanceCount,
	fallback,
	scaleState,
	scaleType,
	markId,
	suppressUnmappedWarning
}: ResolveChannelDataParams): Float32Array | null {
	if (!instanceCount) return null;
	const raw = resolveChannel({ value, channel, dataAccessor, tryColumns, instanceCount, fallback });
	if (!raw) return null;

	if ((scaleType === 'band' || scaleType === 'point') && scaleState?.processDataForGPU) {
		return toFloat32(scaleState.processDataForGPU(raw, markId, { suppressUnmappedWarning }));
	}

	return toFloat32(raw);
}

export function computeInstanceCount(
	data: { length: number } | null,
	...fallbackArrays: unknown[]
): number {
	if (data?.length) return data.length;
	for (const arr of fallbackArrays) {
		if (Array.isArray(arr) || ArrayBuffer.isView(arr)) return (arr as ArrayLike).length;
	}
	return 0;
}
