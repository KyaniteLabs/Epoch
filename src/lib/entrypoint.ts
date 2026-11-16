import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when `entrypoint` (Node's `process.argv[1]`) names the module at
 * `moduleUrl` (the module's own `import.meta.url`).
 *
 * npm installs the `epoch` bin as a symlink. Node resolves the real file for
 * `import.meta.url` but leaves `process.argv[1]` as the symlink path, so the
 * naive comparison `import.meta.url === pathToFileURL(process.argv[1]).href`
 * is always false for `epoch …` invocations through the bin: the CLI exits 0
 * with no output. Compare real paths instead; when the path cannot be
 * resolved (for example a missing file), fall back to the literal path so the
 * caller still gets a comparison instead of a crash.
 */
export function isCurrentFileEntrypoint(
  entrypoint: string | undefined,
  moduleUrl: string,
): boolean {
  if (!entrypoint) {
    return false;
  }

  try {
    return moduleUrl === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return moduleUrl === pathToFileURL(entrypoint).href;
  }
}
