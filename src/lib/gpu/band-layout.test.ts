import { describe, it, expect } from 'vitest';
import { scaleBand } from 'd3-scale';
import { scaleTemplateSystem } from './ScaleTemplateSystem';
import { BandScaleState } from '$lib/scales/BandScaleState.svelte';
import { FieldIdentity } from '$lib/query-engine/categorical-identity';

/**
 * The band layout arithmetic, and the rule that it lives in one place.
 *
 * It had five homes: `computeBandLayout`, `getBandwidthX`, `getBandwidthY`,
 * `BandScaleState.#step`, and d3's own `scaleBand`. Three of those were the same
 * WGSL expression written out three times, which is how `align` came to reach
 * one implementation and not the others — a declared prop that moved every SVG
 * consumer off the bars and moved nothing else.
 *
 * Two homes are left and neither can be removed: one runs on the GPU for every
 * vertex, one runs on the CPU for axis ticks, tooltips and hit-testing. What can
 * be held is that each is written once, and that they agree.
 */

function bandShader(): string {
	const out = scaleTemplateSystem.generateShader(
		{ x: 'band', y: 'band' },
		'@vertex fn vertexMain() -> VertexOutput { {{X_AXIS_LOGIC}} {{Y_AXIS_LOGIC}} }',
		{
			x: { concept: 'position', channels: ['x'] },
			y: { concept: 'position', channels: ['y'] },
			placeholders: { x: '{{X_AXIS_LOGIC}}', y: '{{Y_AXIS_LOGIC}}' }
		} as never
	);
	return typeof out === 'string' ? out : JSON.stringify(out);
}

describe('the band step expression in WGSL', () => {
	it('appears exactly once, however many functions need it', () => {
		// The literal expression, not a paraphrase: re-inlining it anywhere — in a
		// new helper, or by "simplifying" a delegation away — is what this fails on.
		const step = /rangeSize \/ max\(1\.0, n - paddingInner \+ paddingOuter \* 2\.0\)/g;
		expect(bandShader().match(step)?.length ?? 0).toBe(1);
	});

	it('is what the bandwidth helpers read, rather than their own copy', () => {
		const shader = bandShader();
		expect(shader).toContain('fn getBandwidthX()');
		expect(shader).toContain('fn getBandwidthY()');
		// Both go through the one layout function. Bandwidth does not depend on
		// the slot, so each is that layout at slot 0.
		expect(shader.match(/computeBandLayout\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
	});
});

describe('the CPU twin of that expression', () => {
	function scaleOf(categories: string[]) {
		const scale = new BandScaleState('species');
		scale.setIdentity(new FieldIdentity(categories));
		scale.addMark(categories, 'mark-1');
		scale.updateDomainFromExtents();
		return scale;
	}

	it('agrees with d3 on bandwidth and step, at the padding the registry sets', () => {
		// d3 is the third home and the one that cannot be deleted: it positions
		// every SVG consumer. The GPU expression is the same arithmetic, so a
		// divergence here is bars and labels drifting apart.
		const categories = ['Adelie', 'Chinstrap', 'Gentoo', 'Emperor'];
		const scale = scaleOf(categories);
		const d3 = scaleBand<string>().domain(categories).range([0, 640]).padding(0.1);

		expect(scale.bandwidth(640)).toBeCloseTo(d3.bandwidth(), 6);
		expect(scale.stepWidth(640)).toBeCloseTo(d3.step(), 6);
	});

	it('places a slot centre where d3 places the middle of its band', () => {
		const categories = ['Adelie', 'Chinstrap', 'Gentoo'];
		const scale = scaleOf(categories);
		const d3 = scaleBand<string>().domain(categories).range([0, 300]).padding(0.1);

		for (let slot = 0; slot < categories.length; slot++) {
			const centre = (d3(categories[slot]) ?? NaN) + d3.bandwidth() / 2;
			expect(scale.slotCenter(slot, 300)).toBeCloseTo(centre, 6);
		}
	});

	it('holds for a fractional slot, which is what a transition asks for', () => {
		// Nothing in d3 answers this — a band is at an integer index there — so
		// the claim is that the layout is LINEAR in the slot, which is the
		// property index interpolation rests on.
		const scale = scaleOf(['Adelie', 'Chinstrap', 'Gentoo']);
		const half = (scale.slotCenter(1, 300) + scale.slotCenter(2, 300)) / 2;
		expect(scale.slotCenter(1.5, 300)).toBeCloseTo(half, 6);
	});
});
