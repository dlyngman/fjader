import { describe, it, expect } from 'vitest';
import { formatDate } from './format-date';

const utc = (s: string) => new Date(`${s}Z`);

describe('formatDate', () => {
	it('shows the day alone at midnight', () => {
		const text = formatDate(utc('2024-03-01T00:00:00'));
		expect(text).toMatch(/2024/);
		expect(text).toMatch(/1/);
		expect(text).not.toMatch(/:/);
	});

	it('adds the time when it is not midnight, without seconds when they are zero', () => {
		const text = formatDate(utc('2024-03-01T08:30:00'));
		expect(text).toMatch(/08:30|8:30/);
		expect(text).not.toMatch(/:\d\d:\d\d/);
	});

	it('adds the seconds when they are not zero', () => {
		expect(formatDate(utc('2024-03-01T08:30:15'))).toMatch(/:30:15/);
	});

	it('formats in UTC, whatever the local time zone', () => {
		// 23:00 UTC is the next day in many zones; the day shown is the UTC one.
		expect(formatDate(utc('2024-03-01T23:00:00'))).toMatch(/\b1\b/);
	});
});
