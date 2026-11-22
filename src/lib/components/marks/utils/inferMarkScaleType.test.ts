import { describe, it, expect, beforeAll } from 'vitest';
import { tableSchemaService } from '$lib/data/TableSchemaService.svelte';
import { inferMarkScaleType } from './inferMarkScaleType';

describe('inferMarkScaleType', () => {
	beforeAll(() => {
		tableSchemaService.setQueryEngine({
			describe: async (table: string) => {
				if (table === 'broken') throw new Error('no such table');
				return [
					{ name: 'started', type: 'TIMESTAMP' },
					{ name: 'n', type: 'DOUBLE' }
				];
			}
		} as never);
	});

	it('waits (null) only while the schema loads', async () => {
		expect(inferMarkScaleType('started', 'tasks', null)).toBeNull();
		await tableSchemaService.ensure('tasks');
		expect(inferMarkScaleType('started', 'tasks', null)).toBe('time');
		expect(inferMarkScaleType('n', 'tasks', null)).toBe('linear');
	});

	it('a column the loaded schema lacks is linear, so the query says what is wrong', async () => {
		await tableSchemaService.ensure('tasks');
		expect(inferMarkScaleType('Started', 'tasks', null)).toBe('linear');
		expect(inferMarkScaleType('derived_by_transform', 'tasks', null)).toBe('linear');
	});

	it('a failed schema fetch does not hold the mark back', async () => {
		await tableSchemaService.ensure('broken');
		expect(inferMarkScaleType('started', 'broken', null)).toBe('linear');
	});

	it('a constant has no column: linear', () => {
		expect(inferMarkScaleType(1, 'tasks', null)).toBe('linear');
	});
});
