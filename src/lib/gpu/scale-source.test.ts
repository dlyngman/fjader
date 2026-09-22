import { describe, it, expect } from 'vitest';
import { scaleTemplateSystem } from './ScaleTemplateSystem';

/**
 * Where a chart's own x and y scale params come from is said in one place.
 *
 * `chartScaleX` / `chartScaleY` are that place. Every scale function holds its
 * math in a `…From(value, scale)` form that takes the params rather than an
 * index, so moving the source — the global table today, an immediate next —
 * is a change to those two functions and not to any formula. A new read of
 * `scaleParams[frameUniforms.…]` anywhere else is a second source, and it is
 * what would keep reading the old one after the move.
 */

const TYPES = ['linear', 'log', 'symlog', 'time', 'band'];

function shaderFor(x: string, y: string, concept: 'position' | 'extent'): string {
	const channels = concept === 'extent' ? ['a', 'b'] : ['a'];
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

describe('the source of a chart scale', () => {
	for (const x of TYPES) {
		for (const y of TYPES) {
			for (const concept of ['position', 'extent'] as const) {
				it(`${x} × ${y}, ${concept}: read once per axis, through chartScaleX/Y`, () => {
					const shader = shaderFor(x, y, concept);
					const reads = shader.match(/scaleParams\[frameUniforms\.[xy]ScaleIndex\]/g) ?? [];
					expect(reads).toEqual([
						'scaleParams[frameUniforms.xScaleIndex]',
						'scaleParams[frameUniforms.yScaleIndex]'
					]);
					expect(shader).toContain('fn chartScaleX() -> ScaleParam');
					expect(shader).toContain('fn chartScaleY() -> ScaleParam');
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
