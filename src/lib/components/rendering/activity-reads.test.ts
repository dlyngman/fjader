import { describe, it, expect } from 'vitest';
import {
	activityReads,
	connectedActivityWGSL,
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
			expect(activityReads(r)).toEqual({ color: true, x: true, y: true, series: false });
		}
	});

	it('reads colour and series for lines and areas, colour only for parallel coordinates', () => {
		for (const r of ['lines', 'areas'] as const) {
			expect(activityReads(r)).toEqual({ color: true, x: false, y: false, series: true });
		}
		expect(activityReads('parallel')).toEqual({ color: true, x: false, y: false, series: false });
	});

	it('reads a rule’s cross axis only when the rule has an extent', () => {
		const rule = (x: boolean, y: boolean) => ({ color: true, x, y, series: false });
		expect(activityReads('rulex')).toEqual(rule(true, false));
		expect(activityReads('rulex', true)).toEqual(rule(true, true));
		expect(activityReads('ruley')).toEqual(rule(false, true));
		expect(activityReads('ruley', true)).toEqual(rule(true, true));
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

	it('reads a line’s or area’s own z, once when it is also the colour field', () => {
		const keys = { color: 'industry', x: null, y: null, series: 'region' };
		expect(readsFor(activityReads('lines'), keys)).toEqual(['industry', 'region']);
		expect(readsFor(activityReads('areas'), keys)).toEqual(['industry', 'region']);
		expect(readsFor(activityReads('lines'), { ...keys, series: 'industry' })).toEqual(['industry']);
		// Only connected renderers read a series: a dot handed one ignores it.
		expect(readsFor(activityReads('dots'), keys)).toEqual(['industry']);
		expect(readsFor(activityReads('parallel'), keys)).toEqual(['industry']);
	});

	it('builds a connected renderer’s activity: colour, and the least active with series', () => {
		const args = { color: 'cm, ci, cv', group: 'g' };
		expect(connectedActivityWGSL(activityReads('parallel'), args)).toBe(
			'markColorActivity(cm, ci, cv, g)'
		);
		expect(connectedActivityWGSL(activityReads('lines'), { ...args, series: 'sm, si, sv' })).toBe(
			'min(markColorActivity(cm, ci, cv, g), markColorActivity(sm, si, sv, g))'
		);
	});

	it('refuses a renderer that reads a band axis, or a series without its arguments', () => {
		const args = { color: 'cm, ci, cv', group: 'g' };
		expect(() => connectedActivityWGSL(activityReads('dots'), args)).toThrow();
		expect(() => connectedActivityWGSL(activityReads('lines'), args)).toThrow();
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

describe('an Other row reads no activity on its own field', () => {
	it('drops the band terms, and colour when colour is the band field', async () => {
		const { otherRowActivityWGSL, activityReads } = await import('./activity-reads');
		const wgsl = otherRowActivityWGSL(activityReads('rects'), {
			color: 'c',
			group: 'g',
			skipColor: 'flag'
		});
		expect(wgsl).not.toMatch(/bandActivity/);
		expect(wgsl).toBe('markActivity(select(markColorActivity(c, g), 1.0, flag), 1.0, 1.0)');
	});

	it('Rects draws an Other row in two parts, mixed in the fragment after an unconditional fwidth', async () => {
		const { readFileSync } = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const source = readFileSync(fileURLToPath(new URL('./Rects.svelte', import.meta.url)), 'utf8');
		expect(source).toContain('@group(1) @binding(7) var<storage, read> splitValues');
		// Below the split: as any bar. Above it: the other fields' activity and
		// the field's free slot, so it fades in when the selection is cleared.
		expect(source).toContain('output.alpha = alpha * selectionDim(activity)');
		expect(source).toContain('output.alphaRest = alpha * selectionDim(min(otherActivity, free))');
		expect(source).toContain('bandFreeActivityX(markConstants.groupIndex)');
		const fragment = source.slice(source.indexOf('fn fragmentMain'));
		expect(fragment.indexOf('fwidth(input.along)')).toBeGreaterThan(-1);
		expect(fragment.indexOf('fwidth(input.along)')).toBeLessThan(fragment.indexOf('if ('));
		expect(fragment).toContain('mix(input.alphaRest, input.alpha, below)');
	});
});
