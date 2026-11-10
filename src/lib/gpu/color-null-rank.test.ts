import { describe, it, expect } from 'vitest';
import { COLOR_SCALE_FUNCTIONS, NULL_COLOR_RANK } from './ColorScaleShaderLib';

/**
 * An ordinal colour scale's rank table holds a palette rank per id, -1 for a
 * category outside the scale's domain (transparent), and NULL_COLOR_RANK for
 * one drawn in the null colour (the NULL category, an Other bucket). The shader
 * must test for the null-colour rank before it falls through to transparent:
 * the CPU rank alone does not show what is drawn.
 */
describe('samplePalette and the null-colour rank', () => {
	const body =
		/fn samplePalette\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(COLOR_SCALE_FUNCTIONS)?.[1] ?? '';

	it('takes the null colour, and returns it for a rank below -1', () => {
		expect(COLOR_SCALE_FUNCTIONS).toMatch(/fn samplePalette\([^)]*nullColor: vec4<f32>\)/);
		const nullCheck = body.indexOf('return nullColor;');
		const transparent = body.indexOf('return vec4<f32>(0.0, 0.0, 0.0, 0.0);');
		expect(nullCheck).toBeGreaterThan(0);
		expect(nullCheck).toBeLessThan(transparent);
		// The threshold separates -1 from NULL_COLOR_RANK.
		expect(NULL_COLOR_RANK).toBeLessThan(-1.5);
		expect(body).toContain('slot < -1.5');
	});
});
