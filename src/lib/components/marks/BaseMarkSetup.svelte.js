// src/lib/components/marks/BaseMarkSetup.svelte.js

import { untrack } from 'svelte';
import { DataClient } from '$lib/data-clients/DataClient.svelte.js';
import {
	Query,
	isNode,
	column as sqlColumn,
	isAggregateExpression,
	isNotNull,
	and
} from '@uwdata/mosaic-sql';
import { SCALE_PRIORITIES } from '$lib/scales/ScalePriorities.js';
import { TransformCompiler } from '$lib/transforms/TransformCompiler.js';
import { ArrowDataAccessor, ObjectDataAccessor } from '$lib/data/DataAccessor.js';

export class BaseMarkSetup {
	// --- Reactive State ---
	client = $state(null);
	categoricalDataFetched = $state(false);

	// --- Setup Progress ---
	#scaleStatesReady = $state(false);
	#scaleMappingsReady = $state(false);
	#clientCreated = $state(false);
	#clientDataReady = $state(false);
	#continuousDomainsSet = $state(false);
	#categoricalFetchStarted = $state(false);

	// --- Private Properties ---
	#config;
	#coordinator;
	#chartContext;
	#markId;
	#scaleMap = {};

	// --- Transform Support ---
	#transformCompiler;
	#autoBinNodes = new Map(); // channel -> AutoBinNode

	constructor(config, coordinator, chartContext, stableId = null) {
		console.log('🔧 BaseMarkSetup constructor:', {
			markType: config.markType,
			transforms: config.transforms,
			transformCount: config.transforms?.length || 0
		});

		this.#config = config;
		this.#coordinator = coordinator;
		this.#chartContext = chartContext;
		this.#markId = stableId || `${config.markType}-${crypto.randomUUID().slice(0, 8)}`;

		// NEW: Create transform compiler
		this.#transformCompiler = new TransformCompiler(config.transforms || []);

		console.log('🔧 TransformCompiler created:', {
			sqlTransforms: this.#transformCompiler.sqlTransforms.length,
			jsTransforms: this.#transformCompiler.jsTransforms.length
		});

		// NEW: Detect auto bins in select
		this.#detectAutoBins();

		this.#registerScaleRequirements();
		this.#setupReactiveEffects();
	}

	// NEW: Detect AutoBinNodes in config
	#detectAutoBins() {
		for (const [channel, value] of Object.entries(this.#config.select)) {
			if (value?.isAutoBinNode) {
				this.#autoBinNodes.set(channel, value);
			}
		}
	}

	#setupReactiveEffects() {
		// Effect 1: Wait for scale objects
		$effect(() => {
			const { scaleTypes, xScaleState, yScaleState } = this.#chartContext;
			if (!!(scaleTypes && xScaleState && yScaleState) && !this.#scaleStatesReady) {
				this.#scaleStatesReady = true;
			}
		});

		// Effect 2: Setup scale mappings
		$effect(() => {
			if (this.#scaleStatesReady && !this.#scaleMappingsReady) {
				this.#setupScaleMappings();
				this.#scaleMappingsReady = true;
			}
		});

		// Effect 3: Create client
		$effect(() => {
			if (this.#scaleMappingsReady && !this.#clientCreated) {
				const fieldRequests = this.#buildFieldInfoRequests();
				this.#createClient(fieldRequests);
				this.#clientCreated = true;
			}
		});

		// Effect 4: Monitor client data readiness
		$effect(() => {
			if (this.#clientCreated && this.client?.fieldInfo && !this.#clientDataReady) {
				this.#clientDataReady = true;
			}
		});

		// Effect 5: Set initial continuous domains
		$effect(() => {
			if (this.#clientDataReady && !this.#continuousDomainsSet) {
				this.#setInitialContinuousDomains(this.client.fieldInfo);
				this.#continuousDomainsSet = true;
			}
		});

		// Effect 6: Fetch categorical domains
		$effect(() => {
			if (this.#continuousDomainsSet && !this.#categoricalFetchStarted) {
				this.#categoricalFetchStarted = true;

				this.#fetchCategoricalDomains()
					.then(() => {
						this.categoricalDataFetched = true;
						this.#setScalesReady();
						console.log(`✅ Mark ${this.#markId} setup complete`);
					})
					.catch((error) => {
						console.error(`❌ Categorical domain fetch failed for ${this.#markId}:`, error);
					});
			}
		});
	}

	#registerScaleRequirements() {
		const { scaleRequirements } = this.#config;

		if (scaleRequirements?.x) {
			this.#chartContext.registerScaleType(
				'x',
				scaleRequirements.x.type,
				scaleRequirements.x.priority,
				this.#markId
			);
		}

		if (scaleRequirements?.y) {
			this.#chartContext.registerScaleType(
				'y',
				scaleRequirements.y.type,
				scaleRequirements.y.priority,
				this.#markId
			);
		}
	}

	get actualXScaleType() {
		return this.#chartContext.scaleTypes?.x || 'linear';
	}

	get actualYScaleType() {
		return this.#chartContext.scaleTypes?.y || 'linear';
	}

	get markId() {
		return this.#markId;
	}

	scaleCompatibilityError = $derived.by(() => {
		const { supportedScaleTypes, markType } = this.#config;
		if (!this.actualXScaleType || !this.actualYScaleType) return null;

		const incompatibleX = !supportedScaleTypes.x.includes(this.actualXScaleType);
		const incompatibleY = !supportedScaleTypes.y.includes(this.actualYScaleType);

		if (incompatibleX)
			return `${markType} cannot use scale type '${this.actualXScaleType}' for the x-axis.`;
		if (incompatibleY)
			return `${markType} cannot use scale type '${this.actualYScaleType}' for the y-axis.`;

		return null;
	});

	gpuReady = $derived.by(() => {
		if (!this.#chartContext.scalesReady || !this.categoricalDataFetched) return false;

		const xReady =
			this.actualXScaleType === 'band' || this.actualXScaleType === 'point'
				? this.#chartContext.xScaleState?.isReadyForGPU
				: this.#chartContext.xScaleState?.ready;

		const yReady =
			this.actualYScaleType === 'band' || this.actualYScaleType === 'point'
				? this.#chartContext.yScaleState?.isReadyForGPU
				: this.#chartContext.yScaleState?.ready;

		return xReady && yReady;
	});

	// Processed data with JS transforms applied
	// processedData = $derived.by(() => {
	// 	if (!this.client?.arrowTable) return null;

	// 	// Convert Arrow to objects
	// 	const data = this.#arrowToObjects(this.client.arrowTable);

	// 	// Apply JS transforms if any
	// 	if (this.#transformCompiler.hasJSTransforms()) {
	// 		return this.#transformCompiler.applyToData(
	// 			data,
	// 			{
	// 				x: this.#getFieldName('x'),
	// 				y: this.#getFieldName('y'),
	// 				fill: this.#getFieldName('fill')
	// 			},
	// 			{
	// 				x: this.#chartContext.xScale,
	// 				y: this.#chartContext.yScale
	// 			}
	// 		);
	// 	}

	// 	return data;
	// });
	data = $derived.by(() => {
		if (!this.client?.arrowTable) return null;

		// Fast path: No JS transforms - return Arrow accessor (zero-copy)
		if (!this.#transformCompiler.hasJSTransforms()) {
      console.log('📊 Using ArrowDataAccessor (fast path)');
			return new ArrowDataAccessor(this.client.arrowTable);
		}

		// Transform path: Arrow → Objects → Transform → Object accessor
    console.log('📊 Using ObjectDataAccessor (JS transforms)');
		const objects = this.#arrowToObjects(this.client.arrowTable);
		const transformed = this.#transformCompiler.applyToData(
			objects,
			{
				x: this.#getFieldName('x'),
				y: this.#getFieldName('y'),
				fill: this.#getFieldName('fill')
			},
			{
				x: this.#chartContext.xScale,
				y: this.#chartContext.yScale
			}
		);

    console.log('📊 Transformed data:', transformed.length, 'rows');

		return new ObjectDataAccessor(transformed);
	});

	#arrowToObjects(arrowTable) {
		const rows = [];
		const numRows = arrowTable.numRows;

		for (let i = 0; i < numRows; i++) {
			const row = {};
			for (const field of arrowTable.schema.fields) {
				const column = arrowTable.getChild(field.name);
				row[field.name] = column.get(i);
			}
			rows.push(row);
		}

		return rows;
	}

	#getFieldName(channel) {
		const value = this.#config.select[channel];
		if (typeof value === 'string') return value;
		if (value?.field) return value.field; // AutoBinNode
		return channel; // fallback
	}

	getSelectConfig() {
		// Return select with AutoBinNodes unresolved
		// They'll be resolved in buildQuery()
		return this.#config.select;
	}

	buildQuery(sourceTable, config, filter) {
		console.log('🔨 buildQuery called with filter:', filter);
		console.log('🔨 buildQuery config:', config);
		let select = config.select;

		// NEW: Resolve auto bins if we have field info
		if (this.#autoBinNodes.size > 0 && this.client?.fieldInfo) {
			select = this.#resolveAutoBins(config.select);
		}

		const q = Query.from(sourceTable);
		const selectDef = {};
		const nonAggregateGroupBy = [];
		let hasAggregates = false;

		// Build select clause
		for (const alias in select) {
			const expr = select[alias];
			if (expr == null) continue;

			const exprNode = isNode(expr) ? expr : sqlColumn(String(expr));
			selectDef[alias] = exprNode;

			if (isAggregateExpression(exprNode)) {
				hasAggregates = true;
			} else {
				nonAggregateGroupBy.push(exprNode);
			}
		}
		q.select(selectDef);

		// Add GROUP BY if needed
		if (hasAggregates && nonAggregateGroupBy.length > 0) {
			q.groupby(nonAggregateGroupBy);
		}

		// NEW: Apply SQL transforms
		let queryWithTransforms = q;
		if (this.#transformCompiler.hasSQLTransforms()) {
			console.log('🔨 Applying SQL transforms...');
			console.log('🔨 Query BEFORE transforms:', q.toString());
			queryWithTransforms = this.#transformCompiler.applyToQuery(q);

			console.log('🔨 Query AFTER transforms:', queryWithTransforms.toString());

			// Validate query is still flat
			this.#transformCompiler.validateQuery(queryWithTransforms);
		}

		// Add filters
		const allFilters = [...filter];
		if (config._filterNulls && Array.isArray(config._filterNulls)) {
			allFilters.push(...config._filterNulls.map((col) => isNotNull(col)));
		}
		if (allFilters.length > 0) {
			queryWithTransforms = queryWithTransforms.where(and(allFilters));
		}

		return queryWithTransforms;
	}

	// NEW: Resolve AutoBinNodes to concrete SQL
	#resolveAutoBins(select) {
		const resolved = {};

		for (const [channel, value] of Object.entries(select)) {
			if (value?.isAutoBinNode) {
				const scaleType =
					channel === 'x' ? this.actualXScaleType : channel === 'y' ? this.actualYScaleType : null;

				resolved[channel] = value.resolve(this.client.fieldInfo, scaleType);
			} else {
				resolved[channel] = value;
			}
		}

		return resolved;
	}

	#createClient(fieldRequests) {
		if (this.client) this.client.destroy();

		this.client = new DataClient(
			this.#config.table,
			this.#config.selection,
			{
				select: this.getSelectConfig(),
				queryBuilder: (table, config, filter) => this.buildQuery(table, config, filter),
				dataFormat: 'arrow',
				name: this.#markId,
				...this.#config.clientOptions
			},
			fieldRequests
		);
		this.#coordinator.connect(this.client);
	}

	#setupScaleMappings() {
		this.#scaleMap = {
			x: this.#chartContext.xScaleState,
			y: this.#chartContext.yScaleState
		};

		console.log(`📊 ${this.#markId} Scale mappings setup:`, {
			x: this.actualXScaleType,
			y: this.actualYScaleType
		});
	}

	#buildFieldInfoRequests() {
		const { select, table } = this.#config;
		const requests = [];
		const processedFields = new Set();

		for (const alias in select) {
			const fieldValue = select[alias];
			if (fieldValue == null) continue;

			// NEW: Handle AutoBinNodes
			if (fieldValue.isAutoBinNode) {
				const stats = fieldValue.stats;
				if (!processedFields.has(stats.column)) {
					requests.push({ table, column: stats.column, stats: stats.stats });
					processedFields.add(stats.column);
				}
				continue;
			}

			// Handle regular fields
			if (processedFields.has(fieldValue.toString())) continue;

			const exprNode = isNode(fieldValue) ? fieldValue : sqlColumn(String(fieldValue));
			if (isAggregateExpression(exprNode)) continue;

			const scaleType =
				alias === 'x' ? this.actualXScaleType : alias === 'y' ? this.actualYScaleType : null;

			if (scaleType === 'linear' || scaleType === 'time' || scaleType === 'log') {
				requests.push({ table, column: exprNode, stats: ['min', 'max'] });
				processedFields.add(fieldValue.toString());
			}
		}

		return requests;
	}

	#setInitialContinuousDomains(fieldInfo) {
		if (!fieldInfo) return;

		for (const alias in this.#scaleMap) {
			const scaleState = this.#scaleMap[alias];
			if (!scaleState) continue;

			const scaleType = alias === 'x' ? this.actualXScaleType : this.actualYScaleType;

			if (scaleType === 'linear' || scaleType === 'time' || scaleType === 'log') {
				const fieldValue = this.#config.select[alias];

				// Skip AutoBinNodes - they handle their own stats
				if (fieldValue?.isAutoBinNode) continue;

				if (fieldValue == null) continue;

				const infoKey = String(fieldValue).replace(/^["']|["']$/g, '');
				const info = fieldInfo[infoKey];

				if (info && info.min != null && info.max != null) {
					scaleState.addMark([info.min, info.max], this.#markId);
				}
			}
		}
	}

	async #fetchCategoricalDomains() {
		const { table, selection, sort } = this.#config;
		if (!this.#coordinator || !table) return;

		const fetches = [];

		const setupFetch = (axis, field) => {
			if (!field) return;
			const scaleState = this.#chartContext[`${axis}ScaleState`];
			let q = Query.from(table).select({ [axis]: sqlColumn(String(field)) });

			const sortConfig = sort;
			if (sortConfig && sortConfig.by) {
				const isSortingByOtherAxis = sortConfig.by === (axis === 'x' ? 'y' : 'x');
				const otherAxisField = this.#config.select[sortConfig.by];
				if (isSortingByOtherAxis && isAggregateExpression(otherAxisField)) {
					q = q.groupby(field).select({ [sortConfig.by]: otherAxisField });
				}
				q.orderby({ [sortConfig.by]: sortConfig.direction === 'desc' ? 'DESC' : 'ASC' });
			} else {
				q.distinct();
			}

			fetches.push(
				this.#coordinator.query(q).then((result) => {
					const categories = Array.from(result).map((row) => row[axis]);
					if (categories.length > 0) {
						scaleState.addMark(categories, this.#markId);
					}
				})
			);
		};

		if (this.actualXScaleType === 'band' || this.actualXScaleType === 'point') {
			setupFetch('x', this.#config.select.x);
		}
		if (this.actualYScaleType === 'band' || this.actualYScaleType === 'point') {
			setupFetch('y', this.#config.select.y);
		}

		if (fetches.length > 0) await Promise.all(fetches);
	}

	#setScalesReady() {
		Object.values(this.#scaleMap).forEach((scale) => scale?.setReady?.());
	}

	destroy() {
		console.log(`💥 BaseMarkSetup destroying for ${this.#markId}`);

		this.#chartContext.unregisterScaleType('x', this.#markId);
		this.#chartContext.unregisterScaleType('y', this.#markId);

		Object.values(this.#scaleMap).forEach((scale) => scale?.removeMark?.(this.#markId));

		if (this.client) {
			this.client.destroy();
			this.client = null;
		}
	}
}
