import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
	root: './src/streamlit',
	plugins: [
		svelte({
			compilerOptions: { css: 'injected', dev: false }
		})
	],
	define: {
		'process.env.NODE_ENV': '"production"'
	},
	resolve: {
		alias: {
			$lib: path.resolve('./src/lib')
		}
	},
	base: './',
	build: {
		outDir: path.resolve('./python/diveplot/streamlit_frontend'),
		emptyOutDir: true,
		rollupOptions: {
			output: {
				inlineDynamicImports: true
			}
		}
	}
});
