// ============================================================================
// Estimate lifecycle — the one named state machine for a ledger estimate.
// ============================================================================
//
// The stage is DERIVED, never persisted: the ledger stores only the estimate
// row's `expiresAt` (minted by recordEstimate) and the existence of an actual
// row whose `estimateId` points at it. Every reader that needs to know
// "is this estimate still pending?" asks this module instead of re-deriving
// it from `expiresAt` / actual-presence on its own.
//
//                 record_actual
//     PENDING ───────────────────────▶ RECORDED   (terminal: a second
//        │                                ▲         record_actual is refused
//        │ TTL elapses                    │         as "duplicate")
//        ▼              record_actual     │
//     EXPIRED ────────────────────────────┘        (late actuals are accepted)
//
// Expiry boundary: an estimate is EXPIRED from the instant `now >= expiresAt`.
// A missing or unparseable `expiresAt` (legacy rows minted before the TTL
// existed) never expires.

/** Every estimate stage, in lifecycle order. Exhaustive — tests iterate it. */
export const ESTIMATE_STAGES = ["pending", "expired", "recorded"] as const;
export type EstimateStage = (typeof ESTIMATE_STAGES)[number];

/** The only transition a writer performs on an estimate's lifecycle. */
export type EstimateTransition = "record_actual";

/** Legal `record_actual` sources. RECORDED is terminal. */
const RECORD_ACTUAL_FROM: ReadonlySet<EstimateStage> = new Set<EstimateStage>(["pending", "expired"]);

/**
 * True once the pending-estimate TTL has elapsed. The single expiry predicate:
 * exclusion (ttl_expired), pending listings, dedup reuse and the dashboard all
 * route through here so they can never disagree about the boundary instant.
 */
export function isPastExpiry(expiresAt: string | undefined, now: Date | number = Date.now()): boolean {
  if (!expiresAt) return false;
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return false;
  const nowMs = typeof now === "number" ? now : now.getTime();
  return expiresMs <= nowMs;
}

/** Derive an estimate's stage from what the ledger actually stores. */
export function estimateStage(
  estimate: { readonly expiresAt?: string | undefined },
  hasActual: boolean,
  now: Date | number = Date.now(),
): EstimateStage {
  if (hasActual) return "recorded";
  return isPastExpiry(estimate.expiresAt, now) ? "expired" : "pending";
}

/**
 * Guard for the record_actual transition. Both the single-entry and the batch
 * write paths call this inside their write lock, so the "duplicate" rejection
 * is decided in exactly one place.
 */
export function checkRecordActual(stage: EstimateStage): { ok: true } | { ok: false; reason: "duplicate" } {
  return RECORD_ACTUAL_FROM.has(stage) ? { ok: true } : { ok: false, reason: "duplicate" };
}
