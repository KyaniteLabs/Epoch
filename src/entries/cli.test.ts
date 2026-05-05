// ---------------------------------------------------------------------------
// Epoch CLI Entry Point — Tests
// Commander.js program construction, command registration, argument parsing,
// tool dispatch, and output formatting.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { Command } from "commander";
import { createCliProgram } from "./cli.js";
import { dispatch } from "../dispatcher/index.js";

// ---- Sentinel error for process.exit mock -----------------------------------

/** Sentinel error thrown by the mocked process.exit to halt execution. */
class ExitCalled extends Error {
  readonly exitCode: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.exitCode = code;
  }
}

// Suppress unhandled rejections from ExitCalled throws that escape async
// Commander action handlers (detached promises). Install before all tests.
const rejectionListener = (reason: unknown) => {
  if (reason instanceof ExitCalled) return; // expected — swallow
};

// ---- Mocks ------------------------------------------------------------------

vi.mock("../dispatcher/index.js", () => ({
  dispatch: vi.fn(),
  listTools: vi.fn(() => [
    { name: "pert_estimate", description: "PERT estimate" },
    { name: "get_current_time", description: "Current time" },
  ]),
}));

vi.mock("../version.js", () => ({
  getVersion: () => "0.1.2-test",
}));

// ---- Helpers ----------------------------------------------------------------

/** Captured writes to stdout/stderr and exit codes. */
interface Capture {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

/**
 * Run a Commander program with the given user-facing args and capture output.
 *
 * @param argv - Arguments *after* the program name (e.g. ["get-current-time", "--timezone", "UTC"])
 */
async function runWithCapture(
  program: Command,
  argv: string[],
): Promise<Capture> {
  const capture: Capture = { stdout: [], stderr: [], exitCode: null };

  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const origExit = process.exit;

  process.stdout.write = ((chunk: unknown) => {
    if (typeof chunk === "string") capture.stdout.push(chunk);
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    if (typeof chunk === "string") capture.stderr.push(chunk);
    return true;
  }) as typeof process.stderr.write;

  // Throw a sentinel so execution halts — same behavior as real process.exit.
  process.exit = ((code?: number) => {
    const c = code ?? 0;
    capture.exitCode = c;
    throw new ExitCalled(c);
  }) as typeof process.exit;

  try {
    program.parse(argv, { from: "user" });
    // Flush microtask queue for async actions that call process.exit.
    await new Promise((resolve) => setTimeout(resolve, 200));
  } catch (e: unknown) {
    // Swallow ExitCalled — the exit code is captured above.
    if (!(e instanceof ExitCalled)) {
      throw e;
    }
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  }

  return capture;
}

/** Configure dispatch mock to return a successful result. */
function mockDispatchSuccess(data: Record<string, unknown>): void {
  (dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    data,
  });
}

/** Configure dispatch mock to return an error result. */
function mockDispatchError(
  message: string,
  isError = true,
): void {
  (dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: false,
    error: { isError, message },
  });
}

// ---- Tests ------------------------------------------------------------------

describe("CLI tests", () => {
  beforeAll(() => {
    process.on("unhandledRejection", rejectionListener);
  });

  afterAll(() => {
    process.off("unhandledRejection", rejectionListener);
  });

  describe("createCliProgram", () => {
    it("returns a Commander instance", () => {
      const program = createCliProgram();
      expect(program).toBeInstanceOf(Command);
    });

    it("sets program name to 'epoch'", () => {
      const program = createCliProgram();
      expect(program.name()).toBe("epoch");
    });

    it("sets description", () => {
      const program = createCliProgram();
      expect(program.description()).toBe("Time Estimation CLI");
    });

    it("registers --format option with json/table choices", () => {
      const program = createCliProgram();
      const formatOption = program.options.find((o) => o.long === "--format");
      expect(formatOption).toBeDefined();
      expect(formatOption!.argChoices).toEqual(["json", "table"]);
    });

    it("registers --pretty option", () => {
      const program = createCliProgram();
      const prettyOption = program.options.find((o) => o.long === "--pretty");
      expect(prettyOption).toBeDefined();
    });

    it("registers --quiet option", () => {
      const program = createCliProgram();
      const quietOption = program.options.find((o) => o.long === "--quiet");
      expect(quietOption).toBeDefined();
    });
  });

  describe("CLI command registration", () => {
    const EXPECTED_COMMANDS = [
      "get-current-time",
      "convert-timezone",
      "parse-duration",
      "time-math",
      "add-business-days",
      "count-business-days",
      "pert-estimate",
      "cocomo-estimate",
      "sprint-forecast",
      "critical-path",
      "monte-carlo-schedule",
      "reference-class-estimate",
      "calibrate-estimates",
      "token-time-bridge",
      "token-cost-estimate",
      "compare-models",
      "accuracy-trend",
      "schedule-risk",
      "cocomo-validate",
      "record-actual",
      "get-pending-estimates",
      "batch-record-actuals",
      "feedback-health",
      "cocomo-ground-truth",
      "list-tools",
      "self-improve",
      "telemetry",
      "share-data",
    ];

    it("registers all expected commands", () => {
      const program = createCliProgram();
      const commandNames = program.commands.map((c) => c.name());
      for (const name of EXPECTED_COMMANDS) {
        expect(commandNames).toContain(name);
      }
      expect(program.commands).toHaveLength(EXPECTED_COMMANDS.length);
    });

    it("every command has a non-empty description", () => {
      const program = createCliProgram();
      for (const cmd of program.commands) {
        expect(cmd.description().length).toBeGreaterThan(0);
      }
    });

    it("get-current-time has --timezone optional argument defaulting to UTC", () => {
      const program = createCliProgram();
      const cmd = program.commands.find((c) => c.name() === "get-current-time")!;
      const tzOption = cmd.options.find((o) => o.long === "--timezone");
      expect(tzOption).toBeDefined();
      expect(tzOption!.defaultValue).toBe("UTC");
    });

    it("convert-timezone has required --timestamp and --target-tz", () => {
      const program = createCliProgram();
      const cmd = program.commands.find((c) => c.name() === "convert-timezone")!;
      const requiredFlags = cmd.options
        .filter((o) => o.required)
        .map((o) => o.long);
      expect(requiredFlags).toContain("--timestamp");
      expect(requiredFlags).toContain("--target-tz");
    });

    it("pert-estimate has required --optimistic, --most-likely, --pessimistic", () => {
      const program = createCliProgram();
      const cmd = program.commands.find((c) => c.name() === "pert-estimate")!;
      const requiredFlags = cmd.options
        .filter((o) => o.required)
        .map((o) => o.long);
      expect(requiredFlags).toContain("--optimistic");
      expect(requiredFlags).toContain("--most-likely");
      expect(requiredFlags).toContain("--pessimistic");
    });

    it("critical-path has required --tasks argument", () => {
      const program = createCliProgram();
      const cmd = program.commands.find((c) => c.name() === "critical-path")!;
      const requiredFlags = cmd.options
        .filter((o) => o.required)
        .map((o) => o.long);
      expect(requiredFlags).toContain("--tasks");
    });
  });

  describe("CLI tool execution", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("get-current-time dispatches with timezone from flag", async () => {
      mockDispatchSuccess({ iso: "2026-01-01T00:00:00Z", timezone: "UTC" });
      const program = createCliProgram();
      const capture = await runWithCapture(program, [
        "get-current-time",
        "--timezone",
        "America/New_York",
      ]);

      expect(dispatch).toHaveBeenCalledWith("get_current_time", {
        timezone: "America/New_York",
      });
      expect(capture.exitCode).toBe(0);
    });

    it("pert-estimate dispatches with parsed numeric args", async () => {
      mockDispatchSuccess({
        expected: 5,
        stdDeviation: 1.67,
        unit: "hours",
      });
      const program = createCliProgram();
      const capture = await runWithCapture(program, [
        "pert-estimate",
        "--optimistic",
        "2",
        "--most-likely",
        "4",
        "--pessimistic",
        "12",
      ]);

      expect(dispatch).toHaveBeenCalledWith("pert_estimate", {
        optimistic: 2,
        most_likely: 4,
        pessimistic: 12,
        unit: "hours",
      });
      expect(capture.exitCode).toBe(0);
    });

    it("dispatches convert-timezone with correct arg mapping", async () => {
      mockDispatchSuccess({ iso: "2026-01-01T05:00:00Z" });
      const program = createCliProgram();
      await runWithCapture(program, [
        "convert-timezone",
        "--timestamp",
        "2026-01-01T00:00:00-05:00",
        "--target-tz",
        "UTC",
      ]);

      expect(dispatch).toHaveBeenCalledWith("convert_timezone", {
        timestamp: "2026-01-01T00:00:00-05:00",
        target_tz: "UTC",
      });
    });

    it("dispatches parse-duration with duration_string", async () => {
      mockDispatchSuccess({ totalSeconds: 9000 });
      const program = createCliProgram();
      await runWithCapture(program, [
        "parse-duration",
        "--duration",
        "2h30m",
      ]);

      expect(dispatch).toHaveBeenCalledWith("parse_duration", {
        duration_string: "2h30m",
      });
    });

    it("dispatches time-math with operation and operands", async () => {
      mockDispatchSuccess({ days: 5 });
      const program = createCliProgram();
      await runWithCapture(program, [
        "time-math",
        "--operation",
        "add_days",
        "--date",
        "2026-01-01",
        "--days",
        "5",
      ]);

      expect(dispatch).toHaveBeenCalledWith(
        "time_math",
        expect.objectContaining({
          operation: "add_days",
          operands: expect.objectContaining({ date: "2026-01-01", days: 5 }),
        }),
      );
    });

    it("dispatches add-business-days with correct field mapping", async () => {
      mockDispatchSuccess({ endDate: "2026-05-08", businessDays: 5 });
      const program = createCliProgram();
      await runWithCapture(program, [
        "add-business-days",
        "--start-date",
        "2026-05-01",
        "--days",
        "5",
      ]);

      expect(dispatch).toHaveBeenCalledWith("add_business_days", {
        start_date: "2026-05-01",
        days: 5,
        country: "US",
      });
    });

    it("exits with code 2 when dispatch returns isError", async () => {
      mockDispatchError("Something went wrong", true);
      const program = createCliProgram();
      const capture = await runWithCapture(program, [
        "get-current-time",
      ]);

      expect(capture.exitCode).toBe(2);
    });

    it("exits with code 1 when dispatch returns non-isError failure", async () => {
      mockDispatchError("Validation failed", false);
      const program = createCliProgram();
      const capture = await runWithCapture(program, [
        "get-current-time",
      ]);

      expect(capture.exitCode).toBe(1);
    });
  });

  describe("CLI output formatting", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("default format outputs valid JSON to stdout", async () => {
      mockDispatchSuccess({ iso: "2026-01-01T00:00:00Z" });
      const program = createCliProgram();
      const capture = await runWithCapture(program, [
        "get-current-time",
      ]);

      const output = capture.stdout.join("").trim();
      expect(() => JSON.parse(output)).not.toThrow();
      const parsed = JSON.parse(output) as { ok: boolean; data: unknown };
      expect(parsed.ok).toBe(true);
    });

    it("--pretty flag triggers table output format", async () => {
      mockDispatchSuccess({ iso: "2026-01-01T00:00:00Z", timezone: "UTC" });
      const program = createCliProgram();
      const capture = await runWithCapture(program, [
        "--pretty",
        "get-current-time",
      ]);

      const output = capture.stdout.join("");
      expect(output).toContain("get_current_time");
    });

    it("--format table produces table output", async () => {
      mockDispatchSuccess({ expected: 5, unit: "hours" });
      const program = createCliProgram();
      const capture = await runWithCapture(program, [
        "--format",
        "table",
        "pert-estimate",
        "--optimistic",
        "2",
        "--most-likely",
        "4",
        "--pessimistic",
        "12",
      ]);

      const output = capture.stdout.join("");
      expect(output).toContain("pert_estimate");
    });

    it("--quiet suppresses table output", async () => {
      mockDispatchSuccess({ expected: 5 });
      const program = createCliProgram();
      const capture = await runWithCapture(program, [
        "--quiet",
        "--format",
        "table",
        "pert-estimate",
        "--optimistic",
        "2",
        "--most-likely",
        "4",
        "--pessimistic",
        "12",
      ]);

      expect(capture.stdout.join("")).toBe("");
    });
  });

  describe("CLI error handling", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("critical-path --tasks rejects invalid JSON", async () => {
      const program = createCliProgram();
      const capture = await runWithCapture(program, [
        "critical-path",
        "--tasks",
        "not-json",
      ]);

      expect(capture.stderr.join("")).toContain("--tasks must be valid JSON");
      expect(capture.exitCode).toBe(1);
    });

    it("critical-path --tasks accepts valid JSON array", async () => {
      mockDispatchSuccess({ critical_path: [], total_duration: 0 });
      const program = createCliProgram();
      const capture = await runWithCapture(program, [
        "critical-path",
        "--tasks",
        '[{"name":"a","duration":5,"predecessors":[]}]',
      ]);

      expect(dispatch).toHaveBeenCalledWith(
        "critical_path",
        expect.objectContaining({
          tasks: [{ name: "a", duration: 5, predecessors: [] }],
        }),
      );
      expect(capture.exitCode).toBe(0);
    });

    it("sprint-forecast --velocity-history rejects non-numeric value", async () => {
      const program = createCliProgram();
      const capture = await runWithCapture(program, [
        "sprint-forecast",
        "--backlog-points",
        "100",
        "--velocity-history",
        "10,abc,20",
      ]);

      expect(capture.stderr.join("")).toContain("non-numeric value");
      expect(capture.exitCode).toBe(1);
    });
  });

  describe("CLI cocomo-estimate optional args", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("sends only kloc when no optional multipliers provided", async () => {
      mockDispatchSuccess({ kloc: 10 });
      const program = createCliProgram();
      await runWithCapture(program, [
        "cocomo-estimate",
        "--kloc",
        "10",
      ]);

      expect(dispatch).toHaveBeenCalledWith(
        "cocomo_estimate",
        expect.objectContaining({ kloc: 10 }),
      );
      // Should NOT contain optional multipliers
      const callArgs = (dispatch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty("reasoning_complexity");
      expect(callArgs).not.toHaveProperty("context_completeness");
    });

    it("sends optional multipliers when provided", async () => {
      mockDispatchSuccess({ kloc: 10 });
      const program = createCliProgram();
      await runWithCapture(program, [
        "cocomo-estimate",
        "--kloc",
        "10",
        "--reasoning-complexity",
        "1.5",
        "--human-oversight",
        "0.8",
      ]);

      expect(dispatch).toHaveBeenCalledWith(
        "cocomo_estimate",
        expect.objectContaining({
          kloc: 10,
          reasoning_complexity: 1.5,
          human_oversight: 0.8,
        }),
      );
    });
  });

  describe("CLI list-tools command", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("outputs JSON array of tools", async () => {
      const program = createCliProgram();
      const capture = await runWithCapture(program, [
        "list-tools",
      ]);

      const output = capture.stdout.join("").trim();
      expect(() => JSON.parse(output)).not.toThrow();
      const tools = JSON.parse(output) as Array<{ name: string; description: string }>;
      expect(tools.length).toBeGreaterThan(0);
      expect(capture.exitCode).toBe(0);
    });
  });
});
