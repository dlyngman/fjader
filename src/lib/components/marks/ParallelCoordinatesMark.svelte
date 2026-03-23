<script lang="ts">
	import { getContext, onDestroy, untrack } from 'svelte';
	import { MarkLifecycle } from './lifecycle/MarkLifecycle.svelte';
	import { ParallelLines } from '../rendering';
	import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities';
	import {
		buildSelectFromChannels,
		MarkColor,
		generateMarkId,
		resolveSelection
	} from './utils';
	import { getGPUContext } from '$lib/gpu';
	import type {
		FieldRef,
		Coordinator,
		ChartContext,
		ColorScheme,
		CurveType,
		Transform
	} from '$lib/types';
	import type { ScaleRegistry } from '$lib/scales/ScaleRegistry.svelte';
	import type { Selection } from '@uwdata/mosaic-core';

	interface Props {
		table: string;
		columns: FieldRef[];
		stroke?: FieldRef | null;
		scheme?: ColorScheme;
		opacity?: number;
		strokeWidth?: number;
		curve?: CurveType;
		selection?: string | Selection;
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
	const coordinator = getContext<Coordinator>('mosaic-coordinator');
	const chartContext = getContext<ChartContext>('chart');
	const scaleRegistry = getContext<ScaleRegistry>('scale-registry');
	const gpuCoordinator = getGPUContext();

	MarkLifecycle.ensureServices(coordinator);

	// --- ChartConfig registration ---
	const entry = chartContext.config.registerMark(markId, 'parallel', {
		table: () => table,
		columns: () => columns,
		stroke: () => stroke,
		scheme: () => scheme,
		selection: () => selection,
		transforms: () => transforms
	});

	let setup = $state<MarkLifecycle | null>(null);

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
		selection: resolveSelection(entry.selection),
		transforms: entry.transforms ?? [],
		select: channelSelect,
		colorChannel: 'stroke',
		clientOptions: {},
		sort: null,
		domain: null,
		tooltip: false,
		parallelMode: true,
		parallelColumns: columnNames
	});

	let xScaleId = $derived(chartContext.xScaleState?.id);

	// --- SETUP LIFECYCLE ---
	$effect(() => {
		void config;
		void xScaleId;
		untrack(() => {
			setup?.destroy();
			setup = null;
			if (entry.table) {
				setup = new MarkLifecycle(config, coordinator, chartContext, markId);
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

	const currentAxisOrder = $derived(chartContext.parallelScales?.axisOrder ?? columnNames.map((_: string, i: number) => i));

	// Per-axis normalized x-positions (0–1) — animated by ChartScales.
	// Falls back to evenly spaced if no animated positions available.
	const currentAxisXPositions = $derived.by(() => {
		const animated = chartContext.animatedAxisXPositions;
		if (animated && animated.length === columnNames.length) return animated;
		const n = columnNames.length;
		return Array.from({ length: n }, (_, i) => (n > 1 ? i / (n - 1) : 0.5));
	});

	// Scale SSBO indices — resolved from scale state IDs (UUIDs), not column names
	const currentScaleIndices = $derived.by(() => {
		const ps = chartContext.parallelScales;
		if (!ps || !gpuCoordinator) return [];
		return ps.scaleStates.map((scale) => {
			return gpuCoordinator.getScaleIndex?.(scale.id) ?? 0;
		});
	});

	onDestroy(() => {
		setup?.destroy();
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
		constantColor={markColor.constantColor}
		axisOrder={currentAxisOrder}
		axisScaleIndices={currentScaleIndices}
		axisXPositions={currentAxisXPositions}
		{strokeWidth}
		{opacity}
		{curve}
		{rowCount}
		axisCount={columnNames.length}
	/>
{:else if setup?.client?.error}
	<div style="color: red; padding: 1rem;">Error: {(setup.client.error as Error).message}</div>
{/if}
