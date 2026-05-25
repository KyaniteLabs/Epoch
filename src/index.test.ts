import { describe, expect, it } from "vitest";

describe("public package entrypoint", () => {
  it("exports stable runtime APIs without starting a server", async () => {
    const mod = await import("./index.js");

    expect(typeof mod.pertEstimate).toBe("function");
    expect(typeof mod.referenceClassEstimate).toBe("function");
    expect(typeof mod.submitTelemetry).toBe("function");
  }, 15_000);
});
