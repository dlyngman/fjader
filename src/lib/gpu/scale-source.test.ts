import { describe, it, expect, afterEach } from 'vitest';
import { scaleTemplateSystem, type ChartScaleSource } from './ScaleTemplateSystem';

/**
 * Where a chart's own x and y scale params come from is said in one place.
 *
 * `chartScaleX` / `chartScaleY` are that place. Every scale function holds its
 * math in a `…From(value, scale)` form that takes the params rather than an
 * index, so the source is a change to those two functions and not to any
 * formula. In production they read the pass's immediates; a read of
 * `scaleParams[frameUniforms.…]` anywhere else is a second source, and one that
 * nothing keeps current any more.
 */

const TYPES = ['linear', 'log', 'symlog', 'time', 'band'];
const TABLE_READ = /scaleParams\[frameUniforms\.[xy]ScaleIndex\]/g;

function shaderFor(
	x: string,
	y: string,
	concept: 'position' | 'extent',
	source: ChartScaleSource = 'immediate'
): string {
	const channels = concept === 'extent' ? ['a', 'b'] : ['a'];
	scaleTemplateSystem.chartScaleSource = source;
	return scaleTemplateSystem._buildShader(
		{ x, y },
		'@vertex fn vertexMain() -> VertexOutput { {{X}} {{Y}} }',
		{
			x: { concept, channels },
			y: { concept, channels },
			placeholders: { x: '{{X}}', y: '{{Y}}' }
		} as never
	).shaderCode;
}

afterEach(() => {
	scaleTemplateSystem.chartScaleSource = 'immediate';
});

describe('the source of a chart scale', () => {
	for (const x of TYPES) {
		for (const y of TYPES) {
			for (const concept of ['position', 'extent'] as const) {
				it(`${x} × ${y}, ${concept}: read from the immediates, through chartScaleX/Y`, () => {
					const shader = shaderFor(x, y, concept);
					expect(shader.match(TABLE_READ)).toBeNull();
					// The directive has to precede every declaration.
					expect(shader.startsWith('requires immediate_address_space;')).toBe(true);
					expect(shader.match(/var<immediate>/g)).toHaveLength(1);
					expect(shader).toMatch(/fn chartScaleX\(\) -> ScaleParam \{\s*return chartScales\.x;/);
					expect(shader).toMatch(/fn chartScaleY\(\) -> ScaleParam \{\s*return chartScales\.y;/);
					expect(shader).toMatch(
						/fn scaleX\(value: f32\) -> f32 \{\s*return \w+XFrom\(value, chartScaleX\(\)\);/
					);
					expect(shader).toMatch(
						/fn scaleY\(value: f32\) -> f32 \{\s*return \w+YFrom\(value, chartScaleY\(\)\);/
					);
				});
			}
		}
	}

	it('keeps the per-index form for a caller with an index of its own', () => {
		// Parallel coordinates computes a scale index per vertex, so the index
		// signature has to survive until it moves to a source of its own.
		const shader = shaderFor('linear', 'linear', 'position');
		expect(shader).toMatch(
			/fn scaleLinearY\(value: f32, scaleIndex: u32\) -> f32 \{\s*return scaleLinearYFrom\(value, scaleParams\[scaleIndex\]\);/
		);
	});
});

describe('the parity sources', () => {
	it('`table` is the old path: one read per axis, at the frame uniform indices', () => {
		const shader = shaderFor('band', 'linear', 'extent', 'table');
		expect(shader.match(TABLE_READ)).toEqual([
			'scaleParams[frameUniforms.xScaleIndex]',
			'scaleParams[frameUniforms.yScaleIndex]'
		]);
	});

	it('`swapped` exchanges the axes, so the control really is a wrong scale', () => {
		const shader = shaderFor('band', 'linear', 'extent', 'swapped');
		expect(shader).toMatch(/fn chartScaleX\(\) -> ScaleParam \{\s*return chartScales\.y;/);
		expect(shader).toMatch(/fn chartScaleY\(\) -> ScaleParam \{\s*return chartScales\.x;/);
	});

	it('is part of the cache key, so one source is never served for another', () => {
		const def = {
			x: { concept: 'position', channels: ['a'] },
			y: { concept: 'position', channels: ['a'] },
			placeholders: { x: '{{X}}', y: '{{Y}}' }
		} as never;
		const code = '@vertex fn vertexMain() -> VertexOutput { {{X}} {{Y}} }';
		scaleTemplateSystem.chartScaleSource = 'immediate';
		const a = scaleTemplateSystem.generateShader({ x: 'linear', y: 'linear' }, code, def, 'probe');
		scaleTemplateSystem.chartScaleSource = 'table';
		const b = scaleTemplateSystem.generateShader({ x: 'linear', y: 'linear' }, code, def, 'probe');
		expect(a.shaderCode).not.toBe(b.shaderCode);
	});
});
