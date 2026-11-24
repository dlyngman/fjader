/**
 * A date for display in a tooltip or readout, in UTC, at the precision the
 * value has: the day (`Mar 1, 2024`), with the time when it is not midnight
 * (`Mar 1, 2024, 08:30`), and the seconds when they are not zero. Never drops
 * detail the value holds.
 */
export function formatDate(date: Date): string {
	if (date.getUTCSeconds() !== 0) return dateTimeSec.format(date);
	if (date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0) return dateTime.format(date);
	return dateOnly.format(date);
}

// Created once and reused: an Intl formatter is costly to build.
const dateOnly = new Intl.DateTimeFormat(undefined, {
	year: 'numeric',
	month: 'short',
	day: 'numeric',
	timeZone: 'UTC'
});
const dateTime = new Intl.DateTimeFormat(undefined, {
	year: 'numeric',
	month: 'short',
	day: 'numeric',
	hour: '2-digit',
	minute: '2-digit',
	timeZone: 'UTC'
});
const dateTimeSec = new Intl.DateTimeFormat(undefined, {
	year: 'numeric',
	month: 'short',
	day: 'numeric',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	timeZone: 'UTC'
});
