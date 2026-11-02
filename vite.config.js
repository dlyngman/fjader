import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts']
	},
	plugins: [
		sveltekit(),
		{
			name: 'configure-data-caching',
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					// Target your data directory
					if (req.url?.startsWith('/data/')) {
						// Cache for 1 hour (3600 seconds)
						res.setHeader('Cache-Control', 'public, max-age=3600, immutable');
					}
					next();
				});
			}
		}
	]
});
