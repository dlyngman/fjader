// =============================================================================
// calendar-offset.ts — Temporal-based calendar offset utilities
// =============================================================================

/**
 * Parsed offset descriptor. Most offsets are a simple Temporal.Duration.
 * ISO-week-aligned year offsets (e.g. "-1yw") need special handling — they
 * find the same ISO week + day-of-week in a different year.
 */
export type ParsedOffset =
	| { kind: 'duration'; duration: Temporal.Duration }
	| { kind: 'isoWeekYear'; years: number };

/**
 * Parse an offset string into a ParsedOffset.
 *
 * Supported formats:
 *   "-1y"   → calendar year offset
 *   "-1mo"  → calendar month offset
 *   "-52w"  → exact week offset (preserves day-of-week)
 *   "7d"    → day offset
 *   "-1yw"  → ISO-week-aligned year: same ISO week + day-of-week, N years back
 */
export function parseOffset(s: string): ParsedOffset {
	// ISO-week-aligned year: e.g. "-1yw", "2yw"
	const isoMatch = s.match(/^(-?\d+)yw$/);
	if (isoMatch) {
		return { kind: 'isoWeekYear', years: parseInt(isoMatch[1], 10) };
	}

	const match = s.match(/^(-?\d+)(y|mo|w|d)$/);
	if (!match) throw new Error(`Invalid offset string: "${s}"`);

	const value = parseInt(match[1], 10);
	const unit = match[2];

	switch (unit) {
		case 'y':
			return { kind: 'duration', duration: Temporal.Duration.from({ years: value }) };
		case 'mo':
			return { kind: 'duration', duration: Temporal.Duration.from({ months: value }) };
		case 'w':
			return { kind: 'duration', duration: Temporal.Duration.from({ weeks: value }) };
		case 'd':
			return { kind: 'duration', duration: Temporal.Duration.from({ days: value }) };
		default:
			throw new Error(`Unknown offset unit: "${unit}"`);
	}
}

/**
 * Apply a parsed offset to a Date, returning a new Date.
 */
export function applyOffset(date: Date, offset: ParsedOffset): Date {
	const instant = Temporal.Instant.fromEpochMilliseconds(date.getTime());
	const zdt = instant.toZonedDateTimeISO('UTC');
	const pdt = zdt.toPlainDateTime();

	if (offset.kind === 'duration') {
		const shifted = pdt.add(offset.duration);
		return new Date(shifted.toZonedDateTime('UTC').toInstant().epochMilliseconds);
	}

	// ISO-week-aligned year offset:
	// Find the same ISO week number + day-of-week in the target year.
	const sourceDate = pdt.toPlainDate();
	const sourceWeek = sourceDate.weekOfYear!;
	const sourceDow = sourceDate.dayOfWeek; // 1=Mon .. 7=Sun
	const sourceTime = pdt.toPlainTime();
	const targetIsoYear = sourceDate.yearOfWeek! + offset.years;

	const targetDate = isoWeekDate(targetIsoYear, sourceWeek, sourceDow);
	const targetDt = targetDate.toPlainDateTime(sourceTime);
	return new Date(targetDt.toZonedDateTime('UTC').toInstant().epochMilliseconds);
}

/**
 * Construct a Temporal.PlainDate from an ISO year, week number, and day-of-week.
 *
 * ISO 8601: week 1 contains January 4th. Day 1 = Monday.
 */
function isoWeekDate(isoYear: number, week: number, dayOfWeek: number): Temporal.PlainDate {
	// January 4 is always in ISO week 1
	const jan4 = Temporal.PlainDate.from({ year: isoYear, month: 1, day: 4 });
	// Monday of week 1
	const week1Monday = jan4.subtract({ days: jan4.dayOfWeek - 1 });
	// Target date
	return week1Monday.add({ days: (week - 1) * 7 + (dayOfWeek - 1) });
}

/**
 * Negate an offset string: "-1y" → "1y", "7d" → "-7d", "-1yw" → "1yw".
 */
export function negateOffset(s: string): string {
	if (s.startsWith('-')) return s.slice(1);
	return `-${s}`;
}

/**
 * Human-readable label for an offset.
 *   "-1y"  → "1 year ago"
 *   "-1yw" → "1 year ago (week-aligned)"
 *   "7d"   → "7 days later"
 */
export function formatOffsetLabel(s: string): string {
	// ISO-week-aligned year
	const isoMatch = s.match(/^(-?\d+)yw$/);
	if (isoMatch) {
		const value = parseInt(isoMatch[1], 10);
		const absValue = Math.abs(value);
		const name = absValue === 1 ? 'year' : 'years';
		const direction = value < 0 ? 'ago' : 'later';
		return `${absValue} ${name} ${direction} (week-aligned)`;
	}

	const match = s.match(/^(-?\d+)(y|mo|w|d)$/);
	if (!match) return s;

	const value = parseInt(match[1], 10);
	const absValue = Math.abs(value);
	const unit = match[2];

	const unitNames: Record<string, [string, string]> = {
		y: ['year', 'years'],
		mo: ['month', 'months'],
		w: ['week', 'weeks'],
		d: ['day', 'days']
	};

	const [singular, plural] = unitNames[unit] ?? [unit, unit];
	const name = absValue === 1 ? singular : plural;
	const direction = value < 0 ? 'ago' : 'later';

	return `${absValue} ${name} ${direction}`;
}
