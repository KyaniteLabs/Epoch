import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/**
 * Read the `version` field of the package.json sitting `relativeDepth`
 * directories above `fromUrl` (defaults to this module's own URL).
 *
 * `relativeDepth` may also be an array of depths to try in order (nearest
 * first) — for modules whose on-disk location differs between layouts
 * (e.g. `src/lib/x.ts` in dev vs. inlined into `dist/*.js` after a tsup
 * bundle): `readPackageVersion([2, 1], import.meta.url)` resolves depth 2
 * from src/lib and falls through to depth 1 from dist.
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
 * Throws when no depth in the chain resolves a readable, parseable
 * package.json with a usable `version` field. Callers must never substitute
 * a placeholder like "0.0.0" or "unknown" — a missing version is a bug
 * worth failing loudly on.
 */
export function readPackageVersion(
  relativeDepth: number | readonly number[],
  fromUrl: string | URL = import.meta.url,
): string {
  const depths =
    typeof relativeDepth === "number" ? [relativeDepth] : [...relativeDepth];
  if (depths.length === 0) {
    throw new Error("readPackageVersion: depth chain must not be empty");
  }
  let lastError: unknown;
  for (const depth of depths) {
    try {
      return readPackageVersionAtDepth(depth, fromUrl);
    } catch (err) {
      lastError ??= err;
    }
  }
  throw lastError;
}

function readPackageVersionAtDepth(
  relativeDepth: number,
  fromUrl: string | URL,
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
