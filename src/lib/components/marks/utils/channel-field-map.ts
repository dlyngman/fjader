/**
 * Build a mapping from channel names (SQL aliases) to human-readable field names.
 *
 * For string fields (column references): channel → field name (e.g., "fill" → "species")
 * For expression nodes (aggregate, window, bin): channel → channel name (e.g., "y" → "y")
 * Null/undefined values are excluded.
 *
 * This is the single source of truth for channel→field resolution, used by
 * the tooltip system and any future display consumer.
 */
export function buildChannelFieldMap(select: Record<string, unknown>): Record<string, string> {
	const map: Record<string, string> = {};
	for (const [channel, value] of Object.entries(select)) {
		if (value == null) continue;
		map[channel] = typeof value === 'string' ? value : channel;
	}
	return map;
}
