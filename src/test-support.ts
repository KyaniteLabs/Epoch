export function defined<T>(value: T, message = "Expected value to be defined"): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value as NonNullable<T>;
}

/**
 * Ticket 18 (write-failure propagation): recordEstimate() returns null when
 * the ledger append failed. Happy-path tests assert the write persisted —
 * narrowing the id back to string for downstream fixtures.
 */
export function assertEstimateWritten(id: string | null): asserts id is string {
  if (id === null) {
    throw new Error("recordEstimate returned null — expected the happy-path write to persist");
  }
}
