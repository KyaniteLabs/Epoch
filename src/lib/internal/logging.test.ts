import { afterEach, describe, expect, it, vi } from "vitest";

import { debugLog } from "./logging.js";

afterEach(() => {
  delete process.env["EPOCH_DEBUG"];
  vi.restoreAllMocks();
});

describe("debugLog", () => {
  it("does not write when EPOCH_DEBUG is not enabled", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    debugLog("telemetry.flush", new Error("disk full"));

    expect(write).not.toHaveBeenCalled();
  });

  it("writes scoped debug logs when EPOCH_DEBUG=1", () => {
    process.env["EPOCH_DEBUG"] = "1";
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    debugLog("telemetry.flush", new Error("disk full"));

    expect(write).toHaveBeenCalledWith("[epoch:telemetry.flush] disk full\n");
  });
});
