// ---------------------------------------------------------------------------
// Tests for src/lib/internal/error-helpers.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { ZodError } from "zod";
import { z } from "zod";
import {
	makeError,
	makeInternalError,
	makeValidationError,
	isInternalError,
	formatZodIssues,
} from "./error-helpers.js";

describe("error-helpers", () => {
	describe("makeError", () => {
		it("creates a ToolError with isError=true", () => {
			const err = makeError("something went wrong");
			expect(err.isError).toBe(true);
			expect(err.message).toBe("something went wrong");
		});

		it("includes retryHint when provided", () => {
			const err = makeError("validation failed", "Check your inputs and retry");
			expect(err.retryHint).toBe("Check your inputs and retry");
		});

		it("omits retryHint when not provided", () => {
			const err = makeError("fatal error");
			expect(err.retryHint).toBeUndefined();
		});
	});

	describe("error classification (ticket 06)", () => {
		it("makeValidationError tags the error as caller-fixable", () => {
			const err = makeValidationError("tokens: must be greater than 0", "Fix the field and retry.");
			expect(err.isError).toBe(true);
			expect(err.errorKind).toBe("validation");
			expect(isInternalError(err)).toBe(false);
		});

		it("makeInternalError tags the error as internal and isInternalError recognizes it", () => {
			const err = makeInternalError("EACCES: permission denied", "Try again later.");
			expect(err.isError).toBe(true);
			expect(err.errorKind).toBe("internal");
			expect(isInternalError(err)).toBe(true);
		});

		it("isInternalError is false for plain ToolErrors (backward-compatible)", () => {
			expect(isInternalError(makeError("Unknown tool: x."))).toBe(false);
		});
	});

	describe("formatZodIssues (ticket 06)", () => {
		const capture = (schema: z.ZodType, input: unknown): ZodError => {
			const result = schema.safeParse(input);
			if (result.success) throw new Error("expected parse failure");
			return result.error;
		};

		it("renders an exclusive numeric bound as 'must be greater than' with the rejected value", () => {
			const err = capture(z.object({ tokens: z.number().positive() }), { tokens: 0 });
			expect(formatZodIssues(err, { tokens: 0 })).toBe("tokens: must be greater than 0 — got 0");
		});

		it("renders an inclusive numeric bound as 'must be at least'", () => {
			const err = capture(z.object({ n: z.number().min(3) }), { n: 1 });
			expect(formatZodIssues(err, { n: 1 })).toBe("n: must be at least 3 — got 1");
		});

		it("renders upper bounds as 'must be at most'", () => {
			const err = capture(z.object({ n: z.number().max(10) }), { n: 42 });
			expect(formatZodIssues(err, { n: 42 })).toBe("n: must be at most 10 — got 42");
		});

		it("keeps custom schema messages instead of zod's default phrasing", () => {
			const err = capture(
				z.object({ days: z.number().max(100, { error: "days must be <= 100. Split the call." }) }),
				{ days: 1000 },
			);
			expect(formatZodIssues(err, { days: 1000 })).toBe(
				"days: days must be <= 100. Split the call. — got 1000",
			);
		});

		it("renders array bounds as item counts and string bounds as lengths", () => {
			const arrErr = capture(z.object({ items: z.array(z.string()).min(1) }), { items: [] });
			expect(formatZodIssues(arrErr, { items: [] })).toBe("items: must contain at least 1 item");

			const strErr = capture(z.object({ name: z.string().min(1) }), { name: "" });
			expect(formatZodIssues(strErr, { name: "" })).toBe('name: must be at least 1 character long — got ""');
		});

		it("digs nested array paths and one line per issue", () => {
			const schema = z.object({
				entries: z.array(z.object({ id: z.string().min(1), hours: z.number().positive() })),
			});
			const err = capture(schema, { entries: [{ id: "", hours: -1 }] });
			expect(formatZodIssues(err, { entries: [{ id: "", hours: -1 }] }).split("\n")).toEqual([
				'entries.0.id: must be at least 1 character long — got ""',
				"entries.0.hours: must be greater than 0 — got -1",
			]);
		});

		it("falls back to zod's message for non-bound issues and appends the rejected value", () => {
			const err = capture(z.object({ name: z.string() }), { name: 42 });
			expect(formatZodIssues(err, { name: 42 })).toBe(
				"name: Invalid input: expected string, received number — got 42",
			);
		});

		it("emits no '— got' suffix when no rawInput is available", () => {
			const err = capture(z.object({ tokens: z.number().positive() }), { tokens: 0 });
			expect(formatZodIssues(err)).toBe("tokens: must be greater than 0");
		});

		it("truncates long string values so one bad input cannot flood the message", () => {
			const long = "x".repeat(500);
			const err = capture(z.object({ name: z.string() }), { name: 1 });
			const rendered = formatZodIssues(err, { name: long });
			expect(rendered.length).toBeLessThan(150);
			expect(rendered).not.toContain("x".repeat(70));
		});

		it("never returns an empty string", () => {
			// Duck-typed error with zero issues (ZodError.issues is readonly,
			// so the empty case is constructed directly).
			expect(formatZodIssues({ issues: [] })).toBe("Invalid input.");
		});
	});
});
