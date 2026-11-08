import { describe, it, expect } from 'vitest';
import { activityReads, markActivityWGSL, rendererForMark } from './activity-reads';

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
});
