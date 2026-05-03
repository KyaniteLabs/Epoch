import { describe, it, expect } from "vitest";
import { getUrgencyCategory } from "./urgency.js";

describe("getUrgencyCategory", () => {
  it("returns 'short' for under 2 hours", () => {
    expect(getUrgencyCategory(0)).toBe("short");
    expect(getUrgencyCategory(0.5)).toBe("short");
    expect(getUrgencyCategory(1.99)).toBe("short");
  });

  it("returns 'medium' for 2–48 hours", () => {
    expect(getUrgencyCategory(2)).toBe("medium");
    expect(getUrgencyCategory(8)).toBe("medium");
    expect(getUrgencyCategory(24)).toBe("medium");
    expect(getUrgencyCategory(48)).toBe("medium");
  });

  it("returns 'long' for over 48 hours", () => {
    expect(getUrgencyCategory(49)).toBe("long");
    expect(getUrgencyCategory(100)).toBe("long");
    expect(getUrgencyCategory(1000)).toBe("long");
  });

  it("boundary at exactly 2 hours", () => {
    expect(getUrgencyCategory(2)).toBe("medium");
  });

  it("boundary at exactly 48 hours", () => {
    expect(getUrgencyCategory(48)).toBe("medium");
    expect(getUrgencyCategory(48.01)).toBe("long");
  });
});
