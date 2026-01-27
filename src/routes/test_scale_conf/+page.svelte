<script>
	import { resolveScaleConfiguration, SCALE_PRIORITIES } from '$lib/scales';
	import { ChartLayout } from '$lib/layout/ChartLayout.svelte.js';
	import { ChartScales } from '$lib/scales/ChartScales.svelte.js';

	// Create test instances
	const testLayout = new ChartLayout({ height: 300 });
	testLayout.width = 400; // Set width manually for testing

	const testScales = new ChartScales({
		xLabel: 'category',
		yLabel: 'value',
		layout: testLayout
	});

	// Expose for testing
	if (typeof window !== 'undefined') {
		window.testScaleConfig = {
			resolveScaleConfiguration,
			SCALE_PRIORITIES,
			// NEW: Direct access to ChartScales instance
			testScales,
			// Helper function for easier testing
			registerTestScale: (dimension, type, priority, markId, config) => {
				testScales.registerScaleType(dimension, type, priority, markId, config);
			},
			// Get current state
			getScaleState: () => ({
				requirements: testScales.scaleRequirements,
				configurations: testScales.scaleConfigurations,
				types: testScales.scaleTypes
			})
		};
	}

	// Add to your main component
	if (typeof window !== 'undefined') {
		window.testPaddingFlow = {
			// Test the complete configuration flow
			testCompleteFlow: () => {
				console.log('🧪 Testing complete padding configuration flow...');

				// This simulates what happens when you use:
				// <BarMarkX y="category" x="sales" padding={0.3} />
				const barConfig = {
					markType: 'barx',
					scaleRequirements: {
						y: {
							type: 'band',
							priority: 3,
							config: { padding: 0.3, align: 0.2 }
						}
					}
				};

				// Simulate the registration (what BaseMarkSetup does)
				window.testScaleConfig.registerTestScale('y', 'band', 3, 'test-bar', {
					padding: 0.3,
					align: 0.2
				});

				// Force resolution and check results
				const state = window.testScaleConfig.getScaleState();
				console.log('✅ Final resolved configuration:', state.configurations.y);

				return state.configurations.y;
			}
		};
	}
</script>
