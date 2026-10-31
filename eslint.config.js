import prettier from 'eslint-config-prettier';
import js from '@eslint/js';
import { includeIgnoreFile } from '@eslint/compat';
import svelte from 'eslint-plugin-svelte';
import ts from 'typescript-eslint';
import globals from 'globals';
import { fileURLToPath } from 'node:url';
import svelteConfig from './svelte.config.js';

const gitignorePath = fileURLToPath(new URL('./.gitignore', import.meta.url));

export default ts.config(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
				// WebGPU globals
				GPUVertexFormat: 'readonly',
				GPUVertexBufferLayout: 'readonly',
				GPUVertexStepMode: 'readonly'
			}
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				svelteConfig,
				parser: ts.parser
			}
		},
		rules: {
			// Raw Map/Set/Date are used intentionally for GPU state and
			// performance-critical paths — Svelte reactive wrappers add overhead
			'svelte/prefer-svelte-reactivity': 'off',
			// Svelte $effect() reactive patterns look like unused expressions
			'@typescript-eslint/no-unused-expressions': 'off',
			// const self = this is needed in callbacks within class methods
			'@typescript-eslint/no-this-alias': 'off',
			// writable $derived doesn't cover zero-allocation patterns with pre-allocated buffers
			'svelte/prefer-writable-derived': 'off',
			// Demo/test pages use simple <a href="/path"> without SvelteKit resolve()
			'svelte/no-navigation-without-resolve': 'off',
			// GPU canvas and spec renderer require direct DOM manipulation
			'svelte/no-dom-manipulating': 'off'
		}
	},
	{
		// TypeScript already checks that names exist, including WebGPU's types;
		// typescript-eslint recommends turning no-undef off for typed code.
		files: ['**/*.ts', '**/*.svelte'],
		rules: {
			'no-undef': 'off'
		}
	},
	{
		// Tests reach into internals and build partial fixtures.
		files: ['**/*.test.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off'
		}
	},
	{
		rules: {
			// Allow _prefixed unused vars (intentional placeholders)
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_'
				}
			]
		}
	},
	{
		ignores: [
			'.claude/',
			// Emscripten output of the custom DuckDB-WASM build
			'src/streamlit/custom-duckdb/',
			'python/.venv/',
			'python/fjader/static/',
			'python/fjader/streamlit_frontend/',
			'python/__marimo__/',
			'python/layouts/'
		]
	}
);
