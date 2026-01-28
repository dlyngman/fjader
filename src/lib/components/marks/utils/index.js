// export {
//   getSourceType, processData, buildSelectFromChannels } from './data-processing.js';

export {
	getSourceType,
	processData,
	processAlphaData,
	processColorData,
	parseColor,
	buildSelectFromChannels
} from './data-processing.js';

export { resolveChannel, toFloat32 } from './channel-resolution.js';
export { MarkColor } from './MarkColor.svelte.js';
export { MarkSeries } from './MarkSeries.svelte.js';
