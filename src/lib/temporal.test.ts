import { describe, it, expect } from "vitest";
import {
	getCurrentTime,
	convertTimezone,
	parseDuration,
	formatElapsed,
	addDays,
	diffDates,
} from "./temporal.js";

// ---------------------------------------------------------------------------
// Layer 1: Core Temporal Utilities
// ---------------------------------------------------------------------------

describe("getCurrentTime", () => {
	it("returns the current time in UTC", () => {
		const result = getCurrentTime("UTC");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.timezone).toBe("UTC");
		expect(result.data.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		expect(result.data.utcOffset).toMatch(/^(\+00:00|Z)$/);
		expect(result.data.humanReadable.length).toBeGreaterThan(0);
	});

	it("returns the current time in America/New_York", () => {
		const result = getCurrentTime("America/New_York");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.timezone).toBe("America/New_York");
		expect(result.data.utcOffset).toMatch(/^[+-]\d{2}:\d{2}$/);
	});

	it("returns an error for invalid timezone", () => {
		const result = getCurrentTime("Invalid/Zone");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.isError).toBe(true);
		expect(result.error.message).toContain("Invalid timezone");
	});

	it("returns human-readable format with day of week", () => {
		const result = getCurrentTime("UTC");
		if (!result.ok) return;
		expect(result.data.humanReadable).toMatch(
			/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/,
		);
	});
});

describe("convertTimezone", () => {
	it("converts UTC to America/Los_Angeles", () => {
		const result = convertTimezone(
			"2026-05-01T12:00:00Z",
			"America/Los_Angeles",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.timezone).toBe("America/Los_Angeles");
		// UTC 12:00 → LA 05:00 (PDT, UTC-7)
		expect(result.data.iso).toContain("T05:00:00");
		expect(result.data.utcOffset).toBe("-07:00");
	});

	it("converts UTC to Asia/Tokyo", () => {
		const result = convertTimezone("2026-05-01T00:00:00Z", "Asia/Tokyo");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.iso).toContain("T09:00:00");
		expect(result.data.utcOffset).toBe("+09:00");
	});

	it("returns an error for invalid timestamp", () => {
		const result = convertTimezone("not-a-date", "UTC");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("Invalid timestamp");
	});

	it("returns an error for invalid target timezone", () => {
		const result = convertTimezone("2026-05-01T12:00:00Z", "Mars/Olympus");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("Invalid target timezone");
	});
});

describe("parseDuration", () => {
	it("parses hours and minutes", () => {
		const result = parseDuration("2h30m");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.totalSeconds).toBe(9000); // 2*3600 + 30*60
		expect(result.data.humanReadable).toContain("2 hours");
		expect(result.data.humanReadable).toContain("30 minutes");
	});

	it("parses days and hours", () => {
		const result = parseDuration("1d6h");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.totalSeconds).toBe(108000); // 24*3600 + 6*3600
	});

	it("parses weeks", () => {
		const result = parseDuration("1w");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.totalSeconds).toBe(604800);
	});

	it("parses complex combinations", () => {
		const result = parseDuration("1w2d3h45m");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.totalSeconds).toBe(
			1 * 7 * 86400 + 2 * 86400 + 3 * 3600 + 45 * 60,
		);
	});

	it("parses seconds", () => {
		const result = parseDuration("90s");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.totalSeconds).toBe(90);
	});

	it("parses months", () => {
		const result = parseDuration("3mo");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.totalSeconds).toBeCloseTo(3 * 30.44 * 86400, 0);
	});

	it("returns error for empty string", () => {
		const result = parseDuration("");
		expect(result.ok).toBe(false);
	});

	it("returns error for invalid tokens", () => {
		const result = parseDuration("abc");
		expect(result.ok).toBe(false);
	});

	it("returns error for partial match", () => {
		const result = parseDuration("2hxyz");
		expect(result.ok).toBe(false);
	});
});

describe("formatElapsed", () => {
	it("formats zero milliseconds", () => {
		expect(formatElapsed(0)).toBe("0s");
	});

	it("formats seconds only", () => {
		expect(formatElapsed(45000)).toBe("45s");
	});

	it("formats minutes and seconds", () => {
		expect(formatElapsed(125000)).toBe("2m 5s");
	});

	it("formats hours, minutes, and seconds", () => {
		expect(formatElapsed(3723000)).toBe("1h 2m 3s");
	});

	it("formats days", () => {
		expect(formatElapsed(90061000)).toBe("1d 1h 1m 1s");
	});

	it("clamps negative values to zero", () => {
		expect(formatElapsed(-1000)).toBe("0s");
	});
});

describe("addDays", () => {
	it("adds positive days", () => {
		expect(addDays("2026-05-01", 10)).toBe("2026-05-11");
	});

	it("adds zero days", () => {
		expect(addDays("2026-05-01", 0)).toBe("2026-05-01");
	});

	it("crosses month boundary", () => {
		expect(addDays("2026-01-30", 5)).toBe("2026-02-04");
	});

	it("crosses year boundary", () => {
		expect(addDays("2026-12-28", 5)).toBe("2027-01-02");
	});

	it("returns Invalid Date for invalid input dates", () => {
		expect(addDays("not-a-date", 5)).toBe("Invalid Date");
	});
});

describe("diffDates", () => {
	it("computes positive difference", () => {
		const result = diffDates("2026-05-01T00:00:00Z", "2026-05-03T12:00:00Z");
		expect(result.days).toBe(2);
		expect(result.hours).toBe(12);
		expect(result.total_seconds).toBe(2 * 86400 + 12 * 3600);
	});

	it("computes negative difference when end < start", () => {
		const result = diffDates("2026-05-03", "2026-05-01");
		expect(result.days).toBe(-2);
		expect(result.total_seconds).toBe(-2 * 86400);
	});

	it("returns zero for same date", () => {
		const result = diffDates("2026-05-01T12:00:00Z", "2026-05-01T12:00:00Z");
		expect(result.total_seconds).toBe(0);
	});

	it("computes partial hours", () => {
		const result = diffDates("2026-05-01T10:00:00Z", "2026-05-01T11:30:00Z");
		expect(result.hours).toBe(1);
		expect(result.minutes).toBe(30);
	});
});
