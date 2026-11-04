/**
 * Which of the registry's scales the coordinator tracks: every scale with an
 * id, keyed by it.
 *
 * Tracking is what puts a scale in front of the identity slot packer each
 * frame, so a scale that offers `slots` but has no `id` is silently never
 * packed. Ordinal colour was that case: its rank table and selection activity
 * never reached the GPU, the shader read the dim id as a palette index, and
 * nothing failed visibly. Pulled out of the coordinator so the rule can be
 * tested without a device.
 */
export function trackScalesById<T extends { id?: string }>(
	scales: Iterable<T>,
	into: Map<string, T>
): void {
	into.clear();
	for (const scale of scales) {
		if (scale?.id) into.set(scale.id, scale);
	}
}
