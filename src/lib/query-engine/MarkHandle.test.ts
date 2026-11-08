import { describe, it, expect } from 'vitest';
import type { Table } from '@uwdata/flechette';
import { MarkHandle } from './MarkHandle.svelte';

const table = () => ({ numRows: 0 }) as unknown as Table;

describe('MarkHandle._setResult', () => {
	it('bumps dataVersion for a new table', () => {
		const handle = new MarkHandle();
		const a = table();
		handle._setResult(a);
		expect(handle.arrowTable).toBe(a);
		expect(handle.dataVersion).toBe(1);
		handle._setResult(table());
		expect(handle.dataVersion).toBe(2);
	});

	it('bumps nothing for the table it already holds, as a cache hit returns', () => {
		const handle = new MarkHandle();
		const a = table();
		handle._setResult(a);
		handle._setResult(a);
		expect(handle.dataVersion).toBe(1);
	});

	it('clears an error even when the table is unchanged', () => {
		const handle = new MarkHandle();
		const a = table();
		handle._setResult(a);
		handle._setError(new Error('boom'));
		handle._setResult(a);
		expect(handle.error).toBeNull();
		expect(handle.dataVersion).toBe(1);
	});
});
