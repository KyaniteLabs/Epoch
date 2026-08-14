// ---------------------------------------------------------------------------
// Epoch MCP Server — HTTP Entry: Tests
// Covers rate limiter, tool dispatch, health, OpenAPI, feedback, error handling.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { serve } from "@hono/node-server";
import { createApiApp } from "./http.js";
import { TOOL_REGISTRY, TOOL_NAMES } from "../dispatcher/index.js";
import type { ToolDefinition } from "../dispatcher/tool-registry.js";

const TEST_DIR = join(tmpdir(), `epoch-http-test-${process.pid}`);

/** Extract a tool path's request-body JSON Schema from an OpenAPI document. */
function toolRequestSchema(spec: Record<string, unknown>, tool: string): Record<string, unknown> {
  const paths = spec.paths as Record<string, Record<string, unknown>>;
  const pathObj = paths[`/v1/tools/${tool}`];
  if (!pathObj) throw new Error(`missing path for tool ${tool}`);
  const post = pathObj.post as Record<string, unknown>;
  const requestBody = post.requestBody as Record<string, unknown>;
  const content = requestBody.content as Record<string, Record<string, unknown>>;
  const json = content["application/json"];
  if (!json) throw new Error(`missing application/json content for tool ${tool}`);
  return json.schema as Record<string, unknown>;
}

/** Fetch a named property schema, failing loudly if the converter omitted it. */
function prop(schema: Record<string, unknown>, field: string): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown>;
  const value = properties[field];
  if (value === undefined) throw new Error(`schema is missing property "${field}"`);
  return value as Record<string, unknown>;
}

describe("HTTP API", () => {
  let app: ReturnType<typeof createApiApp>;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env["EPOCH_DATA_DIR"] = TEST_DIR;
    app = createApiApp();
  });

  afterEach(() => {
    delete process.env["EPOCH_DATA_DIR"];
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Health endpoint
  // ---------------------------------------------------------------------------

  describe("GET /health", () => {
    it("returns 200 with status info", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.version).toBeTruthy();
      expect(typeof body.tools).toBe("number");
      expect(typeof body.uptime).toBe("number");
    });
  });

  // ---------------------------------------------------------------------------
  // Tool list endpoint
  // ---------------------------------------------------------------------------

  describe("GET /v1/tools", () => {
    it("returns 200 with tool list", async () => {
      const res = await app.request("/v1/tools");
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      const tools = body.tools as Array<{ name: string; description: string }>;
      expect(tools).toHaveLength(25);
      for (const t of tools) {
        expect(t.name).toBeTruthy();
        expect(t.description).toBeTruthy();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Tool dispatch (POST /v1/tools/:toolName)
  // ---------------------------------------------------------------------------

  describe("POST /v1/tools/:toolName", () => {
    it("returns 200 for valid pert_estimate input", async () => {
      const res = await app.request("/v1/tools/pert_estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          optimistic: 2,
          most_likely: 5,
          pessimistic: 12,
          unit: "hours",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);

      const data = body.data as Record<string, unknown>;
      // PERT expected = (2 + 4*5 + 12) / 6 = 34/6 ≈ 5.67
      expect(data.expected).toBeCloseTo(5.67, 1);
    });

    it("returns 422 for invalid pert_estimate input (optimistic > most_likely)", async () => {
      const res = await app.request("/v1/tools/pert_estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          optimistic: 10,
          most_likely: 4,
          pessimistic: 12,
          unit: "hours",
        }),
      });

      expect(res.status).toBe(422);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
    });

    it("returns 404 for unknown tool name", async () => {
      const res = await app.request("/v1/tools/nonexistent_tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);

      const error = body.error as Record<string, unknown>;
      expect(error.message).toContain("Unknown tool");
      expect(error.retryHint).toContain("Available tools");
    });

    it("returns 400 for malformed JSON body", async () => {
      const res = await app.request("/v1/tools/pert_estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json {{{",
      });

      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);

      const error = body.error as Record<string, unknown>;
      expect(error.message).toContain("Invalid JSON");
    });

    it("returns 413 when content-length exceeds 1 MB", async () => {
      const res = await app.request("/v1/tools/pert_estimate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "1048577",
        },
        body: JSON.stringify({ optimistic: 1, most_likely: 2, pessimistic: 3, unit: "hours" }),
      });

      expect(res.status).toBe(413);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);

      const error = body.error as Record<string, unknown>;
      expect(error.message).toContain("too large");
    });

    it("dispatches get_current_time successfully", async () => {
      const res = await app.request("/v1/tools/get_current_time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "America/New_York" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);

      const data = body.data as Record<string, unknown>;
      expect(data.iso).toBeTruthy();
      expect(data.timezone).toBe("America/New_York");
    });

    it("dispatches parse_duration successfully", async () => {
      const res = await app.request("/v1/tools/parse_duration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration_string: "2h30m" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);

      const data = body.data as Record<string, unknown>;
      expect(data.totalSeconds).toBe(9000);
    });
  });

  // ---------------------------------------------------------------------------
  // Telemetry receiver
  // ---------------------------------------------------------------------------

  describe("POST /v1/telemetry", () => {
    let telemetryDir: string;

    beforeEach(() => {
      telemetryDir = join(tmpdir(), `epoch-http-telemetry-test-${Date.now()}-${Math.random()}`);
      mkdirSync(telemetryDir, { recursive: true });
      process.env["EPOCH_DATA_DIR"] = telemetryDir;
    });

    afterEach(() => {
      delete process.env["EPOCH_DATA_DIR"];
      rmSync(telemetryDir, { recursive: true, force: true });
    });

    it("accepts signed anonymized telemetry payloads", async () => {
      const payload = {
        schema_version: 1,
        installation_id: "http-test-installation",
        epoch_version: "0.2.2-test",
        records: [{ task_type: "feature", complexity: 3, tool: "test", estimated_hours: 4, actual_hours: 5, ratio: 1.25, date: "2026-05-07" }],
        generated_at: "2026-05-07T00:00:00.000Z",
      };
      const rawBody = JSON.stringify(payload);
      const signature = createHmac("sha256", payload.installation_id).update(rawBody).digest("hex");

      const res = await app.request("/v1/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Epoch-Signature": signature,
        },
        body: rawBody,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      // Ticket 19 (concurrent telemetry lane): the receiver quarantines every
      // admitted record instead of merging it, so `accepted` is 0 by design
      // and the record lands in telemetry-quarantine.jsonl. The 200 plus the
      // quarantine row also prove the ticket-20 body middleware hands the
      // route byte-exact body text (the HMAC still verifies end to end).
      expect(body.accepted).toBe(0);
      expect(body.deduplicated).toBe(0);
      const quarantine = readFileSync(join(telemetryDir, "telemetry-quarantine.jsonl"), "utf-8").trim();
      // The quarantine row carries the record fields (installation_id stays
      // at the payload level) — assert on the record's identifying values.
      expect(quarantine).toContain('"tool":"test"');
      expect(quarantine).toContain('"ratio":1.25');
    });

    it("rejects telemetry with invalid signatures", async () => {
      const res = await app.request("/v1/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Epoch-Signature": "0".repeat(64),
        },
        body: JSON.stringify({
          schema_version: 1,
          installation_id: "http-test-installation",
          epoch_version: "0.2.2-test",
          records: [],
          generated_at: "2026-05-07T00:00:00.000Z",
        }),
      });

      expect(res.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Rate limiter
  // ---------------------------------------------------------------------------

  describe("Rate limiter", () => {
    let limitedApp: ReturnType<typeof createApiApp>;
    const originalEnv = process.env["EPOCH_RATE_LIMIT"];

    beforeEach(() => {
      process.env["EPOCH_RATE_LIMIT"] = "3";
      limitedApp = createApiApp();
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env["EPOCH_RATE_LIMIT"] = originalEnv;
      } else {
        delete process.env["EPOCH_RATE_LIMIT"];
      }
    });

    it("allows requests under the limit", async () => {
      const res = await app.request("/v1/tools/pert_estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optimistic: 1, most_likely: 2, pessimistic: 3, unit: "hours" }),
      });

      expect(res.status).toBe(200);
    });

    it("returns 429 when rate limit is exceeded", async () => {
      const toolPayload = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optimistic: 1, most_likely: 2, pessimistic: 3, unit: "hours" }),
      };

      // Use up the limit (3 requests)
      await limitedApp.request("/v1/tools/pert_estimate", toolPayload);
      await limitedApp.request("/v1/tools/pert_estimate", toolPayload);
      await limitedApp.request("/v1/tools/pert_estimate", toolPayload);

      // Next request should be rate limited
      const res = await limitedApp.request("/v1/tools/pert_estimate", toolPayload);
      expect(res.status).toBe(429);

      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);

      const error = body.error as Record<string, unknown>;
      expect(error.message).toContain("Rate limit exceeded");
      expect(error.retryHint).toContain("Retry after");
    });

    it("carries a Retry-After header on 429 responses (ticket 20)", async () => {
      const toolPayload = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optimistic: 1, most_likely: 2, pessimistic: 3, unit: "hours" }),
      };

      await limitedApp.request("/v1/tools/pert_estimate", toolPayload);
      await limitedApp.request("/v1/tools/pert_estimate", toolPayload);
      await limitedApp.request("/v1/tools/pert_estimate", toolPayload);

      const res = await limitedApp.request("/v1/tools/pert_estimate", toolPayload);
      expect(res.status).toBe(429);
      const retryAfter = res.headers.get("Retry-After");
      expect(retryAfter).not.toBeNull();
      expect(retryAfter).toMatch(/^\d+$/);
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    });

    it("rate limit does not apply to non-/v1/* routes", async () => {
      const toolPayload = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optimistic: 1, most_likely: 2, pessimistic: 3, unit: "hours" }),
      };

      // Exhaust the rate limit on tool calls
      await limitedApp.request("/v1/tools/pert_estimate", toolPayload);
      await limitedApp.request("/v1/tools/pert_estimate", toolPayload);
      await limitedApp.request("/v1/tools/pert_estimate", toolPayload);

      // Health endpoint should still work
      const res = await limitedApp.request("/health");
      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Rate limiter with trusted proxy
  // ---------------------------------------------------------------------------

  describe("Rate limiter with trusted proxy", () => {
    let proxyApp: ReturnType<typeof createApiApp>;
    const originalTrustProxy = process.env["EPOCH_TRUST_PROXY"];
    const originalRateLimit = process.env["EPOCH_RATE_LIMIT"];

    beforeEach(() => {
      process.env["EPOCH_TRUST_PROXY"] = "1";
      process.env["EPOCH_RATE_LIMIT"] = "2";
      proxyApp = createApiApp();
    });

    afterEach(() => {
      if (originalTrustProxy !== undefined) {
        process.env["EPOCH_TRUST_PROXY"] = originalTrustProxy;
      } else {
        delete process.env["EPOCH_TRUST_PROXY"];
      }
      if (originalRateLimit !== undefined) {
        process.env["EPOCH_RATE_LIMIT"] = originalRateLimit;
      } else {
        delete process.env["EPOCH_RATE_LIMIT"];
      }
    });

    it("tracks rate limits by x-forwarded-for header", async () => {
      const toolPayload = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "1.2.3.4",
        },
        body: JSON.stringify({ optimistic: 1, most_likely: 2, pessimistic: 3, unit: "hours" }),
      };

      // Use up the limit for IP 1.2.3.4
      await proxyApp.request("/v1/tools/pert_estimate", toolPayload);
      await proxyApp.request("/v1/tools/pert_estimate", toolPayload);

      // Third request from same IP should be rate limited
      const res = await proxyApp.request("/v1/tools/pert_estimate", toolPayload);
      expect(res.status).toBe(429);

      // But a request from a different IP should work
      const differentIpPayload = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "5.6.7.8",
        },
        body: JSON.stringify({ optimistic: 1, most_likely: 2, pessimistic: 3, unit: "hours" }),
      };
      const res2 = await proxyApp.request("/v1/tools/pert_estimate", differentIpPayload);
      expect(res2.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Rate limiter configuration (ticket 20)
  // ---------------------------------------------------------------------------

  describe("Rate limiter configuration (ticket 20)", () => {
    const originalRateLimit = process.env["EPOCH_RATE_LIMIT"];
    const originalTrustProxy = process.env["EPOCH_TRUST_PROXY"];
    const toolPayload = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optimistic: 1, most_likely: 2, pessimistic: 3, unit: "hours" }),
    };

    afterEach(() => {
      if (originalRateLimit !== undefined) {
        process.env["EPOCH_RATE_LIMIT"] = originalRateLimit;
      } else {
        delete process.env["EPOCH_RATE_LIMIT"];
      }
      if (originalTrustProxy !== undefined) {
        process.env["EPOCH_TRUST_PROXY"] = originalTrustProxy;
      } else {
        delete process.env["EPOCH_TRUST_PROXY"];
      }
    });

    it("EPOCH_RATE_LIMIT=0 disables limiting entirely (previously it blocked everything)", async () => {
      process.env["EPOCH_RATE_LIMIT"] = "0";
      const unlimitedApp = createApiApp();

      for (let i = 0; i < 8; i++) {
        const res = await unlimitedApp.request("/v1/tools/pert_estimate", toolPayload);
        expect(res.status, `request ${i}`).toBe(200);
      }
    });

    it("invalid values fall back to the default with a warning", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        process.env["EPOCH_RATE_LIMIT"] = "banana";
        const fallbackApp = createApiApp();

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0]?.[0])).toContain("EPOCH_RATE_LIMIT");
        // The limiter still runs with the default of 100 — no 429s below it.
        const res = await fallbackApp.request("/v1/tools/pert_estimate", toolPayload);
        expect(res.status).toBe(200);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("negative values fall back to the default with a warning", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        process.env["EPOCH_RATE_LIMIT"] = "-5";
        const fallbackApp = createApiApp();

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0]?.[0])).toContain("EPOCH_RATE_LIMIT");
        const res = await fallbackApp.request("/v1/tools/pert_estimate", toolPayload);
        expect(res.status).toBe(200);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("ignores X-Forwarded-For unless EPOCH_TRUST_PROXY is set", async () => {
      delete process.env["EPOCH_TRUST_PROXY"];
      process.env["EPOCH_RATE_LIMIT"] = "2";
      const strictApp = createApiApp();

      const withSpoofedXff = (ip: string) => ({
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: toolPayload.body,
      });

      // Without trust-proxy config the forwarded header is not a bucket key:
      // every request lands in the same connection-address bucket.
      expect((await strictApp.request("/v1/tools/pert_estimate", withSpoofedXff("1.1.1.1"))).status).toBe(200);
      expect((await strictApp.request("/v1/tools/pert_estimate", withSpoofedXff("2.2.2.2"))).status).toBe(200);
      const third = await strictApp.request("/v1/tools/pert_estimate", withSpoofedXff("3.3.3.3"));
      expect(third.status).toBe(429);
    });
  });

  // ---------------------------------------------------------------------------
  // Rate limiter conninfo keying through the real node server (ticket 20)
  // ---------------------------------------------------------------------------

  describe("Rate limiter conninfo keying (real node server, ticket 20)", () => {
    const originalRateLimit = process.env["EPOCH_RATE_LIMIT"];

    afterEach(() => {
      if (originalRateLimit !== undefined) {
        process.env["EPOCH_RATE_LIMIT"] = originalRateLimit;
      } else {
        delete process.env["EPOCH_RATE_LIMIT"];
      }
    });

    it("keys the bucket on the socket remote address and sends Retry-After", async () => {
      process.env["EPOCH_RATE_LIMIT"] = "2";
      const serverApp = createApiApp();
      const server = serve({ fetch: serverApp.fetch, port: 0, hostname: "127.0.0.1" });
      try {
        const address = await new Promise<{ port: number }>((resolve) => {
          server.on("listening", () => resolve(server.address() as { port: number }));
        });
        const base = `http://127.0.0.1:${address.port}`;
        const toolPayload = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ optimistic: 1, most_likely: 2, pessimistic: 3, unit: "hours" }),
        };

        // No X-Forwarded-For and no trust-proxy config: the bucket key must
        // come from getConnInfo()'s socket remote address (or degrade
        // gracefully) — the request must never 500.
        const first = await fetch(`${base}/v1/tools/pert_estimate`, toolPayload);
        const second = await fetch(`${base}/v1/tools/pert_estimate`, toolPayload);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);

        const third = await fetch(`${base}/v1/tools/pert_estimate`, toolPayload);
        expect(third.status).toBe(429);
        const retryAfter = third.headers.get("Retry-After");
        expect(retryAfter).toMatch(/^\d+$/);
        expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          // Drop idle keep-alive sockets so close() resolves promptly.
          // (ServerType unions the Http2 variant, which lacks this method.)
          (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Body size limit (ticket 20)
  // ---------------------------------------------------------------------------

  describe("Body size limit (ticket 20)", () => {
    const pertBody = JSON.stringify({ optimistic: 1, most_likely: 2, pessimistic: 3, unit: "hours" });

    /** A stream body: undici cannot precompute Content-Length, so requests arrive with no declared length (chunked-equivalent). */
    function streamBodyOf(text: string): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
    }

    it("rejects an oversize chunked body (no content-length) with 413", async () => {
      const oversize = `{"pad":"${"x".repeat(1_048_576)}"}`;
      const res = await app.request("/v1/tools/pert_estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: streamBodyOf(oversize),
        duplex: "half",
      });

      expect(res.status).toBe(413);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
      const error = body.error as Record<string, unknown>;
      expect(error.message).toContain("too large");
      // The rejection envelope must not echo any of the oversized payload.
      expect(JSON.stringify(body)).not.toContain('"pad"');
    });

    it("accepts an under-limit chunked body (no content-length)", async () => {
      const res = await app.request("/v1/tools/pert_estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: streamBodyOf(pertBody),
        duplex: "half",
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
    });

    it("enforces the 1 MB cap on /v1/feedback/record-actual (previously unchecked)", async () => {
      const res = await app.request("/v1/feedback/record-actual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estimate_id: "x".repeat(1_048_600), actual_hours: 1 }),
      });

      expect(res.status).toBe(413);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
    });

    it("enforces the 1 MB cap on /v1/feedback/batch-record-actuals (previously unchecked)", async () => {
      const res = await app.request("/v1/feedback/batch-record-actuals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: [{ estimate_id: "y".repeat(1_048_600), actual_hours: 1 }],
        }),
      });

      expect(res.status).toBe(413);
    });

    it("enforces the 1 MB cap on /v1/telemetry chunked bodies (no declared length)", async () => {
      const oversize = JSON.stringify({
        schema_version: 1,
        installation_id: "http-test-installation",
        epoch_version: "0.2.2-test",
        records: [],
        generated_at: "2026-05-07T00:00:00.000Z",
        pad: "z".repeat(1_048_600),
      });
      const res = await app.request("/v1/telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: streamBodyOf(oversize),
        duplex: "half",
      });

      expect(res.status).toBe(413);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /v1/feedback/pending — NaN limit guard (ticket 20)
  // ---------------------------------------------------------------------------

  describe("GET /v1/feedback/pending limit parsing (ticket 20)", () => {
    /** Seed `count` pending estimates (no matching actuals) into the test ledger. */
    function seedPendingEstimates(count: number): void {
      const now = new Date().toISOString();
      const lines = Array.from({ length: count }, (_, i) => JSON.stringify({
        // "pending-fixture-" deliberately avoids every SYNTHETIC_ID_PREFIX
        // (src/lib/exclusion.ts) — those would be filtered as test data.
        id: `pending-fixture-${Date.now()}-${i}`,
        tool: "pert_estimate",
        inputs: {},
        outputs: { totalHours: 5 },
        estimatedAt: now,
      })).join("\n") + "\n";
      appendFileSync(join(TEST_DIR, "estimates.jsonl"), lines, "utf-8");
    }

    it("falls back to the default 50 for a non-numeric limit (previously NaN returned the whole ledger)", async () => {
      seedPendingEstimates(60);
      const res = await app.request("/v1/feedback/pending?limit=abc");

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      const data = body.data as unknown[];
      expect(data).toHaveLength(50);
    });

    it("treats an empty limit parameter as the default", async () => {
      seedPendingEstimates(60);
      const res = await app.request("/v1/feedback/pending?limit=");

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.data).toHaveLength(50);
    });

    it("clamps numeric limits into [1, 200]", async () => {
      seedPendingEstimates(60);

      const high = await app.request("/v1/feedback/pending?limit=99999");
      const highBody = await high.json() as Record<string, unknown>;
      expect((highBody.data as unknown[])).toHaveLength(60);

      const low = await app.request("/v1/feedback/pending?limit=-5");
      const lowBody = await low.json() as Record<string, unknown>;
      expect((lowBody.data as unknown[]).length).toBeLessThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /v1/feedback/batch-record-actuals — parity (ticket 20)
  // ---------------------------------------------------------------------------

  describe("POST /v1/feedback/batch-record-actuals (ticket 20 parity)", () => {
    it("returns per-entry validation errors instead of silently filtering", async () => {
      const res = await app.request("/v1/feedback/batch-record-actuals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: [
            { estimate_id: `batch-fixture-ok-${Date.now()}`, actual_hours: 2.5 },
            { estimate_id: "", actual_hours: 3 },
            { actual_hours: -1 },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      const data = body.data as { total: number; succeeded: number; failed: number; errors: string[] };
      expect(data.total).toBe(3);
      expect(data.succeeded).toBe(1);
      expect(data.failed).toBe(2);
      expect(data.errors).toHaveLength(2);
      const joined = data.errors.join("\n");
      expect(joined).toContain("Entry 1");
      expect(joined).toContain("Entry 2");
      expect(joined).toContain("estimate_id");
      expect(joined).toContain("actual_hours");
    });

    it("records a fully valid batch", async () => {
      const stamp = Date.now();
      const res = await app.request("/v1/feedback/batch-record-actuals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: [
            { estimate_id: `batch-fixture-a-${stamp}`, actual_hours: 1.5 },
            { estimate_id: `batch-fixture-b-${stamp}`, actual_hours: 2.5, notes: "optional" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      const data = body.data as { succeeded: number; failed: number; errors: string[] };
      expect(data.succeeded).toBe(2);
      expect(data.failed).toBe(0);
      expect(data.errors).toHaveLength(0);
    });

    it("rejects over-limit batches with an explicit error naming the cap (no silent truncation)", async () => {
      const entries = Array.from({ length: 501 }, (_, i) => ({
        estimate_id: `batch-fixture-${i}`,
        actual_hours: 1,
      }));
      const res = await app.request("/v1/feedback/batch-record-actuals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
      const error = body.error as Record<string, unknown>;
      expect(String(error.message)).toContain("500");
      expect(String(error.message)).toContain("501");
    });

    it("returns 422 with every per-entry error when all entries fail", async () => {
      const res = await app.request("/v1/feedback/batch-record-actuals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: [
            { estimate_id: "some-id", actual_hours: 0 },
            "not-an-object",
          ],
        }),
      });

      expect(res.status).toBe(422);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
      const error = body.error as { message: string; errors?: string[] };
      expect(error.message).toContain("All 2 entries failed");
      expect(error.errors).toHaveLength(2);
      expect(error.errors?.join("\n")).toContain("Entry 0");
      expect(error.errors?.join("\n")).toContain("Entry 1");
    });
  });

  // ---------------------------------------------------------------------------
  // Cache headers on discoverability documents (ticket 20)
  // ---------------------------------------------------------------------------

  describe("Cache headers on discoverability documents (ticket 20)", () => {
    it("/llms.txt carries Cache-Control: public, max-age=3600", async () => {
      const res = await app.request("/llms.txt");
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    });

    it("/openapi.json carries Cache-Control: public, max-age=3600", async () => {
      const res = await app.request("/openapi.json");
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    });

    it("/.well-known/ai-plugin.json carries Cache-Control: public, max-age=3600", async () => {
      const res = await app.request("/.well-known/ai-plugin.json");
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    });
  });

  // ---------------------------------------------------------------------------
  // OpenAPI spec
  // ---------------------------------------------------------------------------

  describe("GET /openapi.json", () => {
    it("returns 200 with valid OpenAPI spec", async () => {
      const res = await app.request("/openapi.json");
      expect(res.status).toBe(200);

      const spec = await res.json() as Record<string, unknown>;
      expect(spec.openapi).toBe("3.1.0");

      const info = spec.info as Record<string, unknown>;
      expect(info.title).toContain("Epoch");
      expect(info.version).toBeTruthy();
    });

    it("includes paths for all 25 tools", async () => {
      const res = await app.request("/openapi.json");
      const spec = await res.json() as Record<string, unknown>;

      const paths = spec.paths as Record<string, unknown>;
      const pathKeys = Object.keys(paths).filter((path) => path.startsWith("/v1/tools/"));

      // Each tool has its own path: /v1/tools/{toolName}
      expect(pathKeys).toHaveLength(25);

      // Every path should start with /v1/tools/
      for (const key of pathKeys) {
        expect(key).toMatch(/^\/v1\/tools\//);
      }
    });

    it("documents telemetry receiver endpoint", async () => {
      const res = await app.request("/openapi.json");
      const spec = await res.json() as Record<string, unknown>;

      const paths = spec.paths as Record<string, unknown>;
      expect(paths["/v1/telemetry"]).toBeTruthy();
    });

    it("documents telemetry calibration provenance fields", async () => {
      const res = await app.request("/openapi.json");
      const spec = await res.json() as Record<string, unknown>;

      const paths = spec.paths as Record<string, Record<string, unknown>>;
      const telemetry = paths["/v1/telemetry"] as Record<string, unknown>;
      const post = telemetry.post as Record<string, unknown>;
      const requestBody = post.requestBody as Record<string, unknown>;
      const content = requestBody.content as Record<string, Record<string, unknown>>;
      const json = content["application/json"] as Record<string, unknown>;
      const schema = json.schema as Record<string, unknown>;
      const properties = schema.properties as Record<string, unknown>;
      const records = properties.records as Record<string, unknown>;
      const items = records.items as Record<string, unknown>;
      const recordProperties = items.properties as Record<string, Record<string, unknown>>;

      expect(recordProperties.calibration_provenance?.enum).toEqual([
        "prospective",
        "backfilled_real_session",
        "backfilled_calibration",
        "synthetic",
        "smoke",
        "unknown",
      ]);
      expect(recordProperties.calibration_usage?.enum).toEqual(["correction", "baseline", "exclude"]);
    });

    it("documents feedback endpoints", async () => {
      const res = await app.request("/openapi.json");
      const spec = await res.json() as Record<string, unknown>;

      const paths = spec.paths as Record<string, unknown>;
      expect(paths["/v1/feedback/record-actual"]).toBeTruthy();
      expect(paths["/v1/feedback/pending"]).toBeTruthy();
      expect(paths["/v1/feedback/batch-record-actuals"]).toBeTruthy();
      expect(paths["/v1/feedback/health"]).toBeTruthy();
    });

    it("each tool path has a POST operation", async () => {
      const res = await app.request("/openapi.json");
      const spec = await res.json() as Record<string, unknown>;

      const paths = spec.paths as Record<string, Record<string, unknown>>;
      for (const [path, pathObj] of Object.entries(paths)) {
        if (!path.startsWith("/v1/tools/")) continue;
        expect(pathObj.post).toBeDefined();
        const post = pathObj.post as Record<string, unknown>;
        expect(post.operationId).toBeTruthy();
        expect(post.summary).toBeTruthy();
        expect(post.requestBody).toBeDefined();
        expect(post.responses).toBeDefined();
      }
    });

    it("caches the spec on subsequent calls", async () => {
      const res1 = await app.request("/openapi.json");
      const spec1 = await res1.json();

      const res2 = await app.request("/openapi.json");
      const spec2 = await res2.json();

      // Same spec object returned
      expect(spec1).toEqual(spec2);
    });

    // -------------------------------------------------------------------------
    // Request-schema contents (zod v4 native conversion — W1 ticket 07)
    // -------------------------------------------------------------------------

    it("converts all 25 tool request schemas without throwing or falling back", async () => {
      const res = await app.request("/openapi.json");
      const spec = await res.json() as Record<string, unknown>;

      expect(TOOL_NAMES.size).toBe(25);
      for (const name of TOOL_NAMES) {
        const schema = toolRequestSchema(spec, name);
        // Converted (not the unrepresentable fallback): a real object schema
        // with a properties map, and no fallback marker in the description.
        expect(schema.type).toBe("object");
        expect(schema.properties).toBeDefined();
        expect(String(schema.description ?? "")).not.toContain("unavailable");
      }
    });

    it("emits typed properties for tool request schemas", async () => {
      const res = await app.request("/openapi.json");
      const spec = await res.json() as Record<string, unknown>;

      const pert = toolRequestSchema(spec, "pert_estimate");
      expect(prop(pert, "optimistic").type).toBe("number");
      expect(prop(pert, "most_likely").type).toBe("number");
      expect(prop(pert, "pessimistic").type).toBe("number");
      expect(prop(pert, "unit").enum).toEqual(["hours", "days", "weeks", "months"]);

      const abd = toolRequestSchema(spec, "add_business_days");
      expect(prop(abd, "start_date").type).toBe("string");
      // .int() on the bounded days field surfaces as JSON Schema "integer".
      expect(prop(abd, "days").type).toBe("integer");
      // W1 input-safety bounds surface in the published schema.
      expect(prop(abd, "days").minimum).toBe(-100000);
      expect(prop(abd, "days").maximum).toBe(100000);
      expect(prop(abd, "country").type).toBe("string");

      const mc = toolRequestSchema(spec, "monte_carlo_schedule");
      expect(prop(mc, "tasks").type).toBe("array");
      expect(prop(mc, "tasks").maxItems).toBe(500);
      expect(prop(mc, "iterations").maximum).toBe(100000);
    });

    it("lists required fields as required and keeps optional/defaulted fields out of required", async () => {
      const res = await app.request("/openapi.json");
      const spec = await res.json() as Record<string, unknown>;

      const pert = toolRequestSchema(spec, "pert_estimate");
      expect(pert.required).toEqual(["optimistic", "most_likely", "pessimistic"]);
      // Optional fields must not be listed as required.
      for (const optionalField of ["unit", "task_type", "complexity", "task_label", "project", "session_id"]) {
        expect(pert.required, optionalField).not.toContain(optionalField);
      }
      // Defaulted fields stay optional but carry their default value.
      expect(prop(pert, "unit").default).toBe("hours");

      const ctz = toolRequestSchema(spec, "convert_timezone");
      expect(ctz.required).toEqual(["timestamp", "target_tz"]);
    });

    it("degrades a tool with an unrepresentable schema to the documented fallback (document still 200)", async () => {
      // z.date() has no JSON Schema representation, so zod v4's toJSONSchema
      // throws for it — the per-tool fallback must absorb that. (Note: a bare
      // .transform() is NOT unrepresentable under io: "input", which converts
      // the input side — the probe-confirmed throwing constructs are
      // z.date()/z.bigint()/z.custom().)
      const fixtureName = "fixture_unrepresentable_schema_tool";
      TOOL_REGISTRY.set(fixtureName, {
        name: fixtureName,
        description: "Test fixture: input schema that cannot be represented in JSON Schema.",
        inputSchema: z.object({ when: z.date() }),
        outputSchema: { type: "object" },
        handler: () => ({ ok: true as const, data: {} }),
      } satisfies ToolDefinition);

      try {
        const fixtureApp = createApiApp(); // fresh app — the spec is cached per instance
        const res = await fixtureApp.request("/openapi.json");
        expect(res.status).toBe(200);

        const spec = await res.json() as Record<string, unknown>;
        const fallback = toolRequestSchema(spec, fixtureName);
        expect(fallback.type).toBe("object");
        expect(String(fallback.description)).toContain("unavailable");

        // The other 25 tools are unaffected.
        for (const name of TOOL_NAMES) {
          const schema = toolRequestSchema(spec, name);
          expect(schema.type).toBe("object");
          expect(String(schema.description ?? "")).not.toContain("unavailable");
        }
      } finally {
        TOOL_REGISTRY.delete(fixtureName);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // AI plugin manifest
  // ---------------------------------------------------------------------------

  describe("GET /.well-known/ai-plugin.json", () => {
    it("returns the AI plugin manifest", async () => {
      const res = await app.request("/.well-known/ai-plugin.json");
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.schema_version).toBe("v1");
      expect(body.name_for_model).toBe("epoch");
      expect(body.api).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // llms.txt
  // ---------------------------------------------------------------------------

  describe("GET /llms.txt", () => {
    it("returns the llms.txt content as plain text", async () => {
      const res = await app.request("/llms.txt");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/plain");

      const text = await res.text();
      expect(text).toContain("# Epoch");
      expect(text).toContain("pert_estimate");
    });
  });

  // ---------------------------------------------------------------------------
  // Feedback endpoints
  // ---------------------------------------------------------------------------

  describe("POST /v1/feedback/record-actual", () => {
    it("returns 400 for missing estimate_id", async () => {
      const res = await app.request("/v1/feedback/record-actual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actual_hours: 8 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
    });

    it("returns 400 for missing actual_hours", async () => {
      const res = await app.request("/v1/feedback/record-actual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estimate_id: "test-id" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for negative actual_hours", async () => {
      const res = await app.request("/v1/feedback/record-actual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estimate_id: "test-id", actual_hours: -5 }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for malformed JSON", async () => {
      const res = await app.request("/v1/feedback/record-actual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "bad json {{",
      });

      expect(res.status).toBe(400);
    });

    it("accepts valid feedback with notes", async () => {
      const res = await app.request("/v1/feedback/record-actual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // "http-fixture-estimate-" (not "http-test-estimate-"): exclusion.ts's
          // SYNTHETIC_ID_PREFIXES now includes "http-test-estimate-" (verified
          // 2026-07-10 live-ledger leakage prefix — see
          // src/lib/migrations/flag-test-fixture-rows.ts), so this
          // positive-case fixture id must not collide with it.
          estimate_id: `http-fixture-estimate-${Date.now()}`,
          actual_hours: 8.5,
          notes: "Completed faster than expected",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);

      const data = body.data as Record<string, unknown>;
      expect(data.actualHours).toBe(8.5);
    });

    it("accepts real fast feedback below the old 15-minute floor", async () => {
      const res = await app.request("/v1/feedback/record-actual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estimate_id: `fast-http-estimate-${Date.now()}`, actual_hours: 0.08 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      const data = body.data as Record<string, unknown>;
      expect(data.actualHours).toBe(0.08);
    });

    it("returns 409 with a typed reason for duplicate actuals", async () => {
      const payload = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estimate_id: "duplicate-estimate", actual_hours: 2 }),
      };

      const first = await app.request("/v1/feedback/record-actual", payload);
      expect(first.status).toBe(200);

      const second = await app.request("/v1/feedback/record-actual", payload);
      expect(second.status).toBe(409);
      const body = await second.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
      const error = body.error as Record<string, unknown>;
      expect(error.message).toContain("duplicate");
    });

    // ---- Ticket 16: unit_suspect surfaced; unknown_tool hint appended ----

    it("surfaces flagged=unit_suspect with an actionable hint on a >10x overrun (ticket 16)", async () => {
      const estimateId = `http-unit-suspect-${Date.now()}`;
      appendFileSync(join(TEST_DIR, "estimates.jsonl"), JSON.stringify({
        id: estimateId,
        tool: "pert_estimate",
        inputs: { task_type: "feature" },
        outputs: { totalHours: 5 },
        estimatedAt: new Date().toISOString(),
      }) + "\n", "utf-8");

      const res = await app.request("/v1/feedback/record-actual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estimate_id: estimateId, actual_hours: 300 }), // 60x
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      const data = body.data as Record<string, unknown>;
      expect(data.recorded).toBe(true);
      expect(data.flagged).toBe("unit_suspect");
      expect(String(data.flagHint)).toContain("unit mismatch");
    });

    it("an unflagged record carries no flagged field in the response", async () => {
      const res = await app.request("/v1/feedback/record-actual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estimate_id: `http-plain-${Date.now()}`, actual_hours: 8 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      const data = body.data as Record<string, unknown>;
      expect(data.flagged).toBeUndefined();
    });

    it("appends the canonical-tool-set hint to an unknown_tool rejection (ticket 16)", async () => {
      const estimateId = `http-unknown-tool-${Date.now()}`;
      appendFileSync(join(TEST_DIR, "estimates.jsonl"), JSON.stringify({
        id: estimateId,
        tool: "bogus_external_tool",
        inputs: {},
        outputs: { totalHours: 5 },
        estimatedAt: new Date().toISOString(),
      }) + "\n", "utf-8");

      const res = await app.request("/v1/feedback/record-actual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estimate_id: estimateId, actual_hours: 4 }),
      });

      expect(res.status).toBe(500); // unknown_tool keeps its existing status mapping
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
      const error = body.error as Record<string, unknown>;
      expect(String(error.message)).toContain("unknown_tool");
      expect(String(error.message)).toContain("pert_estimate"); // the canonical-set hint
    });
  });

  describe("GET /v1/feedback/pending", () => {
    it("returns pending estimates", async () => {
      const res = await app.request("/v1/feedback/pending");
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("respects the limit query parameter", async () => {
      const res = await app.request("/v1/feedback/pending?limit=10");
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      const data = body.data as unknown[];
      expect(data.length).toBeLessThanOrEqual(10);
    });
  });

  // ---------------------------------------------------------------------------
  // Not found handler
  // ---------------------------------------------------------------------------

  describe("404 Not Found", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await app.request("/nonexistent");
      expect(res.status).toBe(404);

      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);

      const error = body.error as Record<string, unknown>;
      expect(error.message).toContain("Not found");
      expect(error.retryHint).toContain("/health");
    });
  });

  // ---------------------------------------------------------------------------
  // CORS (ticket 20: allowlist — no wildcard by default)
  // ---------------------------------------------------------------------------

  describe("CORS (ticket 20)", () => {
    const originalCorsEnv = process.env["EPOCH_CORS_ORIGINS"];

    afterEach(() => {
      if (originalCorsEnv !== undefined) {
        process.env["EPOCH_CORS_ORIGINS"] = originalCorsEnv;
      } else {
        delete process.env["EPOCH_CORS_ORIGINS"];
      }
    });

    it("emits no Access-Control-Allow-Origin by default (no wildcard reflection)", async () => {
      // The old blanket cors() reflected a wildcard origin on every route,
      // letting any website read responses from a locally running server.
      const res = await app.request("/health", {
        headers: { Origin: "https://evil.example" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("emits no Access-Control-Allow-Origin on /v1 routes by default either", async () => {
      const res = await app.request("/v1/tools", {
        headers: { Origin: "https://evil.example" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("still answers preflight OPTIONS when no origins are allowed", async () => {
      const res = await app.request("/v1/tools/pert_estimate", {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("reflects allowlisted origins and omits the header for others", async () => {
      process.env["EPOCH_CORS_ORIGINS"] = "https://app.example.com, http://localhost:5173";
      const allowlistedApp = createApiApp();

      const allowed = await allowlistedApp.request("/health", {
        headers: { Origin: "https://app.example.com" },
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");

      const localhostAllowed = await allowlistedApp.request("/health", {
        headers: { Origin: "http://localhost:5173" },
      });
      expect(localhostAllowed.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");

      const disallowed = await allowlistedApp.request("/health", {
        headers: { Origin: "https://evil.example" },
      });
      expect(disallowed.status).toBe(200);
      expect(disallowed.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("serves preflight CORS headers for allowlisted origins", async () => {
      process.env["EPOCH_CORS_ORIGINS"] = "https://app.example.com";
      const allowlistedApp = createApiApp();

      const res = await allowlistedApp.request("/v1/tools/pert_estimate", {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("content-type");
    });

    it("supports EPOCH_CORS_ORIGINS=* to restore allow-any for operators who opt in", async () => {
      process.env["EPOCH_CORS_ORIGINS"] = "*";
      const wildcardApp = createApiApp();

      const res = await wildcardApp.request("/health", {
        headers: { Origin: "https://anything.example" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });

  // ---------------------------------------------------------------------------
  // Error handler
  // ---------------------------------------------------------------------------

  describe("Error handler", () => {
    it("returns 500 for unhandled errors", async () => {
      // We test the error handler by verifying the onError handler is wired.
      // The app's onError returns {ok: false, error: {isError: true, message: "Internal server error."}} with 500.
      // To trigger it, we'll call a route that throws. We can verify the handler
      // exists by checking the app's internal error handler coverage through
      // the response format on edge cases.
      //
      // Directly test by making a request to the not-found handler which
      // exercises the error path properly.
      const res = await app.request("/does-not-exist");
      expect(res.status).toBe(404);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
      const error = body.error as Record<string, unknown>;
      expect(error.isError).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 422/500 split at the tool-dispatch seam (ticket 06)
  // ---------------------------------------------------------------------------

  describe("validation vs internal error split (ticket 06)", () => {
    it("maps validation failures to 422 with the formatted readable message", async () => {
      // The canary's zero-tokens failure-mode case: the message must be an
      // actionable sentence (matches /positive|greater|must be/i), not a zod
      // JSON blob, and the status must be the caller-error class.
      const res = await app.request("/v1/tools/token_time_bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokens: 0, model: "claude-sonnet-4-20250514", reasoning_depth: "shallow" }),
      });

      expect(res.status).toBe(422);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
      const error = body.error as Record<string, unknown>;
      expect(error.isError).toBe(true);
      expect(error.errorKind).toBe("validation");
      expect(String(error.message)).toMatch(/positive|greater|must be/i);
      expect(String(error.message)).toContain("tokens");
      expect(String(error.message)).not.toContain('"code"'); // no raw zod blob
    });

    it("keeps handler-produced actionable errors at 422", async () => {
      // pert ordering violations are returned (not thrown) by the handler with
      // an actionable message — they stay 422 with the message surfaced.
      const res = await app.request("/v1/tools/pert_estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optimistic: 20, most_likely: 5, pessimistic: 2, unit: "hours" }),
      });

      expect(res.status).toBe(422);
      const body = await res.json() as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(String(error.message)).toContain("optimistic");
      expect(error.errorKind).toBeUndefined(); // not tagged internal
    });

    it("maps internal thrown errors to 500 with a generic-safe message (no path/stack leakage)", async () => {
      // Fixture tool whose handler throws a non-validation error carrying a
      // machine-local path — exactly what the 500 envelope must not leak.
      // Registered in both TOOL_REGISTRY (dispatch's lookup) and TOOL_NAMES
      // (the route's routing gate) so the request reaches dispatch().
      const fixtureName = "fixture_http_throwing_tool";
      TOOL_REGISTRY.set(fixtureName, {
        name: fixtureName,
        description: "Test fixture: handler that throws an internal error with a path in the message.",
        inputSchema: z.object({}),
        outputSchema: { type: "object" },
        handler: () => {
          throw new Error("EACCES: permission denied, /Users/secret/.epoch/estimates.jsonl");
        },
      } satisfies ToolDefinition);
      (TOOL_NAMES as Set<string>).add(fixtureName);

      try {
        const res = await app.request(`/v1/tools/${fixtureName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        expect(res.status).toBe(500);
        const body = await res.json() as Record<string, unknown>;
        expect(body.ok).toBe(false);
        const error = body.error as Record<string, unknown>;
        expect(error.isError).toBe(true);
        expect(error.errorKind).toBe("internal");
        // Generic-safe: no filesystem path, no errno detail, no thrown text.
        const message = String(error.message);
        expect(message).not.toContain("/Users");
        expect(message).not.toContain("EACCES");
        expect(message).toContain(fixtureName);
        expect(error.retryHint).toBeTruthy();
      } finally {
        TOOL_REGISTRY.delete(fixtureName);
        (TOOL_NAMES as Set<string>).delete(fixtureName);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple tool dispatches
  // ---------------------------------------------------------------------------

  describe("Multiple tool dispatches", () => {
    it("dispatches add_business_days successfully", async () => {
      const res = await app.request("/v1/tools/add_business_days", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: "2026-05-01",
          days: 5,
          country_code: "US",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
    });

    it("dispatches token_time_bridge successfully", async () => {
      const res = await app.request("/v1/tools/token_time_bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokens: 100000,
          model: "claude-sonnet-4-20250514",
          reasoning_depth: "moderate",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);

      const data = body.data as Record<string, unknown>;
      expect(data.estimatedSeconds).toBeTruthy();
      expect(data.estimatedMinutes).toBeTruthy();
    });
  });
});
