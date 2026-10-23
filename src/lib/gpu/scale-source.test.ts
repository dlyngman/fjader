import { describe, it, expect } from 'vitest';
import { scaleTemplateSystem } from './ScaleTemplateSystem';

/**
 * Where a chart's own x and y scale params come from is said in one place.
 *
 * `chartScaleX` / `chartScaleY` are that place. Every scale function holds its
 * math in a `…From(value, scale)` form that takes the params rather than an
 * index, so the source is a change to those two functions and not to any
 * formula. They read the pass's immediates. The global scale table they once
 * read is gone, and nothing may declare or reach for it.
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
				it(`${x} × ${y}, ${concept}: read from the immediates, through chartScaleX/Y`, () => {
					const shader = shaderFor(x, y, concept);
					expect(shader).not.toContain('scaleParams');
					// No position scale taken by index; colour slots are a separate table.
					expect(shader).not.toMatch(/fn scale\w+\(value: f32, scaleIndex: u32\)/);
					expect(shader).not.toMatch(/@group\(2\) @binding\(0\)/);
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
});
