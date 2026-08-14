import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getVersion, readPackageVersion } from "./version.js";

// ---------------------------------------------------------------------------
// Version resolver — Tests
// The resolver must report the real package version from both supported
// layouts (src via tsx/vitest, dist via the tsup bundle that inlines this
// module into dist/index.js) and must never fall back to a placeholder.
// ---------------------------------------------------------------------------

const FIXTURE_VERSION = "0.4.0";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "epoch-version-"));
  tempDirs.push(root);
  return root;
}

function writeFixturePackageJson(root: string, version?: string): void {
  const manifest: Record<string, unknown> = {
    name: "@kyanitelabs/epoch-fixture",
    type: "module",
  };
  if (version !== undefined) {
    manifest["version"] = version;
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

describe("readPackageVersion", () => {
  it("resolves the real version from the dist layout (module inlined into dist/index.js)", () => {
    const root = makeFixtureRoot();
    writeFixturePackageJson(root, FIXTURE_VERSION);
    // tsup inlines src/version.ts into dist/index.js, so from the bundled
    // module's point of view its import.meta.url is <root>/dist/index.js and
    // package.json sits one directory up.
    mkdirSync(join(root, "dist"));
    const distIndex = join(root, "dist", "index.js");
    writeFileSync(distIndex, "// simulated tsup bundle\n", "utf-8");

    const resolved = readPackageVersion(1, pathToFileURL(distIndex));

    expect(resolved).toBe(FIXTURE_VERSION);
    expect(resolved).not.toBe("0.0.0");
    expect(resolved).not.toBe("unknown");
  });

  it("resolves the real version from the src layout (src/version.ts one hop below the root)", () => {
    const root = makeFixtureRoot();
    writeFixturePackageJson(root, FIXTURE_VERSION);
    mkdirSync(join(root, "src"));
    const srcModule = join(root, "src", "version.ts");
    writeFileSync(srcModule, "// simulated src module\n", "utf-8");

    const resolved = readPackageVersion(1, pathToFileURL(srcModule));

    expect(resolved).toBe(FIXTURE_VERSION);
    expect(resolved).not.toBe("0.0.0");
    expect(resolved).not.toBe("unknown");
  });

  it("supports deeper relative depths for callers nested further down (e.g. src/lib)", () => {
    const root = makeFixtureRoot();
    writeFixturePackageJson(root, FIXTURE_VERSION);
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    const nested = join(root, "src", "lib", "telemetry-submit.ts");
    writeFileSync(nested, "// simulated nested module\n", "utf-8");

    expect(readPackageVersion(2, pathToFileURL(nested))).toBe(FIXTURE_VERSION);
  });

  it("throws instead of returning a placeholder when package.json is unreachable", () => {
    const root = makeFixtureRoot();
    writeFixturePackageJson(root, FIXTURE_VERSION);
    const moduleUrl = pathToFileURL(join(root, "dist", "index.js"));

    // Depth 5 escapes the fixture root entirely.
    expect(() => readPackageVersion(5, moduleUrl)).toThrow();
  });

  it("throws when the resolved package.json has no version field", () => {
    const root = makeFixtureRoot();
    writeFixturePackageJson(root); // no "version" key
    const moduleUrl = pathToFileURL(join(root, "dist", "index.js"));

    expect(() => readPackageVersion(1, moduleUrl)).toThrow(/has no version/);
  });

  it("throws when the resolved package.json is malformed", () => {
    const root = makeFixtureRoot();
    writeFileSync(join(root, "package.json"), "{ not json", "utf-8");
    const moduleUrl = pathToFileURL(join(root, "dist", "index.js"));

    expect(() => readPackageVersion(1, moduleUrl)).toThrow();
  });
});

describe("getVersion", () => {
  it("returns the repository package version when running from src (vitest/tsx layout)", () => {
    const version = getVersion();

    // getVersion resolves relative to src/version.ts, so under vitest it must
    // find the repository root's package.json and report its real version —
    // never a placeholder.
    const repoUrl = new URL("../package.json", import.meta.url);
    const repoManifest = JSON.parse(
      readFileSync(fileURLToPath(repoUrl), "utf-8"),
    ) as { version: string };

    expect(version).toBe(repoManifest.version);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version).not.toBe("0.0.0");
    expect(version).not.toBe("unknown");
  });
});
