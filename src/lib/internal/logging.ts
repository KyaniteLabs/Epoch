export function debugLog(scope: string, err: unknown): void {
  if (process.env["EPOCH_DEBUG"] !== "1") return;
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[epoch:${scope}] ${message}\n`);
}
