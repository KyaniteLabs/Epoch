import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/**
 * Read the `version` field of the package.json sitting `relativeDepth`
 * directories above `fromUrl` (defaults to this module's own URL).
 *
 * Resolution is based on `import.meta.url` — available on every supported
 * Node (>= 22) — instead of `import.meta.dirname`, which only exists on
 * Node >= 20.11 and made `join(undefined, ...)` throw (silently degrading
 * to a placeholder version) on Node 20.0–20.10.
 *
 * One hop up is layout-stable for this module:
 * - src (tsx dev): this file is `<root>/src/version.ts` -> `<root>/package.json`
 * - dist (tsup inlines this module into `<root>/dist/index.js`) -> `<root>/package.json`
 *
 * Throws when the package.json cannot be read or parsed, or has no usable
 * `version` field. Callers must never substitute a placeholder like "0.0.0"
 * or "unknown" — a missing version is a bug worth failing loudly on.
 */
export function readPackageVersion(
  relativeDepth: number,
  fromUrl: string | URL = import.meta.url,
): string {
  const hops = "../".repeat(Math.max(0, relativeDepth));
  const packageUrl = new URL(`${hops}package.json`, fromUrl);
  const parsed = JSON.parse(
    readFileSync(fileURLToPath(packageUrl), "utf-8"),
  ) as { version?: unknown };

  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`package.json at ${packageUrl.href} has no version field`);
  }
  return parsed.version;
}

export function getVersion(): string {
  cached ??= readPackageVersion(1);
  return cached;
}
