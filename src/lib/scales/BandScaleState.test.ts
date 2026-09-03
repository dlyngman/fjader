import { describe, it, expect } from 'vitest';
import { BandScaleState } from './BandScaleState.svelte';
import { buildCaseExpression } from '$lib/sql/case-expression';

describe('BandScaleState.processDataForGPU', () => {
	function scaleWith(domain: string[]): BandScaleState {
		const scale = new BandScaleState('category');
		scale.addMark(domain, 'mark-1');
		scale.updateDomainFromExtents();
		return scale;
	}

	it('maps known categories to their 0-based domain index', () => {
		const scale = scaleWith(['a', 'b', 'c']);
		expect(Array.from(scale.processDataForGPU(['a', 'b', 'c', 'b']))).toEqual([0, 1, 2, 1]);
	});

	it('maps unmapped categories to -1, not to the first category', () => {
		const scale = scaleWith(['a', 'b']);
		const out = scale.processDataForGPU(['a', 'zzz', 'b'], 'mark-1', {
			suppressUnmappedWarning: true
		});
		expect(Array.from(out)).toEqual([0, -1, 1]);
	});

	it('agrees with the SQL CASE expression on both mapped and unmapped values', () => {
		// The SQL path (buildCaseExpression) and the JS path (processDataForGPU)
		// must produce the same index for the same category, including the
		// unmapped sentinel — three call sites depend on that agreement.
		const domain = ['a', 'b'];
		const sql = buildCaseExpression('category', domain);
		expect(sql).toContain('WHEN "category" = \'a\' THEN 0');
		expect(sql).toContain('WHEN "category" = \'b\' THEN 1');
		expect(sql).toContain('ELSE -1');

		const scale = scaleWith(domain);
		const js = scale.processDataForGPU(['a', 'b', 'zzz'], 'mark-1', {
			suppressUnmappedWarning: true
		});
		expect(Array.from(js)).toEqual([0, 1, -1]);
	});

	it('passes a Float32Array through untouched', () => {
		const scale = scaleWith(['a', 'b']);
		const input = new Float32Array([1, 0, -1]);
		expect(scale.processDataForGPU(input)).toBe(input);
	});
});
