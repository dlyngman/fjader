/**
 * Whether a scale's domain is ready to show: a continuous scale only once a
 * chart drawing it has its marks' first data in (LinearScaleState.entered).
 * Before that its domain is a placeholder, and an axis or grid drawn from it
 * shows [0, 100] for a moment. Scales without the notion (band, point) are
 * always shown.
 */
export function hasEntered(scale: unknown): boolean {
	return (scale as { entered?: boolean } | null)?.entered !== false;
}
