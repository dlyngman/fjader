import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
	plugins: [
		svelte({
			compilerOptions: { css: 'external', dev: false }
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
	build: {
		lib: {
			entry: path.resolve('./src/widget/entry.ts'),
			formats: ['es'],
			fileName: 'widget'
		},
		outDir: path.resolve('./python/diveplot/static'),
		emptyOutDir: true,
		rollupOptions: {
			output: {
				// Single chunk — no code splitting for widget bundle
				inlineDynamicImports: true,
				assetFileNames: 'widget.[ext]'
			}
		}
	}
});
