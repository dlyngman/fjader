<script module lang="ts">
	/**
	 * Test-only: give each axis another axis's scale (the list reversed).
	 *
	 * The scale-source parity page's control for parallel coordinates — a wrong
	 * scale reaching an axis, deliberately, which the comparison must see. Read
	 * when the mark mounts, so it takes effect on the next mount. Never set in
	 * production.
	 */
	export const parallelParity = { reverseScales: false };
</script>

<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycleV2 } from './lifecycle/MarkLifecycleV2.svelte';
	import { ParallelLines } from '../rendering';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import { buildSelectFromChannels, MarkColor, generateMarkId } from './utils';
	import { buildReactiveConfig } from './utils/reactive-config';
	import type { FieldRef, ChartContext, ColorScheme, CurveType, Transform } from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { QueryEngine } from '$lib/query-engine/QueryEngine';
	import type { FilterGroupRegistry } from '$lib/query-engine/FilterGroupRegistry.svelte';

	interface Props {
		table: string;
		columns: FieldRef[];
		stroke?: FieldRef | null;
		scheme?: ColorScheme;
		opacity?: number;
		strokeWidth?: number;
		curve?: CurveType;
		selection?: string;
		transforms?: Transform[];
	}

	let {
		table,
		columns,
		stroke = null,
		scheme = undefined,
		opacity = 1,
		strokeWidth = 2,
		curve = 'linear',
		selection = undefined,
		transforms = []
	}: Props = $props();

	const markId = generateMarkId('parallel');
	const queryEngine = getContext<QueryEngine>('query-engine');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const filterGroups = getContext<FilterGroupRegistry>('filter-groups');

	// --- ChartConfig registration ---
	const entry = chartContext.config.registerMark(markId, 'parallel', {
		table: () => table,
		columns: () => columns,
		stroke: () => stroke,
		scheme: () => scheme,
		selection: () => selection,
		transforms: () => transforms
	});

	let setup = $state<MarkLifecycleV2 | null>(null);

	// Column names as strings (handles both string column names and ExprNode)
	const columnNames = $derived((entry.columns as unknown as FieldRef[]).map(String));

	// Color: stroke determines line color
	const markColor = new MarkColor(
		() => entry.stroke,
		() => entry.scheme,
		'stroke',
		() => entry.table,
		() => setup,
		scaleRegistry,
		chartContext
	);

	// Build select: each column name as key+value, plus stroke if present
	const channelSelect = $derived(
		buildSelectFromChannels({
			...Object.fromEntries(columnNames.map((col) => [col, col])),
			...(markColor.selectField && { stroke: markColor.selectField })
		})
	);

	const config = $derived({
		markType: 'parallel',
		supportedScaleTypes: {
			x: ['linear'],
			y: ['linear']
		},
		scaleRequirements: {
			x: {
				type: 'linear' as const,
				priority: SCALE_PRIORITIES.PREFER,
				config: {}
			},
			y: null
		},
		inferredScaleColumns: { x: undefined },
		table: entry.table,
		transforms: entry.transforms ?? [],
		select: channelSelect,
		colorChannel: 'stroke',
		parallelMode: true,
		parallelColumns: columnNames
	});

	const reactiveConfig = buildReactiveConfig(entry);

	let xScaleId = $derived(chartContext.xScaleState?.id);

	// --- SETUP LIFECYCLE ---
	$effect(() => {
		void config;
		void xScaleId;
		untrack(() => {
			setup?.destroy();
			setup = null;
			if (entry.table && queryEngine) {
				setup = new MarkLifecycleV2(
					config,
					reactiveConfig,
					queryEngine,
					chartContext,
					markId,
					filterGroups.get(entry.selection as string | undefined)
				);
			}
		});
	});

	// --- DATA RESOLUTION FOR RENDERER ---

	const parallelColumnData = $derived.by(() => {
		if (!setup?.data) return null;
		const result: Record<string, Float32Array> = {};
		for (const col of columnNames) {
			const raw = setup.data.getColumn(col);
			if (!raw) return null;
			result[col] = raw instanceof Float32Array ? raw : new Float32Array(raw as number[]);
		}
		return result;
	});

	const rowCount = $derived(setup?.data?.length ?? 0);

	const currentAxisOrder = $derived(
		chartContext.parallelScales?.axisOrder ?? columnNames.map((_: string, i: number) => i)
	);

	// Per-axis normalized x-positions (0–1) — animated by ChartScales.
	// Falls back to evenly spaced if no animated positions available.
	const currentAxisXPositions = $derived.by(() => {
		const animated = chartContext.animatedAxisXPositions;
		if (animated && animated.length === columnNames.length) return animated;
		const n = columnNames.length;
		return Array.from({ length: n }, (_, i) => (n > 1 ? i / (n - 1) : 0.5));
	});

	// Each axis's scale id, in data order. The coordinator turns these into
	// params on every frame the chart draws, so nothing here can go stale.
	const currentScaleIds = $derived.by(() => {
		const ps = chartContext.parallelScales;
		if (!ps) return [];
		// Reversed only for the parity page's control; see parallelParity.
		const states = parallelParity.reverseScales ? [...ps.scaleStates].reverse() : ps.scaleStates;
		return states.map((scale) => scale.id);
	});

	onDestroy(() => {
		setup?.destroy();
		// Here, not in setup.destroy(): a setup re-created for new columns has
		// already set the new list, under the same mark id.
		chartContext.setParallelColumns(markId, []);
		chartContext.config.unregisterMark(markId);
	});
</script>

{#if setup?.gpuReady && setup?.data && parallelColumnData && markColor.ready}
	<ParallelLines
		{markId}
		columnData={parallelColumnData}
		parallelColumns={columnNames}
		colorValueData={markColor.data}
		colorMode={markColor.colorMode}
		colorScaleIndex={markColor.colorScaleIndex}
		groupIndex={setup?.groupIndex ?? 0}
		constantColor={markColor.constantColor}
		axisOrder={currentAxisOrder}
		axisScaleIds={currentScaleIds}
		axisXPositions={currentAxisXPositions}
		{strokeWidth}
		{opacity}
		{curve}
		{rowCount}
		axisCount={columnNames.length}
	/>
{/if}
