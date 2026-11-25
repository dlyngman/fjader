import type { DensityContext, DensityHost } from './DensityHost.svelte';

/** Shared interface for all LOD rung classes. */
export interface LODRung {
	readonly name: string;
	readonly kind: 'adaptive' | 'analytical';
	readonly destroyed: boolean;
	readonly active: boolean;
	readonly props: Record<string, unknown>;
	adjustResolution?(deltaY: number): void;
	destroy(): void;
}

/**
 * A mark's own rungs, handed to its lifecycle as a getter: the lifecycle owns
 * the mark's one surface and reads them when the palette or the wheel asks, so
 * a rung created or destroyed later is seen without registering again.
 */
export interface MarkLODParts {
	/** The mark's rungs, in palette order; null for one not built (yet). */
	rungs: (LODRung | null)[];
	densityHost: DensityHost | null;
	/** Shift+scroll over the mark, where its lifecycle has no bins to adjust. */
	adjustResolution?(deltaY: number): void;
}

/**
 * Per-mark LOD surface registered with ChartConfig.
 * Provides shift+scroll routing, rung iteration for palette, and density diagnostics.
 */
export interface MarkLODSurface {
	adjustResolution(deltaY: number): void;
	/** Live rung instances filtered to non-destroyed. Palette should still check rung.destroyed defensively. */
	getRungs(): LODRung[];
	/** Density context for diagnostics display (null if no DensityHost). */
	getDensityCtx(): DensityContext | null;
	/** DensityHost for non-reactive diagnostic polling (queryLatencyMs, frameCallbackCount, etc.). */
	getDensityHost(): DensityHost | null;
}
