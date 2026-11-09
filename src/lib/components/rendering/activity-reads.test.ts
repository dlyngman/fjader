import { describe, it, expect } from 'vitest';
import {
	activityReads,
	colorActivityWGSL,
	markActivityWGSL,
	readsFor,
	ruleHasExtent,
	readsForResponse,
	groupIndexForResponse,
	NO_GROUP,
	rendererForMark
} from './activity-reads';

const ARGS = { color: 'cm, ci, cv', x: 'x', y: 'y', group: 'g' };

describe('activity reads', () => {
	it('reads colour and both band axes for dots, rects and text', () => {
		for (const r of ['dots', 'rects', 'text'] as const) {
			expect(activityReads(r)).toEqual({ color: true, x: true, y: true });
		}
	});

	it('reads only colour for lines, areas and parallel coordinates', () => {
		for (const r of ['lines', 'areas', 'parallel'] as const) {
			expect(activityReads(r)).toEqual({ color: true, x: false, y: false });
		}
	});

	it('reads a rule’s cross axis only when the rule has an extent', () => {
		expect(activityReads('rulex')).toEqual({ color: true, x: true, y: false });
		expect(activityReads('rulex', true)).toEqual({ color: true, x: true, y: true });
		expect(activityReads('ruley')).toEqual({ color: true, x: false, y: true });
		expect(activityReads('ruley', true)).toEqual({ color: true, x: true, y: true });
	});

	it('maps every mark type to the renderer that draws it', () => {
		expect(
			[
				'dot',
				'bary',
				'barx',
				'rect',
				'rectx',
				'recty',
				'rulex',
				'ruley',
				'line',
				'areax',
				'areay',
				'parallel',
				'text'
			].map(rendererForMark)
		).toEqual([
			'dots',
			'rects',
			'rects',
			'rects',
			'rects',
			'rects',
			'rulex',
			'ruley',
			'lines',
			'areas',
			'areas',
			'parallel',
			'text'
		]);
		expect(rendererForMark('unknown')).toBeNull();
	});

	it('passes 1.0 for every activity the renderer does not read', () => {
		expect(markActivityWGSL(activityReads('rulex'), ARGS)).toBe(
			'markActivity(markColorActivity(cm, ci, cv, g), bandActivityX(x, g), 1.0)'
		);
		expect(markActivityWGSL(activityReads('ruley'), ARGS)).toBe(
			'markActivity(markColorActivity(cm, ci, cv, g), 1.0, bandActivityY(y, g))'
		);
		expect(markActivityWGSL(activityReads('dots'), ARGS)).toBe(
			'markActivity(markColorActivity(cm, ci, cv, g), bandActivityX(x, g), bandActivityY(y, g))'
		);
	});

	it('counts a constant rule end as an extent, as the renderer does', () => {
		// y1={0}, or the y shorthand's 0: a constant, absent from the select.
		expect(ruleHasExtent(0, 'value')).toBe(true);
		expect(ruleHasExtent(undefined, 'value')).toBe(false);
		const keys = { color: null, x: 'cat', y: 'region' };
		expect(readsFor(activityReads('rulex', ruleHasExtent(0, 'value')), keys)).toEqual([
			'cat',
			'region'
		]);
		expect(readsFor(activityReads('rulex', false), keys)).toEqual(['cat']);
	});

	it('reads only fields with an identity key, sorted and once each', () => {
		expect(readsFor(activityReads('dots'), { color: 'b', x: 'a', y: 'b' })).toEqual(['a', 'b']);
		// A scale without identity has no activity block: a selection on it filters.
		expect(readsFor(activityReads('dots'), { color: null, x: null, y: null })).toEqual([]);
		expect(readsFor(activityReads('lines'), { color: 'c', x: 'a', y: 'b' })).toEqual(['c']);
	});

	it('builds a colour-only renderer’s activity, and refuses one that reads a band axis', () => {
		const args = { color: 'cm, ci, cv', group: 'g' };
		expect(colorActivityWGSL(activityReads('lines'), args)).toBe(
			'markColorActivity(cm, ci, cv, g)'
		);
		expect(() => colorActivityWGSL(activityReads('dots'), args)).toThrow();
	});

	it("'filter' reads nothing and has no group; 'auto' keeps both", () => {
		expect(readsForResponse('filter', ['carrier'])).toEqual([]);
		expect(readsForResponse('auto', ['carrier'])).toEqual(['carrier']);
		expect(readsForResponse(undefined, ['carrier'])).toEqual(['carrier']);
		expect(groupIndexForResponse('filter', 2)).toBe(NO_GROUP);
		expect(groupIndexForResponse(undefined, 2)).toBe(2);
	});

	it('identityActivity returns fully active for NO_GROUP before reading anything', async () => {
		const { readFileSync } = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const wgsl = readFileSync(
			fileURLToPath(new URL('../../gpu/ScaleTemplateSystem.ts', import.meta.url)),
			'utf8'
		);
		const body = /fn identityActivity\([^)]*\)[^{]*\{([\s\S]*?)\n {4}\}/.exec(wgsl)?.[1] ?? '';
		const check = body.indexOf('if (group == ${NO_GROUP}u)');
		const firstRead = body.indexOf('identitySlots[');
		expect(check).toBeGreaterThanOrEqual(0);
		expect(check).toBeLessThan(firstRead);
	});
});
