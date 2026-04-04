export {
	SelectionRegistry,
	SelectionGroup,
	isNeutral,
	setSelectionRegistry,
	getSelectionRegistry
} from './SelectionRegistry.svelte';

export type {
	ActiveValueScale,
	FilterSchema,
	AugmentedClause,
	FilterItem,
	CreateLocalOpts
} from './SelectionRegistry.svelte';

export { default as SelectionBridge } from './SelectionBridge.svelte';
