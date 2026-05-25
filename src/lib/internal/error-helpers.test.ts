// ---------------------------------------------------------------------------
// Tests for src/lib/internal/error-helpers.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { makeError } from "./error-helpers.js";

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
});
