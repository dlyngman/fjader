// src/lib/scales/index.js
export { setScaleRegistry, getScaleState, ScaleRegistry } from './ScaleRegistry.svelte';
export type { AnyScaleState } from './ScaleRegistry.svelte';

export { LinearScaleState } from './LinearScaleState.svelte';
export { TimeScaleState } from './TimeScaleState.svelte';
export { LogScaleState } from './LogScaleState.svelte';
export { SymlogScaleState } from './SymlogScaleState.svelte';
export { BandScaleState } from './BandScaleState.svelte';
export { SizeScaleState } from './SizeScaleState.svelte';
export { SCALE_PRIORITIES, resolveScaleType, resolveScaleConfiguration } from './ScalePriorities';
export {
	isContinuousScale,
	isNumericScale,
	isCategoricalScale,
	isTemporalScale,
	requiresPositiveDomain
} from './scale-categories';
export type {
	ScaleRequirement,
	RegisteredScaleRequirement,
	ResolvedScaleConfiguration
} from './ScalePriorities';

// NEW exports for extensible configuration
export {
	RESOLUTION_STRATEGIES,
	SCALE_CONFIG_SCHEMAS,
	validateConfigValue
} from './ScaleConfigurationSchemas';
