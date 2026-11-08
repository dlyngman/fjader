import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PARALLEL_MAX_AXES, UNIFORM_BYTES, UNIFORM_STAND_IN_BYTES } from './uniform-sizes';

/**
 * Each uniform struct's size, worked out from the WGSL in the renderer's
 * source with the uniform address space's layout rules, against the constant
 * the renderer allocates from. A struct that grows without its constant fails
 * here instead of failing WebGPU validation in the browser.
 */

const source = (file: string) =>
	readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

/** [size, align] of a WGSL type, as the uniform address space lays it out. */
function layoutOf(type: string): [number, number] {
	type = type.trim();
	if (type === 'f32' || type === 'u32' || type === 'i32') return [4, 4];
	if (/^vec2<\w+>$/.test(type)) return [8, 8];
	if (/^vec3<\w+>$/.test(type)) return [12, 16];
	if (/^vec4<\w+>$/.test(type)) return [16, 16];
	const array = /^array<(.+),\s*(\d+)>$/.exec(type);
	if (array) {
		const [size, align] = layoutOf(array[1]);
		// Uniform arrays: every element on a 16-byte stride.
		const stride = Math.ceil(Math.max(size, align, 16) / 16) * 16;
		return [stride * Number(array[2]), 16];
	}
	throw new Error(`no layout for WGSL type ${type}`);
}

const roundUp = (n: number, k: number) => Math.ceil(n / k) * k;

/** The size of struct `name` declared in `wgsl`. */
function structSize(wgsl: string, name: string): number {
	const body = new RegExp(`struct ${name}\\s*\\{([^}]*)\\}`).exec(wgsl)?.[1];
	if (!body) throw new Error(`struct ${name} not found`);
	let offset = 0;
	let structAlign = 4;
	for (const raw of body.split('\n')) {
		const line = raw.replace(/\/\/.*$/, '').trim();
		if (!line) continue;
		const field = /^\w+\s*:\s*(.+?),?$/.exec(line);
		if (!field) throw new Error(`cannot parse field "${line}" of ${name}`);
		const [size, align] = layoutOf(field[1]);
		offset = roundUp(offset, align) + size;
		structAlign = Math.max(structAlign, align);
	}
	return roundUp(offset, structAlign);
}

describe('uniform struct sizes', () => {
	const cases: Array<[keyof typeof UNIFORM_BYTES, string, string]> = [
		['dotsMarkConstants', './Dots.svelte', 'MarkConstants'],
		['rectsMarkConstants', './Rects.svelte', 'MarkConstants'],
		['ruleXMarkConstants', './RuleX.svelte', 'MarkConstants'],
		['ruleYMarkConstants', './RuleY.svelte', 'MarkConstants'],
		['linesMarkConstants', './Lines.svelte', 'MarkConstants'],
		['areasMarkConstants', './Areas.svelte', 'MarkConstants'],
		['gridLineRuleConstants', './GridLine.svelte', 'RuleConstants'],
		['parallelConfig', './ParallelLines.svelte', 'ParallelConfig']
	];

	it.each(cases)('%s matches its WGSL struct', (key, file, struct) => {
		expect(structSize(source(file), struct)).toBe(UNIFORM_BYTES[key]);
	});

	it('parallelAxisScales matches its WGSL array of ScaleParam', () => {
		const scaleParam = structSize(source('../../gpu/ScaleTemplateSystem.ts'), 'ScaleParam');
		const [size] = layoutOf(`array<vec4<f32>, ${PARALLEL_MAX_AXES}>`);
		expect(scaleParam).toBe(16);
		expect(size).toBe(UNIFORM_BYTES.parallelAxisScales);
	});

	it('the stand-in fits every struct', () => {
		for (const bytes of Object.values(UNIFORM_BYTES)) {
			expect(UNIFORM_STAND_IN_BYTES).toBeGreaterThanOrEqual(bytes);
		}
	});

	it('every renderer allocates its uniform from these sizes, not a literal', () => {
		for (const file of [
			'./Dots.svelte',
			'./Rects.svelte',
			'./RuleX.svelte',
			'./RuleY.svelte',
			'./Lines.svelte',
			'./Areas.svelte',
			'./GridLine.svelte'
		]) {
			expect(source(file)).toMatch(/new ArrayBuffer\(UNIFORM_BYTES\.\w+\)/);
			expect(source(file)).not.toMatch(/new ArrayBuffer\(\d+\)/);
		}
		expect(source('./BaseGPURenderer.svelte.ts')).toMatch(/size: UNIFORM_STAND_IN_BYTES/);
	});
});
