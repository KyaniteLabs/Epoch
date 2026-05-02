import { readFileSync } from "node:fs";
import { join } from "node:path";

let cached: string | undefined;

export function getVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"),
    ) as { version: string };
    cached = pkg.version;
    return cached;
  } catch {
    return "0.0.0";
  }
}
