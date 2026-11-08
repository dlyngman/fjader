import { describe, it, expect } from 'vitest';
import { outlineColor } from './area-outline';

const fill = { data: new Float32Array([0, 1, 2]), colorMode: 1, colorScaleIndex: 3 };

describe('outlineColor', () => {
	it('draws a constant stroke but reads the fill’s activity, from the fill’s values', () => {
		expect(outlineColor('#333', fill)).toEqual({
			colorValueData: fill.data,
			colorMode: 0,
			colorScaleIndex: 0,
			activityColorMode: 1,
			activityColorScaleIndex: 3
		});
	});

	it('draws and dims in the fill’s colour without a stroke', () => {
		expect(outlineColor(null, fill)).toEqual({
			colorValueData: fill.data,
			colorMode: 1,
			colorScaleIndex: 3,
			activityColorMode: 1,
			activityColorScaleIndex: 3
		});
	});

	it('reads no activity for a constant fill', () => {
		const constantFill = { data: null, colorMode: 0, colorScaleIndex: 0 };
		expect(outlineColor('#333', constantFill).activityColorMode).toBe(0);
	});
});
